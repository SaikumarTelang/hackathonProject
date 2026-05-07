const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Order = require('../models/Order');
const { verifyAndReserveItems, restoreReservedItems, createVerificationReply } = require('../services/orderAgent');
const { startAutoOperatorFlow } = require('../services/orderAutomation');

function isOperator(req) {
    return req.user?.role === 'OPERATOR';
}

function canCancel(status) {
    return status === 'Received' || status === 'In Review';
}

// GET /api/orders
// Operator: all orders. Customer: only their orders.
router.get('/', auth, async (req, res) => {
    try {
        const filter = isOperator(req) ? {} : { customer: req.user.id };
        const orders = await Order.find(filter).sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        console.error("Dashboard Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// POST /api/orders
// Create an order (customer)
router.post('/', auth, async (req, res) => {
    try {
        if (isOperator(req)) {
            return res.status(403).json({ msg: 'Operators cannot place customer orders via this endpoint.' });
        }
        const { partName, material, quantity, deadline, originalRequest, items } = req.body;
        const parsedItems = Array.isArray(items)
            ? items
                .map(i => ({ name: String(i?.name || '').trim(), quantity: Number(i?.quantity || 0) }))
                .filter(i => i.name && i.quantity > 0)
            : [];
        const firstItem = parsedItems[0];

        if ((!partName && !firstItem?.name) || !deadline) {
            return res.status(400).json({ msg: 'deadline and at least one item are required' });
        }

        const candidateItems = parsedItems.length > 0
            ? parsedItems
            : [{ name: partName, quantity }];

        let verification;
        try {
            verification = verifyAndReserveItems(candidateItems);
        } catch (verifyErr) {
            console.error("Catalog Verification Error:", verifyErr.message);
            return res.status(503).json({ msg: 'Unable to verify order against dataset at the moment' });
        }

        if (!verification.passed) {
            return res.status(400).json({ msg: createVerificationReply(verification) });
        }

        const newOrder = new Order({
            orderId: Math.floor(Math.random() * 90000) + 10000,
            customer: req.user.id,
            partName: partName || verification.acceptedItems[0].name || firstItem.name,
            material: material || 'industrial',
            quantity: quantity || verification.acceptedItems[0].quantity || firstItem.quantity,
            items: verification.acceptedItems.map(({ name, quantity: qty }) => ({ name, quantity: qty })),
            deadline,
            originalRequest: originalRequest || '',
            inventoryReserved: true,
            status: 'Received',
            processLogs: [{
                stage: 'Received',
                note: 'Order placed by customer and verified against industrial dataset.'
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
        return res.status(201).json(newOrder);
    } catch (err) {
        console.error("Create Order Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// PATCH /api/orders/:id/status
// Operator can only accept orders
router.patch('/:id/status', auth, async (req, res) => {
    try {
        if (!isOperator(req)) return res.status(403).json({ msg: 'Operator only' });
        const { status } = req.body;
        if (status !== 'Accepted') {
            return res.status(400).json({ msg: 'Operator can only set status to Accepted' });
        }

        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ msg: 'Order not found' });
        if (order.status !== 'Received') {
            return res.status(400).json({ msg: 'Only Received orders can be accepted' });
        }

        order.status = 'Accepted';
        await order.save();

        req.app.get('io')?.emit('orders:updated', order);
        return res.json(order);
    } catch (err) {
        console.error("Update Status Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// PATCH /api/orders/:id
// Edit basic fields (customer who owns it; disallow edits if completed/cancelled)
router.patch('/:id', auth, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        const isOwner = String(order.customer) === String(req.user.id);
        if (!isOwner && !isOperator(req)) return res.status(403).json({ msg: 'Forbidden' });
        if (!canCancel(order.status)) return res.status(400).json({ msg: 'Cannot edit a completed/cancelled order' });

        const allowed = ['partName', 'material', 'quantity', 'deadline'];
        for (const key of allowed) {
            if (req.body[key] !== undefined) order[key] = req.body[key];
        }
        await order.save();

        req.app.get('io')?.emit('orders:updated', order);
        return res.json(order);
    } catch (err) {
        console.error("Edit Order Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// POST /api/orders/:id/cancel
// Cancel (customer owner only, while order is still PLACED)
router.post('/:id/cancel', auth, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        const isOwner = String(order.customer) === String(req.user.id);
        if (!isOwner) return res.status(403).json({ msg: 'Only order owner can cancel' });
        if (!canCancel(order.status)) return res.status(400).json({ msg: 'Only Received orders can be cancelled' });

        if (order.inventoryReserved) {
            restoreReservedItems(order.items);
            order.inventoryReserved = false;
        }
        order.status = 'Cancelled';
        if (!Array.isArray(order.processLogs)) order.processLogs = [];
        order.processLogs.push({
            stage: 'Cancelled',
            note: 'Order cancelled by customer.'
        });
        await order.save();

        req.app.get('io')?.emit('orders:updated', order);
        return res.json(order);
    } catch (err) {
        console.error("Cancel Order Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// DELETE /api/orders/:id
// Hard delete (operator only)
router.delete('/:id', auth, async (req, res) => {
    try {
        if (!isOperator(req)) return res.status(403).json({ msg: 'Operator only' });
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ msg: 'Order not found' });
        if (canCancel(order.status) && order.inventoryReserved) {
            restoreReservedItems(order.items);
            order.inventoryReserved = false;
        }
        await order.deleteOne();

        req.app.get('io')?.emit('orders:deleted', { id: req.params.id, orderId: order.orderId });
        return res.json({ msg: 'Deleted', id: req.params.id });
    } catch (err) {
        console.error("Delete Order Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// POST /api/orders/by-order-id/:orderId/cancel
// Customer can cancel using visible order ID
router.post('/by-order-id/:orderId/cancel', auth, async (req, res) => {
    try {
        const order = await Order.findOne({ orderId: Number(req.params.orderId) });
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        const isOwner = String(order.customer) === String(req.user.id);
        if (!isOwner) return res.status(403).json({ msg: 'Only order owner can cancel' });
        if (!canCancel(order.status)) return res.status(400).json({ msg: 'Only Received/In Review orders can be cancelled' });

        if (order.inventoryReserved) {
            restoreReservedItems(order.items);
            order.inventoryReserved = false;
        }
        order.status = 'Cancelled';
        if (!Array.isArray(order.processLogs)) order.processLogs = [];
        order.processLogs.push({
            stage: 'Cancelled',
            note: 'Order cancelled by customer using order ID.'
        });
        await order.save();

        req.app.get('io')?.emit('orders:updated', order);
        return res.json(order);
    } catch (err) {
        console.error("Cancel By OrderId Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// DELETE /api/orders/by-order-id/:orderId
// Customer can delete using visible order ID
router.delete('/by-order-id/:orderId', auth, async (req, res) => {
    try {
        const order = await Order.findOne({ orderId: Number(req.params.orderId) });
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        const isOwner = String(order.customer) === String(req.user.id);
        if (!isOwner) return res.status(403).json({ msg: 'Only order owner can delete' });
        if (order.status === 'Accepted') return res.status(400).json({ msg: 'Accepted orders cannot be deleted by customer' });

        if (order.inventoryReserved) {
            restoreReservedItems(order.items);
        }
        const deletedId = order._id;
        await order.deleteOne();

        req.app.get('io')?.emit('orders:deleted', { id: deletedId, orderId: order.orderId });
        return res.json({ msg: 'Deleted', orderId: order.orderId });
    } catch (err) {
        console.error("Delete By OrderId Error:", err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;