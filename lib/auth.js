const jwt = require('jsonwebtoken');

module.exports = function auth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token' });
    const token = header.replace('Bearer ', '');
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const normalizedRole = (decoded.role || '').toString().trim().toLowerCase();
      if (roles.length && !roles.map(r => r.toLowerCase()).includes(normalizedRole)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
};