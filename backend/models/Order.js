const mongoose = require('mongoose');

const qualityNoteSchema = new mongoose.Schema({
    note: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
    orderId: { type: Number, required: true, unique: true },
    partName: { type: String, required: true },
    material: { type: String, required: true },
    quantity: { type: Number, required: true },
    deadline: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['Received', 'In Review', 'Accepted'], 
        default: 'Received' 
    },
    qualityLogs: [qualityNoteSchema]
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);