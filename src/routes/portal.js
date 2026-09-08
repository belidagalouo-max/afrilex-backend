const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../utils/password');
const { logAudit } = require('../utils/audit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function genTempPassword() {
  const words = ['Zenith', 'Baobab', 'Kalao', 'Savane', 'Lumen', 'Askia', 'Delta', 'Horizon'];
  const w = words[Math.floor(Math.random() * words.length)];
  return w + Math.floor(1000 + Math.random() * 9000) + '!';
}

// ============================================================
// CÔTÉ COLLABORATEUR (staff) — créer/gérer l'accès portail d'un client
// ============================================================
router.post('/clients/:id/portal', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const { rows: clientRows } = await db.query('SELECT id, email, prenom, nom FROM clients WHERE id = $1 AND supprime_le IS NULL', [req.params.id]);
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  if (!client.email) return res.status(400).json({ error: "Le client n'a pas d'adresse e-mail renseignée" });

  const tempPassword = genTempPassword();
  const pwdHash = await hashPassword(tempPassword);

  const { rows } = await db.query(
    `INSERT INTO client_accounts (client_id, email, pwd_hash, statut, active_le)
     VALUES ($1, $2, $3, 'actif', now())
     ON CONFLICT (client_id) DO UPDATE SET email = $2, pwd_hash = $3, statut = 'actif', active_le = now()
     RETURNING id, email, statut, cree_le`,
    [client.id, client.email, pwdHash]
  );

  await logAudit(req.user.id, 'portail_cree', 'client', client.id, `Portail créé/réinitialisé pour ${client.email}`, req.ip);

  // Le mot de passe temporaire n'est JAMAIS stocké en clair : on le renvoie
  // une seule fois ici, au collaborateur qui vient de le générer, pour qu'il
  // le transmette lui-même au client (par le canal de son choix).
  res.status(201).json({
    ok: true,
    account: rows[0],
    tempPassword,
    message: 'Communiquez ce mot de passe temporaire au client — il ne sera plus jamais affiché.',
  });
});

router.patch('/clients/:id/portal/status', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const { statut } = req.body || {};
  if (!['actif', 'suspendu', 'lecture_seule', 'ferme'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  const { rows } = await db.query(
    `UPDATE client_accounts SET statut = $1 WHERE client_id = $2 RETURNING *`,
    [statut, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Aucun portail pour ce client' });
  await logAudit(req.user.id, 'portail_statut', 'client', req.params.id, `→ ${statut}`, req.ip);
  res.json(rows[0]);
});

// ============================================================
// CÔTÉ CLIENT — authentification et accès à son propre dossier uniquement
// ============================================================
const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
});

function signClientToken(account) {
  return jwt.sign(
    { sub: account.client_id, accountId: account.id, aud: 'client-portal' },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

// Middleware dédié : vérifie un token de PORTAIL CLIENT, distinct des tokens
// collaborateurs (aud: 'client-portal') — un token staff ne peut pas être
// réutilisé ici, et inversement.
function requireClientAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.aud !== 'client-portal') return res.status(401).json({ error: 'Jeton invalide pour cette route' });
    req.clientId = payload.sub;
    req.accountId = payload.accountId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  }
}

router.post('/portal/login', portalLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { rows } = await db.query(
    `SELECT ca.*, c.prenom, c.nom FROM client_accounts ca
     JOIN clients c ON c.id = ca.client_id
     WHERE ca.email = $1`,
    [email.toLowerCase().trim()]
  );
  const account = rows[0];
  const validPwd = account ? await verifyPassword(password, account.pwd_hash) : await verifyPassword(password, '$2a$12$invalidsaltinvalidsaltinvalidsal');

  if (!account || !validPwd) {
    await logAudit(null, 'portail_login_echec', 'client_account', null, `Tentative échouée pour ${email}`, req.ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (account.statut === 'suspendu' || account.statut === 'ferme') {
    return res.status(403).json({ error: 'Cet accès a été suspendu par AFRILEX. Contactez votre conseiller.' });
  }

  await db.query('UPDATE client_accounts SET dernier_login = now() WHERE id = $1', [account.id]);
  await logAudit(null, 'portail_login', 'client', account.client_id, null, req.ip);

  res.json({
    accessToken: signClientToken(account),
    client: { prenom: account.prenom, nom: account.nom, email: account.email, statut: account.statut },
  });
});

router.post('/portal/change-password', requireClientAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 8) return res.status(400).json({ error: '8 caractères minimum' });

  const { rows } = await db.query('SELECT pwd_hash, statut FROM client_accounts WHERE id = $1', [req.accountId]);
  if (!rows[0]) return res.status(404).json({ error: 'Compte introuvable' });
  if (rows[0].statut === 'lecture_seule') return res.status(403).json({ error: 'Accès en lecture seule' });

  const ok = await verifyPassword(currentPassword, rows[0].pwd_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

  const newHash = await hashPassword(newPassword);
  await db.query('UPDATE client_accounts SET pwd_hash = $1 WHERE id = $2', [newHash, req.accountId]);
  await logAudit(null, 'portail_changement_mdp', 'client', req.clientId, null, req.ip);
  res.json({ ok: true });
});

router.get('/portal/me', requireClientAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.ref, c.civilite, c.prenom, c.nom, c.email, c.telephone, c.statut_dossier,
            ca.statut AS statut_portail
     FROM clients c JOIN client_accounts ca ON ca.client_id = c.id
     WHERE c.id = $1`,
    [req.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Dossier introuvable' });
  res.json(rows[0]);
});

// Vue simplifiée du dossier : mandats liés au client, lecture seule.
// (Table mandats déjà en base — pas encore de route CRUD staff dédiée,
// ajoutée en V0.2 ; en attendant, lecture directe ici pour le portail.)
router.get('/portal/dossier', requireClientAuth, async (req, res) => {
  const { rows: mandats } = await db.query(
    `SELECT ref, type, pays, ville, statut, date_debut, resiliation_motif, resiliation_date
     FROM mandats WHERE client_id = $1 AND supprime_le IS NULL ORDER BY cree_le DESC`,
    [req.clientId]
  );
  res.json({ mandats });
});

// ============================================================
// DOCUMENTS DU CLIENT — dépôt et consultation de ses propres pièces
// uniquement (entity_type/entity_id forcés côté serveur, jamais fournis
// par le client, pour empêcher tout accès à un autre dossier).
// ============================================================
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const clientUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(20).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(ALLOWED_MIME.has(file.mimetype) ? null : new Error('Type de fichier non autorisé'), ALLOWED_MIME.has(file.mimetype)),
});

function handleClientUpload(req, res, next) {
  clientUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/portal/documents', requireClientAuth, handleClientUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const { rows } = await db.query(
      `INSERT INTO documents (entity_type, entity_id, nom_fichier, chemin, categorie, mime, taille_octets)
       VALUES ('client', $1, $2, $3, $4, $5, $6) RETURNING id, nom_fichier, categorie, cree_le`,
      [req.clientId, req.file.originalname, req.file.filename, req.body.categorie || 'Déposé par le client', req.file.mimetype, req.file.size]
    );
    await logAudit(null, 'document_depose_client', 'client', req.clientId, req.file.originalname, req.ip);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    res.status(400).json({ error: e.message });
  }
});

router.get('/portal/documents', requireClientAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, nom_fichier, categorie, mime, taille_octets, cree_le FROM documents
     WHERE entity_type = 'client' AND entity_id = $1 AND supprime_le IS NULL ORDER BY cree_le DESC`,
    [req.clientId]
  );
  res.json(rows);
});

router.get('/portal/documents/:id/download', requireClientAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM documents WHERE id = $1 AND entity_type = 'client' AND entity_id = $2 AND supprime_le IS NULL`,
    [req.params.id, req.clientId]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document introuvable' });
  const filePath = path.join(UPLOAD_DIR, doc.chemin);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Fichier indisponible' });
  res.download(filePath, doc.nom_fichier);
});

// ============================================================
// PORTAIL PARTENAIRE — même principe que le portail client, pour les
// apporteurs d'affaires, banques partenaires, notaires, etc.
// ============================================================
function signPartnerToken(account) {
  return jwt.sign(
    { sub: account.partenaire_id, accountId: account.id, aud: 'partner-portal' },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

function requirePartnerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.aud !== 'partner-portal') return res.status(401).json({ error: 'Jeton invalide pour cette route' });
    req.partenaireId = payload.sub;
    req.accountId = payload.accountId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  }
}

// Staff : créer/réinitialiser l'accès portail d'un partenaire
router.post('/partenaires/:id/portal', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const { rows: pRows } = await db.query('SELECT id, email, organisation FROM partenaires WHERE id = $1 AND supprime_le IS NULL', [req.params.id]);
  const partenaire = pRows[0];
  if (!partenaire) return res.status(404).json({ error: 'Partenaire introuvable' });
  if (!partenaire.email) return res.status(400).json({ error: "Le partenaire n'a pas d'adresse e-mail renseignée" });

  const tempPassword = genTempPassword();
  const pwdHash = await hashPassword(tempPassword);
  const { rows } = await db.query(
    `INSERT INTO partner_accounts (partenaire_id, email, pwd_hash, statut)
     VALUES ($1, $2, $3, 'actif')
     ON CONFLICT (partenaire_id) DO UPDATE SET email = $2, pwd_hash = $3, statut = 'actif'
     RETURNING id, email, statut, cree_le`,
    [partenaire.id, partenaire.email, pwdHash]
  );
  await logAudit(req.user.id, 'portail_partenaire_cree', 'partenaire', partenaire.id, `Portail créé/réinitialisé pour ${partenaire.email}`, req.ip);
  res.status(201).json({ ok: true, account: rows[0], tempPassword, message: 'Communiquez ce mot de passe temporaire au partenaire.' });
});

router.patch('/partenaires/:id/portal/status', requireAuth, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }
  const { statut } = req.body || {};
  if (!['actif', 'suspendu', 'lecture_seule', 'ferme'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  const { rows } = await db.query('UPDATE partner_accounts SET statut = $1 WHERE partenaire_id = $2 RETURNING *', [statut, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Aucun portail pour ce partenaire' });
  await logAudit(req.user.id, 'portail_partenaire_statut', 'partenaire', req.params.id, `→ ${statut}`, req.ip);
  res.json(rows[0]);
});

// Partenaire : connexion
router.post('/partner-portal/login', portalLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { rows } = await db.query(
    `SELECT pa.*, p.organisation FROM partner_accounts pa
     JOIN partenaires p ON p.id = pa.partenaire_id
     WHERE pa.email = $1`,
    [email.toLowerCase().trim()]
  );
  const account = rows[0];
  const validPwd = account ? await verifyPassword(password, account.pwd_hash) : await verifyPassword(password, '$2a$12$invalidsaltinvalidsaltinvalidsal');

  if (!account || !validPwd) {
    await logAudit(null, 'portail_partenaire_login_echec', 'partner_account', null, `Tentative échouée pour ${email}`, req.ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (account.statut === 'suspendu' || account.statut === 'ferme') {
    return res.status(403).json({ error: 'Cet accès a été suspendu par AFRILEX. Contactez votre interlocuteur.' });
  }

  await db.query('UPDATE partner_accounts SET dernier_login = now() WHERE id = $1', [account.id]);
  await logAudit(null, 'portail_partenaire_login', 'partenaire', account.partenaire_id, null, req.ip);

  res.json({
    accessToken: signPartnerToken(account),
    partenaire: { organisation: account.organisation, email: account.email, statut: account.statut },
  });
});

router.post('/partner-portal/change-password', requirePartnerAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 8) return res.status(400).json({ error: '8 caractères minimum' });

  const { rows } = await db.query('SELECT pwd_hash, statut FROM partner_accounts WHERE id = $1', [req.accountId]);
  if (!rows[0]) return res.status(404).json({ error: 'Compte introuvable' });
  if (rows[0].statut === 'lecture_seule') return res.status(403).json({ error: 'Accès en lecture seule' });

  const ok = await verifyPassword(currentPassword, rows[0].pwd_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

  const newHash = await hashPassword(newPassword);
  await db.query('UPDATE partner_accounts SET pwd_hash = $1 WHERE id = $2', [newHash, req.accountId]);
  await logAudit(null, 'portail_partenaire_changement_mdp', 'partenaire', req.partenaireId, null, req.ip);
  res.json({ ok: true });
});

router.get('/partner-portal/me', requirePartnerAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.ref, p.organisation, p.contact, p.email, p.telephone, p.type, pa.statut AS statut_portail
     FROM partenaires p JOIN partner_accounts pa ON pa.partenaire_id = p.id
     WHERE p.id = $1`,
    [req.partenaireId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Profil introuvable' });
  res.json(rows[0]);
});

// Vue des mandats où ce partenaire est impliqué (banque ou apporteur), avec
// la commission associée — jamais le montant total du mandat ni les données
// du client au-delà du strict nécessaire (confidentialité).
router.get('/partner-portal/mandats', requirePartnerAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.ref, m.type, m.pays, m.statut, m.partenaire_role,
            CASE WHEN m.partenaire_role = 'banque' THEN m.commission_pct ELSE NULL END AS commission_pct
     FROM mandats m
     WHERE m.partenaire_id = $1 AND m.supprime_le IS NULL ORDER BY m.cree_le DESC`,
    [req.partenaireId]
  );
  res.json({ mandats: rows });
});

module.exports = router;
