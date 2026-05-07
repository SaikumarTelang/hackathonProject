const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// @route   POST /api/auth/register
// @desc    Register a new user (customer/operator)
router.post('/register', async (req, res) => {
    try {
        const { email, password, role, name } = req.body;

        // 1. Check if user already exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ msg: 'User already exists' });
        }

        // 2. Create new user instance
        user = new User({ email, password, role: role || 'CUSTOMER', name: name || '' });

        // 3. Hash the password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);

        // 4. Save to MongoDB
        await user.save();

        res.json({ msg: 'User registered successfully' });
    } catch (err) {
        console.error("Registration Error:", err.message);
        res.status(500).send('Server error during registration');
    }
});

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // 1. Check if user exists
        let user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials - User not found' });
        }

        // 2. Compare passwords
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials - Password mismatch' });
        }

        // 3. Create JWT Payload
        const payload = {
            user: {
                id: user.id,
                role: user.role
            }
        };

        // 4. Sign the token
        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '10h' }, // Token valid for the duration of the hackathon
            (err, token) => {
                if (err) throw err;
                res.json({
                    token,
                    msg: 'Login successful',
                    user: { id: user.id, email: user.email, role: user.role, name: user.name }
                });
            }
        );
    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).send('Server error during login');
    }
});

module.exports = router;