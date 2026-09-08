const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const mandatSchema = z.object({
  client_id: z.string().uuid(),
  type: z.enum(['terrain', 'construction', 'gestion', 'juridique', 'locatif', 'autre']).default('autre'),
  pays: z.string().max(100).optional().nullable(),
  ville: z.string().max(100).optional().nullable(),
  budget: z.number().optional().nullable(),
  commission_pct: z.number().min(0).max(100).optional(),
  date_debut: z.string().optional().nullable(),
  duree: z.string().max(50).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
});

async function nextMandatRef() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM mandats");
  return 'MAN-' + String(rows[0].n + 1).padStart(4, '0');
}

function scopeClause(req, params) {
  const scoped = !['admin', 'manager'].includes(req.user.role);
  if (!scoped) return { where: '', params };
  params.push(req.user.id);
  return { where: ` AND m.assigned_to = $${params.length}`, params };
}

router.get('/', async (req, res) => {
  const params = [];
  const { where } = scopeClause(req, params);
  const { rows } = await db.query(
    `SELECT m.*, c.prenom AS client_prenom, c.nom AS client_nom, c.ref AS client_ref
     FROM mandats m JOIN clients c ON c.id = m.client_id
     WHERE m.supprime_le IS NULL ${where} ORDER BY m.cree_le DESC`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.*, c.prenom AS client_prenom, c.nom AS client_nom, c.ref AS client_ref
     FROM mandats m JOIN clients c ON c.id = m.client_id
     WHERE m.id = $1 AND m.supprime_le IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mandat introuvable' });
  const scoped = !['admin', 'manager'].includes(req.user.role);
  if (scoped && rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ error: "Vous n'avez pas accès à ce mandat" });
  }
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const parsed = mandatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const d = parsed.data;

  const { rows: clientRows } = await db.query('SELECT id FROM clients WHERE id = $1 AND supprime_le IS NULL', [d.client_id]);
  if (!clientRows[0]) return res.status(400).json({ error: 'Client introuvable' });

  const ref = await nextMandatRef();
  const { rows } = await db.query(
    `INSERT INTO mandats (ref, client_id, type, pays, ville, budget, commission_pct, date_debut, duree, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ref, d.client_id, d.type, d.pays, d.ville, d.budget || null, d.commission_pct ?? 7, d.date_debut || null, d.duree, d.assigned_to || null]
  );
  await logAudit(req.user.id, 'mandat_cree', 'mandat', rows[0].id, `${ref} — ${d.type}`, req.ip);
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const parsed = mandatSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const fields = Object.keys(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'Aucun champ à modifier' });
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => parsed.data[f]);
  const { rows } = await db.query(
    `UPDATE mandats SET ${setClause} WHERE id = $1 AND supprime_le IS NULL RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mandat introuvable' });
  await logAudit(req.user.id, 'mandat_modifie', 'mandat', req.params.id, fields.join(','), req.ip);
  res.json(rows[0]);
});

// Statuts pilotés : en_cours → signe → termine, ou suspendu/resilie à tout moment.
router.patch('/:id/statut', async (req, res) => {
  const { statut, resiliation_motif, resiliation_date } = req.body || {};
  if (!['en_cours', 'signe', 'suspendu', 'resilie', 'termine'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  if (statut === 'resilie' && !resiliation_motif) {
    return res.status(400).json({ error: 'Le motif de résiliation est requis' });
  }
  const { rows } = await db.query(
    `UPDATE mandats SET statut = $1, resiliation_motif = $2, resiliation_date = $3
     WHERE id = $4 AND supprime_le IS NULL RETURNING *`,
    [statut, statut === 'resilie' ? resiliation_motif : null, statut === 'resilie' ? (resiliation_date || new Date().toISOString().split('T')[0]) : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mandat introuvable' });
  await logAudit(req.user.id, 'mandat_statut', 'mandat', req.params.id, `→ ${statut}${resiliation_motif ? ' (' + resiliation_motif + ')' : ''}`, req.ip);
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE mandats SET supprime_le = now() WHERE id = $1 AND supprime_le IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mandat introuvable' });
  await logAudit(req.user.id, 'mandat_corbeille', 'mandat', req.params.id, null, req.ip);
  res.json({ ok: true });
});

router.post('/:id/restore', async (req, res) => {
  const { rows } = await db.query('UPDATE mandats SET supprime_le = NULL WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Mandat introuvable' });
  await logAudit(req.user.id, 'mandat_restaure', 'mandat', req.params.id, null, req.ip);
  res.json(rows[0]);
});

module.exports = router;
