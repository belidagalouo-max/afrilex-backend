const { verifyToken } = require('../utils/jwt');

// Vérifie le JWT sur chaque requête protégée. Aucune route sensible ne doit
// faire confiance à un rôle ou un ID envoyé par le client sans repasser par ici.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    const payload = verifyToken(token);
    if (payload.type === 'refresh') return res.status(401).json({ error: 'Jeton invalide pour cette route' });
    // Un jeton du portail client (aud: 'client-portal') ne doit JAMAIS être
    // accepté ici — deux systèmes d'authentification strictement séparés,
    // même s'ils partagent le même secret de signature.
    if (payload.aud === 'client-portal') return res.status(401).json({ error: 'Jeton invalide pour cette route' });
    if (!payload.role) return res.status(401).json({ error: 'Jeton invalide pour cette route' });
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  }
}

// Restreint une route à une liste de rôles. Toujours utilisé APRÈS requireAuth.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Droits insuffisants pour cette action' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
