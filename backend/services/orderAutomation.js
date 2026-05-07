const Order = require('../models/Order');

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function transitionOrder(orderId, nextStatus, processMessage, io) {
    const order = await Order.findById(orderId);
    if (!order) return null;
    if (order.status === 'Cancelled') return null;
    if (order.status === 'Accepted' && nextStatus !== 'Accepted') return order;

    try {
        order.status = nextStatus;
        if (!Array.isArray(order.processLogs)) {
            order.processLogs = [];
        }
        order.processLogs.push({ stage: nextStatus, note: processMessage });
        await order.save();
        io?.emit('orders:updated', order);
        return order;
    } catch (err) {
        console.error('Auto Operator transition failed:', {
            orderId: String(orderId),
            from: order?.status,
            to: nextStatus,
            error: err?.message || String(err)
        });
        throw err;
    }
}

async function runAutoOperatorFlow(orderId, io) {
    await wait(5000);
    const inReview = await transitionOrder(
        orderId,
        'In Review',
        'Operator agent reviewed stock and order validity against dataset.',
        io
    );
    if (!inReview) return;

    // Accept exactly after 60 seconds from placement (5s to In Review)
    await wait(55000);
    await transitionOrder(
        orderId,
        'Accepted',
        'Operator agent automatically accepted order based on verified availability.',
        io
    );
}

function startAutoOperatorFlow(orderId, io) {
    runAutoOperatorFlow(orderId, io).catch(err => {
        console.error('Auto Operator Flow Error:', err.message);
    });
}

async function runOperatorSchedulerOnce(io) {
    const now = Date.now();
    const reviewCutoff = new Date(now - 5000); // placed >= 5s ago
    const acceptCutoff = new Date(now - 60000); // placed >= 60s ago

    // 1) Move eligible Received orders to In Review
    const toReview = await Order.find({
        status: 'Received',
        createdAt: { $lte: reviewCutoff }
    }).limit(50);

    for (const order of toReview) {
        // Re-check current status just in case
        if (!order || order.status !== 'Received') continue;
        await transitionOrder(
            order._id,
            'In Review',
            'Operator agent reviewed stock and order validity against dataset (scheduler).',
            io
        );
    }

    // 2) Move eligible In Review orders to Accepted
    const toAccept = await Order.find({
        status: 'In Review',
        createdAt: { $lte: acceptCutoff }
    }).limit(50);

    for (const order of toAccept) {
        if (!order || order.status !== 'In Review') continue;
        await transitionOrder(
            order._id,
            'Accepted',
            'Operator agent automatically accepted order based on verified availability (scheduler).',
            io
        );
    }
}

function startOperatorScheduler(io) {
    let running = false;
    const interval = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await runOperatorSchedulerOnce(io);
        } catch (err) {
            console.error('Operator scheduler error:', err?.message || String(err));
        } finally {
            running = false;
        }
    }, 2000);

    // allow process to exit cleanly in dev
    interval.unref?.();
    return interval;
}

module.exports = { startAutoOperatorFlow, startOperatorScheduler };
