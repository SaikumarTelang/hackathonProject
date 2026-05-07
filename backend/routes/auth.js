const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'nova-dev-jwt-secret-change-me';
if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET missing in environment. Using development fallback secret.');
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isStrongPassword(password) {
    const p = String(password || '');
    // Simple but effective policy:
    // - min 8 chars
    // - at least one letter
    // - at least one number
    return p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

// @route   POST /api/auth/register
// @desc    Register a new customer user
router.post('/register', async (req, res) => {
    try {
        const { email, password, role, name } = req.body;
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({ msg: 'Email is required' });
        }
        if (!password) {
            return res.status(400).json({ msg: 'Password is required' });
        }

        if (role && String(role).toUpperCase() !== 'CUSTOMER') {
            return res.status(403).json({ msg: 'Only customer registration is allowed' });
        }

        if (!isStrongPassword(password)) {
            return res.status(400).json({
                msg: 'Password must be at least 8 characters and include at least one letter and one number'
            });
        }

        // 1. Check if user already exists
        let user = await User.findOne({ email: normalizedEmail });
        if (user) {
            return res.status(400).json({ msg: 'User already exists' });
        }

        // 2. Create new user instance
        user = new User({ email: normalizedEmail, password, role: 'CUSTOMER', name: name || '' });

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
        const normalizedEmail = normalizeEmail(email);

        // 1. Check if user exists
        let user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid email or password' });
        }

        // 2. Compare passwords
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid email or password' });
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
            JWT_SECRET,
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