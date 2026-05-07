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

function extractOrderIdFromText(input) {
    const m = String(input || '').match(/(?:order\s*)?(?:number|id|#)\s*(\d+)/i) || String(input || '').match(/\b(\d{4,})\b/);
    return m ? Number(m[1]) : 0;
}

function extractQuantityUpdate(input) {
    const m =
        String(input || '').match(/(?:change|update|set)\s+(?:the\s+)?quantity\s+(?:to\s+)?(\d+(?:\.\d+)?)/i) ||
        String(input || '').match(/\bquantity\s+(?:to\s+)?(\d+(?:\.\d+)?)/i);
    return m ? parseNumberFromText(m[1]) : 0;
}

function extractQuantityTargetItem(input) {
    const text = String(input || '');
    const m =
        text.match(/\bquantity\s+(?:to\s+)?\d+(?:\.\d+)?\s+(?:of|for)\s+(.+)$/i) ||
        text.match(/\b(?:set|change|update)\s+(.+?)\s+quantity\s+(?:to\s+)?\d+(?:\.\d+)?$/i);
    if (!m) return '';
    return String(m[1] || '')
        .replace(/\b(?:by|before|on)\b\s+.+$/i, '')
        .trim();
}

function normalizeItemName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ');
}

function mergeItems(baseItems, additionalItems) {
    const merged = [];
    const index = new Map();
    for (const item of [...(baseItems || []), ...(additionalItems || [])]) {
        const name = String(item?.name || '').trim();
        const quantity = Number(item?.quantity || 0);
        if (!name || quantity <= 0) continue;
        const key = normalizeItemName(name);
        if (!index.has(key)) {
            index.set(key, merged.length);
            merged.push({ name, quantity });
        } else {
            const pos = index.get(key);
            merged[pos].quantity += quantity;
        }
    }
    return merged;
}

function extractItemsFromText(input) {
    const text = String(input || '');
    const cleaned = text
        .replace(/\b(?:i need|we need|i want|need|please|place order|order|require|procure)\b/gi, '')
        .replace(/\bto\b/gi, ' ')
        // Remove trailing deadline phrase only (word-boundary guarded so product names like "silicon" are safe)
        .replace(/\b(?:deliver(?:ed)?\s+by|delivery\s+by|by|before|on)\b\s+.+$/i, '')
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

        const qtyFirst = seg.match(/(\d+(?:\.\d+)?)\s*(?:(?:units?|pcs?|pieces?|pairs?|bottles?|barrels?|meters?|rolls?|bags?|tons?|kg|kgs|mt)\b)?\s*(?:of)?\s*(.+)$/i) || seg.match(/(\d+(?:\.\d+)?)\s*(.+)$/i);
        if (qtyFirst) {
            qty = parseNumberFromText(qtyFirst[1]);
            name = String(qtyFirst[2] || '').trim();
        } else {
            const nameFirst = seg.match(/^(.+?)\s*(?:of)?\s*(\d+(?:\.\d+)?)\s*(?:(?:units?|pcs?|pieces?|pairs?|bottles?|barrels?|meters?|rolls?|bags?|tons?|kg|kgs|mt)\b)?$/i) || seg.match(/^(.+?)\s*(?:of)?\s*(\d+(?:\.\d+)?)$/i);
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

    // modify/edit order intent by order id
    const modifyIntentMatch =
        /(modify|update|change|edit)\b.*\border\b/i.test(lower) ||
        /(modify|update|change|edit)\b.*\b\d{4,}\b/i.test(lower);
    if (modifyIntentMatch) {
        const orderId = extractOrderIdFromText(text);
        const items = extractItemsFromText(text);
        const deadlineMatch = text.match(/\b(?:by|before|on|deliver(?:ed)?\s+by|delivery\s+by)\b\s+(.+)$/i);
        const looseDateMatch =
            text.match(/\b(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b.*)$/i) ||
            text.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s*\d{1,2}\b.*)$/i);

        return {
            intent: 'MODIFY_ORDER',
            data: {
                orderId,
                items,
                deadline: deadlineMatch?.[1]?.trim() || looseDateMatch?.[1]?.trim() || undefined
            }
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

There are 7 possible intents: "NEW_ORDER", "UPDATE_STATUS", "LOG_QUALITY", "QUERY_ORDERS", "CANCEL_ORDER", "DELETE_ORDER", or "MODIFY_ORDER".

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

7. If the customer wants to modify an existing order before acceptance:
{
  "intent": "MODIFY_ORDER",
  "data": {
    "orderId": number,
    "items": [{ "name": "string", "quantity": number }],
    "deadline": "string (optional)"
  }
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

        // --- Intent 1d: Modify Order (Customer by visible order ID, before acceptance) ---
        if (parsedData.intent === 'MODIFY_ORDER') {
            if (isOperator(req)) {
                return res.json({ reply: "Operator cannot modify customer orders via chat." });
            }

            const orderId = Number(parsedData.data?.orderId || extractOrderIdFromText(message) || 0);
            if (!orderId) return res.json({ reply: "Please provide a valid order ID to modify." });

            const order = await Order.findOne({ orderId });
            if (!order) return res.json({ reply: `I couldn't find order #${orderId}.` });
            const isOwner = String(order.customer) === String(req.user.id);
            if (!isOwner) return res.json({ reply: "You can only modify your own orders." });
            if (!['Received', 'In Review'].includes(order.status)) {
                return res.json({ reply: `Order #${orderId} can only be modified before acceptance.` });
            }

            const aiItems = Array.isArray(parsedData.data?.items)
                ? parsedData.data.items
                    .map(i => ({ name: String(i?.name || '').trim(), quantity: parseNumberFromText(i?.quantity) }))
                    .filter(i => i.name && i.quantity > 0)
                : [];
            const heuristicItems = extractItemsFromText(message).filter(i => {
                const n = String(i.name || '').toLowerCase().trim();
                if (/^(change|update|set)\s+quantity\b/.test(n)) return false;
                if (/^quantity\b/.test(n)) return false;
                if (/^order\b/.test(n)) return false;
                return true;
            });
            const finalItems = heuristicItems.length > 0 ? heuristicItems : aiItems;
            const quantityUpdate = extractQuantityUpdate(message);
            const quantityTargetItem = extractQuantityTargetItem(message);

            // Supports "add item ..." phrasing in modify prompts.
            const addSegment = String(message || '').match(/\badd\b([\s\S]+)$/i);
            const addedItems = addSegment ? extractItemsFromText(addSegment[1]) : [];

            const updatedDeadline = parsedData.data?.deadline || order.deadline;
            let candidateItems = Array.isArray(order.items)
                ? order.items.map(i => ({ name: i.name, quantity: i.quantity }))
                : [];

            // Only override full item list when customer explicitly provides item updates.
            if (finalItems.length > 0 && !/\bquantity\b/i.test(String(message || ''))) {
                candidateItems = finalItems;
            }

            if (quantityUpdate > 0) {
                // If only quantity is provided, update primary item quantity.
                if (quantityTargetItem) {
                    const targetKey = normalizeItemName(quantityTargetItem);
                    const idx = candidateItems.findIndex(i => normalizeItemName(i.name) === targetKey);
                    if (idx >= 0) {
                        candidateItems[idx].quantity = quantityUpdate;
                    } else {
                        candidateItems = mergeItems(candidateItems, [{ name: quantityTargetItem, quantity: quantityUpdate }]);
                    }
                } else if (candidateItems.length > 0) {
                    candidateItems[0].quantity = quantityUpdate;
                } else if (order.partName) {
                    candidateItems = [{ name: order.partName, quantity: quantityUpdate }];
                }
            }

            if (addedItems.length > 0) {
                candidateItems = mergeItems(candidateItems, addedItems);
            }

            if (candidateItems.length === 0 && !parsedData.data?.deadline) {
                return res.json({ reply: "Please provide updated quantity/items and optionally a deadline. Example: modify order 11637 change quantity 2 or modify order 11637 add 5 copper wires." });
            }

            // Re-balance inventory: release existing reservation, then reserve updated items.
            if (order.inventoryReserved) {
                restoreReservedItems(order.items);
            }

            let verification;
            try {
                verification = verifyAndReserveItems(candidateItems);
            } catch (verifyErr) {
                console.error("Catalog Verification Error (Modify):", verifyErr.message);
                // Attempt to restore original reservation to keep data consistent.
                if (order.items?.length) {
                    try { verifyAndReserveItems(order.items); } catch (_) { /* noop */ }
                }
                return res.json({ reply: "I couldn't verify the modified order right now. Please try again." });
            }

            if (!verification.passed) {
                // Reserve original again if modification failed validation.
                if (order.items?.length) {
                    try { verifyAndReserveItems(order.items); } catch (_) { /* noop */ }
                }
                return res.json({ reply: createVerificationReply(verification) });
            }

            order.items = verification.acceptedItems.map(({ name, quantity }) => ({ name, quantity }));
            order.partName = order.items[0]?.name || order.partName;
            order.quantity = order.items[0]?.quantity || order.quantity;
            order.deadline = updatedDeadline;
            order.material = order.material || 'industrial';
            order.inventoryReserved = true;
            if (!Array.isArray(order.processLogs)) order.processLogs = [];
            order.processLogs.push({
                stage: order.status,
                note: 'Order modified by customer through chatbot before acceptance.'
            });
            await order.save();

            req.app.get('io')?.emit('orders:updated', order);
            const itemSummary = order.items.map(i => `${i.quantity} ${i.name}`).join(', ');
            return res.json({
                reply: `Order #${orderId} has been updated successfully. New details: ${itemSummary}. Deadline: ${order.deadline}.`,
                order
            });
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