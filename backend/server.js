require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully'))
    .catch(err => console.log('MongoDB Connection Error: ', err));

// Basic Health Check Route
app.get('/api/health', (req, res) => {
    res.json({ status: 'active', message: 'Backend is running' });
});

// We will mount your specific routes here later
// app.use('/api/auth', require('./routes/auth'));
// app.use('/api/chat', require('./routes/chat'));
// app.use('/api/orders', require('./routes/orders'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));