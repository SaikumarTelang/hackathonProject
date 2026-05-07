const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const auth = require('../middleware/auth');
const Order = require('../models/Order');
const { verifyAndReserveItems, createVerificationReply, restoreReservedItems } = require('../services/orderAgent');
const { startAutoOperatorFlow } = require('../services/orderAutomation');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function isOperator(req) {
    return req.user?.role === 'OPERATOR';
}

function normalizeStatus(status) {
    if (!status) return status;
    const s = String(status).trim().toUpperCase();
    // Backwards compatibility with older labels
    if (s === 'PLACED' || s === 'RECEIVED') return 'Received';
    if (s === 'IN REVIEW' || s === 'IN_REVIEW' || s === 'REVIEWED') return 'In Review';
    if (s === 'COMPLETED' || s === 'ACCEPTED' || s === 'APPROVED' || s === 'ACCEPT') return 'Accepted';
    return s;
}

function parseNumberFromText(value) {
    const m = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]);
}

function extractItemsFromText(input) {
    const text = String(input || '');
    const cleaned = text
        .replace(/(?:i need|we need|i want|need|please|order|place order|require|procure)/gi, '')
        .replace(/\bto\b/gi, ' ')
        .replace(/(?:deliver(?:ed)?\s+by|delivery\s+by|by|before|on)\s+.+$/i, '')
        .trim();

    const segments = cleaned
        .split(/,| and /i)
        .map(s => s.trim())
        .filter(Boolean);

    const items = [];
    for (const seg of segments) {
        // Supports both:
        // - "60 units of copper wires"
        // - "copper wires 60 units" / "copper wires of 60 units"
        let qty = 0;
        let name = '';

        const qtyFirst = seg.match(/(\d+(?:\.\d+)?)\s*(?:units?|pcs?|pieces?|pairs?|bottles?|barrels?|meters?|rolls?|bags?|tons?|kg|kgs|mt)?\s*(?:of)?\s*(.+)$/i);
        if (qtyFirst) {
            qty = parseNumberFromText(qtyFirst[1]);
            name = String(qtyFirst[2] || '').trim();
        } else {
            const nameFirst = seg.match(/^(.+?)\s*(?:of)?\s*(\d+(?:\.\d+)?)\s*(?:units?|pcs?|pieces?|pairs?|bottles?|barrels?|meters?|rolls?|bags?|tons?|kg|kgs|mt)?$/i);
            if (nameFirst) {
                name = String(nameFirst[1] || '').trim();
                qty = parseNumberFromText(nameFirst[2]);
            }
        }

        if (!name) continue;
        name = name.replace(/\b(i want|i need|we need)\b/gi, '').trim();
        if (qty > 0 && name) {
            items.push({ name, quantity: qty });
        }
    }
    return items;
}

function localParseMessage(message) {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();

    if (!text) return { intent: 'UNKNOWN' };

    // obvious non-industrial keywords
    if (/(burger|pizza|food|restaurant|coffee|tea|fries)/i.test(lower)) {
        return { intent: 'UNKNOWN' };
    }

    // query intents
    if (/(show|list|view).*(orders?)/i.test(lower) || /(orders?).*(show|list|view)/i.test(lower)) {
        const statusMatch = lower.match(/\b(placed|reviewed|completed|received|accepted|in review)\b/i);
        return {
            intent: 'QUERY_ORDERS',
            data: { status: statusMatch ? normalizeStatus(statusMatch[1]) : null }
        };
    }

    // status update intent
    const statusIntent = lower.match(/(?:order\s*#?\s*(\d+).*(?:status|mark|set).*(placed|reviewed|completed|received|accepted|in review))|(?:(placed|reviewed|completed|received|accepted|in review).*(?:order)\s*#?\s*(\d+))/i);
    if (statusIntent) {
        const orderId = Number(statusIntent[1] || statusIntent[4]);
        const statusValue = statusIntent[2] || statusIntent[3];
        return {
            intent: 'UPDATE_STATUS',
            data: { orderId, newStatus: normalizeStatus(statusValue) }
        };
    }

    // quality intent
    const qualityIntent = lower.match(/(?:quality|note|remark).*(?:order)?\s*#?\s*(\d+)/i);
    if (qualityIntent) {
        return {
            intent: 'LOG_QUALITY',
            data: { orderId: Number(qualityIntent[1]), qualityNote: text }
        };
    }

    // cancel/delete intents by order id
    const cancelIntent = lower.match(/(?:cancel|stop)\s+(?:my\s+)?(?:order\s*)?(?:number|id|#)?\s*(\d+)/i);
    if (cancelIntent) {
        return {
            intent: 'CANCEL_ORDER',
            data: { orderId: Number(cancelIntent[1]) }
        };
    }

    const deleteIntent = lower.match(/(?:delete|remove)\s+(?:my\s+)?(?:order\s*)?(?:number|id|#)?\s*(\d+)/i);
    if (deleteIntent) {
        return {
            intent: 'DELETE_ORDER',
            data: { orderId: Number(deleteIntent[1]) }
        };
    }

    // new order intent: supports broad industrial orders
    // e.g. "i want 200 bags of cement, 400 rods on friday"
    const qtyMatch = lower.match(/(\d+)/);
    const deadlineMatch = text.match(/\b(?:by|before|on|deliver(?:ed)?\s+by|delivery\s+by)\b\s+(.+)$/i);
    const looseDateMatch =
        text.match(/\b(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b.*)$/i) ||
        text.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s*\d{1,2}\b.*)$/i);
    const materialMatch = lower.match(/\b(steel|stainless steel|aluminium|aluminum|titanium|copper|brass|iron|plastic|cement|concrete|alloy|carbon steel|rod|rods|pipe|pipes|sheet|sheets|wire|cable|beam|beams)\b/i);
    const orderIntentMatch = /(i need|we need|i want|order|place order|require|procure)/i.test(lower);
    const items = extractItemsFromText(text);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 0;
    const material = materialMatch ? materialMatch[1] : 'industrial';
    const partName = items[0]?.name || 'industrial item';
    const inferredDeadline = deadlineMatch?.[1]?.trim() || looseDateMatch?.[1]?.trim() || 'TBD';

    // Accept both:
    // - full intent prompts: "i want to order 40 drill bits by 3 jan"
    // - short prompts: "drill bits 40 by 3 jan" / "drill bits 40 3 jan"
    const looksLikeShortOrder = items.length > 0 && (Boolean(deadlineMatch) || Boolean(looseDateMatch));
    if ((qtyMatch && orderIntentMatch) || looksLikeShortOrder) {
        return {
            intent: 'NEW_ORDER',
            data: {
                partName,
                material,
                quantity: items[0]?.quantity || quantity,
                items,
                deadline: inferredDeadline
            }
        };
    }

    return { intent: 'UNKNOWN' };
}

const systemInstruction = `
You are an NLP extraction engine for an industrial procurement order system.
Your job is to analyze the user's message and extract data into a STRICT JSON object. 
DO NOT wrap the JSON in markdown blocks. Return ONLY the raw JSON object.

There are 6 possible intents: "NEW_ORDER", "UPDATE_STATUS", "LOG_QUALITY", "QUERY_ORDERS", "CANCEL_ORDER", or "DELETE_ORDER".

1. If the user wants to place an order:
{
  "intent": "NEW_ORDER",
  "data": {
    "items": [{ "name": "string", "quantity": number }],
    "partName": "string (fallback first item name)",
    "material": "string (optional)",
    "quantity": number (fallback first item quantity),
    "deadline": "string"
  }
}

2. If the user wants to update an order's status (Received, In Review, Accepted):
{
  "intent": "UPDATE_STATUS",
  "data": { "orderId": number, "newStatus": "string" }
}

3. If the user wants to add a quality report/note to an order:
{
  "intent": "LOG_QUALITY",
  "data": { "orderId": number, "qualityNote": "string" }
}

4. If the user asks about existing orders:
{
  "intent": "QUERY_ORDERS",
  "data": { "status": "string (Received, In Review, Accepted) or null if they want all orders" }
}

5. If the customer wants to cancel an order:
{
  "intent": "CANCEL_ORDER",
  "data": { "orderId": number }
}

6. If the customer wants to delete an order:
{
  "intent": "DELETE_ORDER",
  "data": { "orderId": number }
}

CRITICAL: Industrial products are valid even if they are not precision parts (e.g. cement, rods, pipes, alloys, sheets, cables).
Short-form order prompts are allowed, for example:
- "Drill Bits 40 by 3 Jan"
- "Copper Wires 60 10 Jan"
These should still be extracted as intent NEW_ORDER with items, quantity, and deadline.
Only if the user asks for something completely unrelated to industrial ordering (like ordering food, chatting, or coding), return exactly this:
{"intent": "UNKNOWN"}
`;

router.post('/', auth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        let parsedData;
        try {
            const model = genAI.getGenerativeModel({ 
                model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
                systemInstruction: systemInstruction 
            });
            const result = await model.generateContent(message);
            let aiResponseText = result.response.text().trim();
            
            // --- Smarter JSON Extraction ---
            const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                aiResponseText = jsonMatch[0];
            }
            parsedData = JSON.parse(aiResponseText);
        } catch (aiErr) {
            // Graceful fallback when model/API is unavailable
            console.error("AI Parse/Fetch Error. Falling back to local parser:", aiErr.message);
            parsedData = localParseMessage(message);
        }

        // Normalize intent to be case-insensitive (Gemini/local parser variations)
        if (parsedData && typeof parsedData === 'object') {
            const intentRaw = parsedData.intent;
            if (typeof intentRaw === 'string') {
                parsedData.intent = intentRaw.trim().toUpperCase();
            }
        }

        // If model returns UNKNOWN, retry with local parser before rejecting.
        if (parsedData.intent === 'UNKNOWN') {
            const fallbackParsed = localParseMessage(message);
            if (fallbackParsed.intent !== 'UNKNOWN') {
                parsedData = fallbackParsed;
            }
        }

        // --- Intent 0: Unknown / Out of Scope ---
        if (parsedData.intent === 'UNKNOWN') {
             return res.json({ reply: "I can only handle industrial orders, status updates, and quality logs." });
        }

        // --- Intent 1: Create Order ---
        if (parsedData.intent === 'NEW_ORDER') {
            if (isOperator(req)) {
                return res.json({ reply: "Operators can't place customer orders. Please log in as a customer to create an order." });
            }
            
            // BULLETPROOF CHECK: Using optional chaining (?.) so it never crashes
            const items = Array.isArray(parsedData.data?.items)
                ? parsedData.data.items
                    .map(i => ({ name: String(i?.name || '').trim(), quantity: parseNumberFromText(i?.quantity) }))
                    .filter(i => i.name && i.quantity > 0)
                : [];
            const heuristicItems = extractItemsFromText(message);
            // Prefer local heuristic extraction when available because LLM output can truncate names
            // (e.g. "silc" instead of "Silicon Seals"), which breaks exact catalog matching.
            const finalItems = heuristicItems.length > 0 ? heuristicItems : items;
            const firstItem = finalItems[0];

            if (!firstItem && (!parsedData.data?.partName || !parsedData.data?.quantity)) {
                return res.json({ reply: "I'm missing item details. Please provide item names, quantities, and deadline." });
            }

            const candidateItems = finalItems.length > 0
                ? finalItems
                : [{ name: parsedData.data.partName, quantity: parsedData.data.quantity }];

            let verification;
            try {
                verification = verifyAndReserveItems(candidateItems);
            } catch (verifyErr) {
                console.error("Catalog Verification Error:", verifyErr.message);
                return res.json({
                    reply: "I couldn't verify this order against the manufacturing dataset right now. Please try again in a moment."
                });
            }

            if (!verification.passed) {
                return res.json({ reply: createVerificationReply(verification) });
            }

            const newOrder = new Order({
                orderId: Math.floor(Math.random() * 90000) + 10000, 
                customer: req.user.id,
                partName: parsedData.data.partName || verification.acceptedItems[0].name || firstItem.name,
                material: parsedData.data.material || 'industrial',
                quantity: parsedData.data.quantity || verification.acceptedItems[0].quantity || firstItem.quantity,
                items: verification.acceptedItems.map(({ name, quantity }) => ({ name, quantity })),
                deadline: parsedData.data.deadline || "TBD",
                originalRequest: message,
                inventoryReserved: true,
                status: 'Received',
                processLogs: [{
                    stage: 'Received',
                    note: 'Order placed through chat and verified against industrial dataset.'
                }]
            });
            try {
                await newOrder.save();
            } catch (saveErr) {
                restoreReservedItems(newOrder.items);
                throw saveErr;
            }

            req.app.get('io')?.emit('orders:created', newOrder);
            startAutoOperatorFlow(newOrder._id, req.app.get('io'));
            const itemSummary = (newOrder.items || [])
                .map(i => `${i.quantity} ${i.name}`)
                .join(', ');
            return res.json({ 
                reply: `Verified against industrial_manufacturing_dataset.csv. Order #${newOrder.orderId} has been auto-placed with ${newOrder.items?.length || 1} item(s): ${itemSummary || `${newOrder.quantity} ${newOrder.partName}`}. Operator agent will automatically review and accept it.`,
                order: newOrder 
            });
        }

        // --- Intent 1b: Cancel Order (Customer by visible order ID) ---
        if (parsedData.intent === 'CANCEL_ORDER') {
            if (isOperator(req)) {
                return res.json({ reply: "Operator cannot cancel customer orders via chat." });
            }
            const orderId = Number(parsedData.data?.orderId || 0);
            if (!orderId) return res.json({ reply: "Please provide a valid order ID to cancel." });

            const order = await Order.findOne({ orderId });
            if (!order) return res.json({ reply: `I couldn't find order #${orderId}.` });
            const isOwner = String(order.customer) === String(req.user.id);
            if (!isOwner) return res.json({ reply: "You can only cancel your own orders." });
            if (!['Received', 'In Review'].includes(order.status)) {
                return res.json({ reply: `Order #${orderId} cannot be cancelled in '${order.status}' status.` });
            }

            if (order.inventoryReserved) {
                restoreReservedItems(order.items);
                order.inventoryReserved = false;
            }
            order.status = 'Cancelled';
            if (!Array.isArray(order.processLogs)) order.processLogs = [];
            order.processLogs.push({
                stage: 'Cancelled',
                note: 'Order cancelled by customer through chatbot.'
            });
            await order.save();
            req.app.get('io')?.emit('orders:updated', order);
            return res.json({ reply: `Order #${orderId} has been cancelled successfully.`, order });
        }

        // --- Intent 1c: Delete Order (Customer by visible order ID) ---
        if (parsedData.intent === 'DELETE_ORDER') {
            if (isOperator(req)) {
                return res.json({ reply: "Operator cannot delete customer orders via chat." });
            }
            const orderId = Number(parsedData.data?.orderId || 0);
            if (!orderId) return res.json({ reply: "Please provide a valid order ID to delete." });

            const order = await Order.findOne({ orderId });
            if (!order) return res.json({ reply: `I couldn't find order #${orderId}.` });
            const isOwner = String(order.customer) === String(req.user.id);
            if (!isOwner) return res.json({ reply: "You can only delete your own orders." });
            if (order.status === 'Accepted') {
                return res.json({ reply: `Order #${orderId} is already accepted and cannot be deleted.` });
            }

            if (order.inventoryReserved) {
                restoreReservedItems(order.items);
            }
            const deletedId = order._id;
            await order.deleteOne();
            req.app.get('io')?.emit('orders:deleted', { id: deletedId, orderId });
            return res.json({ reply: `Order #${orderId} has been deleted successfully.` });
        }

        // --- Intent 2: Update Status ---
        if (parsedData.intent === 'UPDATE_STATUS') {
            if (!isOperator(req)) {
                return res.json({ reply: "Only an operator can change order status." });
            }
            if (!parsedData.data?.orderId || !parsedData.data?.newStatus) {
                return res.json({ reply: "Please provide both the Order ID and the new status." });
            }

            const newStatus = normalizeStatus(parsedData.data.newStatus);
            const order = await Order.findOne({ orderId: parsedData.data.orderId });
            if (!order) return res.json({ reply: "I couldn't find an order with that ID." });

            const transitions = {
                'Received': ['In Review'],
                'In Review': ['Accepted'],
                'Accepted': []
            };
            if (!transitions[order.status]?.includes(newStatus) && order.status !== newStatus) {
                return res.json({ reply: `Invalid status flow. Allowed transitions: Received -> In Review -> Accepted.` });
            }
            order.status = newStatus;
            await order.save();
            
            req.app.get('io')?.emit('orders:updated', order);
            return res.json({ reply: `Done. Order #${order.orderId} status is now '${order.status}'.`, order });
        }

        // --- Intent 3: Log Quality ---
        if (parsedData.intent === 'LOG_QUALITY') {
            if (!isOperator(req)) {
                return res.json({ reply: "Only an operator can add quality logs." });
            }
            if (!parsedData.data?.orderId || !parsedData.data?.qualityNote) {
                 return res.json({ reply: "Please provide the Order ID and the quality note." });
            }

            const order = await Order.findOne({ orderId: parsedData.data.orderId });
            if (!order) return res.json({ reply: "I couldn't find an order with that ID." });

            order.qualityLogs.push({ note: parsedData.data.qualityNote });
            await order.save();
            
            req.app.get('io')?.emit('orders:updated', order);
            return res.json({ reply: `Quality note added to Order #${order.orderId}.`, order });
        }

        // --- Intent 4: Query Orders ---
        if (parsedData.intent === 'QUERY_ORDERS') {
            let filter = {};
            if (!isOperator(req)) {
                filter.customer = req.user.id;
            }
            if (parsedData.data?.status) {
                const ns = normalizeStatus(parsedData.data.status);
                filter.status = new RegExp(`^${ns}$`, 'i');
            }
            const orders = await Order.find(filter);

            if (orders.length === 0) {
                return res.json({ reply: `I currently don't see any orders matching that criteria.` });
            }

            const orderList = orders.map(o => `#${o.orderId} (${o.quantity} ${o.partName})`).join(', ');
            const statusText = parsedData.data?.status ? `'${parsedData.data.status}'` : "total";
            
            return res.json({ reply: `You have ${orders.length} ${statusText} orders right now: ${orderList}.` });
        }

        return res.json({ reply: "I'm not sure what action you want me to take. Can you clarify?" });

    } catch (error) {
        console.error("Critical Chat Error:", error.message);
        res.json({ reply: "Something went wrong while processing your request. Please try again." });
    }
});

module.exports = router;