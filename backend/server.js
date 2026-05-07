require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const { startOperatorScheduler } = require('./services/orderAutomation');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }
});
app.set('io', io);

// Middleware
app.use(express.json());
app.use(cors());

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log(' MongoDB Connected Successfully');

        // Seed default operator for demo/testing if missing
        const demoEmail = process.env.DEMO_OPERATOR_EMAIL || 'operator@nova.local';
        const demoPassword = process.env.DEMO_OPERATOR_PASSWORD || 'Operator@123';
        const existing = await User.findOne({ email: demoEmail });
        if (!existing) {
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(demoPassword, salt);
            await User.create({
                email: demoEmail,
                password: hashed,
                role: 'OPERATOR',
                name: 'Default Operator'
            });
            console.log(` Demo operator created: ${demoEmail}`);
        }

        // Start background auto-operator scheduler (stops orders stuck in Received/In Review)
        startOperatorScheduler(io);
    })
    .catch(err => console.error(' MongoDB Connection Error:', err.message));

// Route Declarations - MUST MATCH YOUR FILE NAMES
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/catalog', require('./routes/catalog'));

// Basic Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'active', message: 'Nova Nexus API is online' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));