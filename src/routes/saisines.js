const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ============================================================
// ROUTE PUBLIQUE — c'est celle-ci que le formulaire de www.afrilex.fr
// (ou afrilexsites.netlify.app) doit appeler en POST. Aucune authentification
// (c'est un visiteur anonyme du site), mais : validation stricte des champs,
// et rate-limiting pour éviter le spam/l'abus.
// ============================================================
const saisineLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 20, // 20 soumissions / heure / IP — ajustable
  message: { error: 'Trop de soumissions depuis cette adresse. Réessayez plus tard.' },
});

const saisineSchema = z.object({
  type: z.enum(['projet', 'financement', 'partenariat', 'reclamation', 'mediation', 'info']).default('info'),
  nom: z.string().min(1).max(150),
  email: z.string().email().max(255),
  telephone: z.string().max(50).optional().nullable(),
  pays: z.string().max(100).optional().nullable(),
  message: z.string().max(5000).optional().nullable(),
  source: z.string().max(100).optional(),
});

async function nextSaisineRef() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM saisines");
  return 'SAI-' + String(rows[0].n + 1).padStart(4, '0');
}

router.post('/public/saisines', saisineLimiter, async (req, res) => {
  const parsed = saisineSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const ref = await nextSaisineRef();

  const { rows } = await db.query(
    `INSERT INTO saisines (ref, type, nom, email, telephone, pays, message, source, ip_origine)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ref, cree_le`,
    [ref, d.type, d.nom, d.email, d.telephone || null, d.pays || null, d.message || null, d.source || 'Site web', req.ip]
  );

  await logAudit(null, 'saisine_recue', 'saisine', rows[0].id, `${d.type} — ${d.nom} (${d.email})`, req.ip);

  // Le site n'a pas besoin de connaître les détails internes : juste une
  // confirmation que c'est bien arrivé, avec la référence pour son suivi.
  res.status(201).json({ ok: true, ref: rows[0].ref });
});

// ============================================================
// ROUTES PROTÉGÉES — utilisées par le CRM (collaborateurs authentifiés)
// ============================================================
router.get('/saisines', requireAuth, async (req, res) => {
  const { statut, type } = req.query;
  const conditions = [];
  const params = [];
  if (statut) { params.push(statut); conditions.push(`statut = $${params.length}`); }
  if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await db.query(
    `SELECT * FROM saisines ${where} ORDER BY cree_le DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

router.patch('/saisines/:id/statut', requireAuth, async (req, res) => {
  const { statut } = req.body || {};
  if (!['nouveau', 'traite', 'archive'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  const { rows } = await db.query(
    'UPDATE saisines SET statut = $1 WHERE id = $2 RETURNING *',
    [statut, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Saisine introuvable' });
  await logAudit(req.user.id, 'saisine_statut', 'saisine', req.params.id, `→ ${statut}`, req.ip);
  res.json(rows[0]);
});

module.exports = router;
