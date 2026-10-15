const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) console.warn('WARNING: JWT_SECRET is missing or shorter than 32 characters. Set a long random value.');

module.exports = function auth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token' });
    const token = header.replace('Bearer ', '');
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded.purpose === 'mfa') return res.status(401).json({ error: 'Invalid token' });
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