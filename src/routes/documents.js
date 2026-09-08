const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ⚠️ LIMITE HONNÊTE : stockage sur disque local. Fonctionne pour tester,
// mais sur la plupart des hébergeurs (dont Railway en configuration standard)
// le système de fichiers est éphémère : les fichiers uploadés disparaissent
// au redéploiement/redémarrage du service. Pour une vraie mise en production,
// il faut brancher un stockage objet (S3, Cloudflare R2, Scaleway Object
// Storage — voir afrilex-backend-architecture.md, section 2).
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip', 'video/mp4', 'video/quicktime',
]);
const MAX_SIZE = 25 * 1024 * 1024; // 25 Mo

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Renommage systématique : évite les collisions ET empêche l'exécution
    // accidentelle d'un nom de fichier malveillant (../, .php déguisé, etc.)
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, crypto.randomBytes(20).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Type de fichier non autorisé'));
    }
    cb(null, true);
  },
});

const ENTITY_TYPES = ['client', 'mandat', 'partenaire'];

// Vérifie que l'utilisateur staff a le droit de voir/modifier les documents
// de cette entité (même règle RBAC que le reste : consultant borné à ses
// dossiers assignés).
async function checkEntityAccess(req, entityType, entityId) {
  if (['admin', 'manager'].includes(req.user.role)) return true;
  if (entityType === 'client') {
    const { rows } = await db.query('SELECT assigned_to FROM clients WHERE id = $1', [entityId]);
    return rows[0] && rows[0].assigned_to === req.user.id;
  }
  if (entityType === 'mandat') {
    const { rows } = await db.query('SELECT assigned_to FROM mandats WHERE id = $1', [entityId]);
    return rows[0] && rows[0].assigned_to === req.user.id;
  }
  return true; // partenaires : pas d'assignation individuelle pour l'instant
}

router.use(requireAuth);

// multer déclenche son erreur AVANT le handler de route (dans son propre
// middleware) — on l'intercepte ici pour renvoyer un 400 propre plutôt que
// de laisser tomber sur le handler d'erreur générique (500).
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/', handleUpload, async (req, res) => {
  try {
    const { entity_type, entity_id, categorie, groupe_id } = req.body;
    if (!ENTITY_TYPES.includes(entity_type)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'entity_type invalide' });
    }
    if (!(await checkEntityAccess(req, entity_type, entity_id))) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: "Vous n'avez pas accès à cette fiche" });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    let version = 1;
    let finalGroupeId = groupe_id || crypto.randomUUID();
    if (groupe_id) {
      const { rows } = await db.query('SELECT MAX(version) AS v FROM documents WHERE groupe_id = $1', [groupe_id]);
      version = (rows[0].v || 0) + 1;
    }

    const { rows } = await db.query(
      `INSERT INTO documents (entity_type, entity_id, groupe_id, version, nom_fichier, chemin, categorie, mime, taille_octets, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [entity_type, entity_id, finalGroupeId, version, req.file.originalname, req.file.filename, categorie || 'Autre', req.file.mimetype, req.file.size, req.user.id]
    );
    await logAudit(req.user.id, 'document_ajoute', entity_type, entity_id, `${req.file.originalname} (v${version})`, req.ip);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    res.status(400).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!ENTITY_TYPES.includes(entity_type) || !entity_id) {
    return res.status(400).json({ error: 'entity_type et entity_id requis' });
  }
  if (!(await checkEntityAccess(req, entity_type, entity_id))) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette fiche" });
  }
  const { rows } = await db.query(
    `SELECT * FROM documents WHERE entity_type = $1 AND entity_id = $2 AND supprime_le IS NULL ORDER BY groupe_id, version DESC`,
    [entity_type, entity_id]
  );
  res.json(rows);
});

router.get('/:id/download', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND supprime_le IS NULL', [req.params.id]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document introuvable' });
  if (!(await checkEntityAccess(req, doc.entity_type, doc.entity_id))) {
    return res.status(403).json({ error: "Vous n'avez pas accès à ce document" });
  }
  const filePath = path.join(UPLOAD_DIR, doc.chemin);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Fichier absent du stockage (probablement supprimé lors dun redéploiement — voir limite de stockage éphémère)' });
  await logAudit(req.user.id, 'document_telecharge', doc.entity_type, doc.entity_id, doc.nom_fichier, req.ip);
  res.download(filePath, doc.nom_fichier);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE documents SET supprime_le = now() WHERE id = $1 AND supprime_le IS NULL RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Document introuvable' });
  await logAudit(req.user.id, 'document_corbeille', rows[0].entity_type, rows[0].entity_id, rows[0].nom_fichier, req.ip);
  res.json({ ok: true });
});

router.post('/:id/restore', async (req, res) => {
  const { rows } = await db.query('UPDATE documents SET supprime_le = NULL WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Document introuvable' });
  await logAudit(req.user.id, 'document_restaure', rows[0].entity_type, rows[0].entity_id, rows[0].nom_fichier, req.ip);
  res.json(rows[0]);
});

module.exports = router;
