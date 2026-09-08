const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { verifyPassword } = require('../utils/password');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Limite les tentatives de connexion : 10 essais / 15 min / IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { rows } = await db.query(
    'SELECT id, email, pwd_hash, prenom, nom, role, actif FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  const user = rows[0];

  // Toujours comparer même si l'utilisateur n'existe pas (évite de révéler
  // par le temps de réponse si un email existe dans la base — timing attack).
  const validPwd = user ? await verifyPassword(password, user.pwd_hash) : await verifyPassword(password, '$2a$12$invalidsaltinvalidsaltinvalidsal');

  if (!user || !validPwd || !user.actif) {
    await logAudit(null, 'login_echec', 'user', null, `Tentative échouée pour ${email}`, req.ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

  await db.query('UPDATE users SET dernier_login = now() WHERE id = $1', [user.id]);
  await logAudit(user.id, 'login', 'user', user.id, null, req.ip);

  res.json({
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: { id: user.id, email: user.email, prenom: user.prenom, nom: user.nom, role: user.role },
  });
});

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken requis' });
  try {
    const payload = verifyToken(refreshToken);
    if (payload.type !== 'refresh') throw new Error('not a refresh token');
    const { rows } = await db.query('SELECT id, email, role, actif FROM users WHERE id = $1', [payload.sub]);
    const user = rows[0];
    if (!user || !user.actif) return res.status(401).json({ error: 'Compte introuvable ou désactivé' });
    res.json({ accessToken: signAccessToken(user) });
  } catch (e) {
    res.status(401).json({ error: 'Jeton de rafraîchissement invalide ou expiré' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, email, prenom, nom, role, secteur, poste FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(rows[0]);
});

router.post('/logout', requireAuth, async (req, res) => {
  await logAudit(req.user.id, 'logout', 'user', req.user.id, null, req.ip);
  // Avec des JWT stateless, la "déconnexion" réelle nécessite une liste de
  // révocation (Redis) pour être immédiate ; V0.2. Pour l'instant le token
  // expire naturellement (15 min) — c'est documenté, pas caché.
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
  }
  const { rows } = await db.query('SELECT pwd_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const ok = await verifyPassword(currentPassword, rows[0].pwd_hash);
  if (!ok) {
    await logAudit(req.user.id, 'changement_mdp_echec', 'user', req.user.id, null, req.ip);
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  }

  const { hashPassword } = require('../utils/password');
  const newHash = await hashPassword(newPassword);
  await db.query('UPDATE users SET pwd_hash = $1, maj_le = now() WHERE id = $2', [newHash, req.user.id]);
  await logAudit(req.user.id, 'changement_mdp', 'user', req.user.id, null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
