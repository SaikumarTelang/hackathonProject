const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getCatalogItems } = require('../services/orderAgent');

router.get('/', auth, (req, res) => {
    try {
        const items = getCatalogItems();
        return res.json({ items });
    } catch (err) {
        console.error('Catalog Fetch Error:', err.message);
        return res.status(503).json({ msg: 'Unable to load catalog at the moment' });
    }
});

module.exports = router;
