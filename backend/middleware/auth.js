const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    const headerToken = req.header('x-auth-token');
    const authHeader = req.header('authorization');
    const bearerToken = authHeader && authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice('bearer '.length).trim()
        : null;

    const token = bearerToken || headerToken;
    if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;
        next();
    } catch (err) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
};
