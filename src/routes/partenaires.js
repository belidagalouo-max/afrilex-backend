const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const partenaireSchema = z.object({
  organisation: z.string().min(1).max(200),
  contact: z.string().max(150).optional().nullable(),
  email: z.string().email().optional().nullable(),
  telephone: z.string().max(50).optional().nullable(),
  type: z.enum(['bancaire', 'apporteur', 'association', 'promoteur', 'agence', 'notaire', 'autre']).default('autre'),
  pays: z.string().max(100).optional().nullable(),
  commission_apporteur_pct: z.number().min(0).max(100).optional(),
  commission_partenaire_pct: z.number().min(0).max(100).optional(),
  notes: z.string().optional().nullable(),
});

async function nextPartenaireRef() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM partenaires");
  return 'PAR-' + String(rows[0].n + 1).padStart(4, '0');
}

router.get('/', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM partenaires WHERE supprime_le IS NULL ORDER BY cree_le DESC');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM partenaires WHERE id = $1 AND supprime_le IS NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Partenaire introuvable' });
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const parsed = partenaireSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const d = parsed.data;
  const ref = await nextPartenaireRef();
  const { rows } = await db.query(
    `INSERT INTO partenaires (ref, organisation, contact, email, telephone, type, pays, commission_apporteur_pct, commission_partenaire_pct, notes, cree_par)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ref, d.organisation, d.contact, d.email, d.telephone, d.type, d.pays, d.commission_apporteur_pct ?? 0, d.commission_partenaire_pct ?? 0, d.notes, req.user.id]
  );
  await logAudit(req.user.id, 'partenaire_cree', 'partenaire', rows[0].id, d.organisation, req.ip);
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const parsed = partenaireSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const fields = Object.keys(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'Aucun champ à modifier' });
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => parsed.data[f]);
  const { rows } = await db.query(
    `UPDATE partenaires SET ${setClause} WHERE id = $1 AND supprime_le IS NULL RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Partenaire introuvable' });
  await logAudit(req.user.id, 'partenaire_modifie', 'partenaire', req.params.id, fields.join(','), req.ip);
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE partenaires SET supprime_le = now() WHERE id = $1 AND supprime_le IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Partenaire introuvable' });
  await logAudit(req.user.id, 'partenaire_corbeille', 'partenaire', req.params.id, null, req.ip);
  res.json({ ok: true });
});

router.post('/:id/restore', async (req, res) => {
  const { rows } = await db.query('UPDATE partenaires SET supprime_le = NULL WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Partenaire introuvable' });
  await logAudit(req.user.id, 'partenaire_restaure', 'partenaire', req.params.id, null, req.ip);
  res.json(rows[0]);
});

module.exports = router;
