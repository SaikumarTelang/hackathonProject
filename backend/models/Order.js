const mongoose = require('mongoose');

const qualityNoteSchema = new mongoose.Schema({
    note: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const processLogSchema = new mongoose.Schema({
    stage: { type: String, required: true },
    note: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    quantity: { type: Number, required: true }
}, { _id: false });

const orderSchema = new mongoose.Schema({
    orderId: { type: Number, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partName: { type: String, required: true },
    material: { type: String, required: true },
    quantity: { type: Number, required: true },
    items: { type: [orderItemSchema], default: [] },
    deadline: { type: String, required: true },
    originalRequest: { type: String, default: '' },
    inventoryReserved: { type: Boolean, default: false },
    status: { 
        type: String, 
        enum: ['Received', 'In Review', 'Accepted', 'Cancelled'], 
        default: 'Received' 
    },
    processLogs: { type: [processLogSchema], default: [] },
    qualityLogs: [qualityNoteSchema]
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);