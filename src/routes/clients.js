const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const clientSchema = z.object({
  civilite: z.string().max(10).optional().nullable(),
  prenom: z.string().min(1).max(100),
  nom: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  telephone: z.string().max(50).optional().nullable(),
  adresse: z.string().optional().nullable(),
  nationalite: z.string().max(100).optional().nullable(),
  date_naissance: z.string().optional().nullable(),
  piece_identite: z.string().max(100).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

async function nextClientRef() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM clients");
  return 'CLI-' + String(rows[0].n + 1).padStart(4, '0');
}

// Liste — RBAC : consultant ne voit que ses dossiers assignés, admin/manager voient tout.
router.get('/', async (req, res) => {
  const scoped = !['admin', 'manager'].includes(req.user.role);
  const params = [];
  let where = 'WHERE supprime_le IS NULL';
  if (scoped) { params.push(req.user.id); where += ` AND assigned_to = $${params.length}`; }
  const { rows } = await db.query(`SELECT * FROM clients ${where} ORDER BY cree_le DESC`, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1 AND supprime_le IS NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  const scoped = !['admin', 'manager'].includes(req.user.role);
  if (scoped && rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ error: "Vous n'avez pas accès à ce dossier" });
  }
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const d = parsed.data;
  const ref = await nextClientRef();
  const { rows } = await db.query(
    `INSERT INTO clients (ref, civilite, prenom, nom, email, telephone, adresse, nationalite,
       date_naissance, piece_identite, assigned_to, notes, cree_par)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [ref, d.civilite, d.prenom, d.nom, d.email, d.telephone, d.adresse, d.nationalite,
     d.date_naissance || null, d.piece_identite, d.assigned_to || null, d.notes, req.user.id]
  );
  await logAudit(req.user.id, 'client_cree', 'client', rows[0].id, `${d.prenom} ${d.nom}`, req.ip);
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const fields = Object.keys(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'Aucun champ à modifier' });
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => parsed.data[f]);
  const { rows } = await db.query(
    `UPDATE clients SET ${setClause}, maj_le = now() WHERE id = $1 AND supprime_le IS NULL RETURNING *`,
    [req.params.id, ...values]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  await logAudit(req.user.id, 'client_modifie', 'client', req.params.id, fields.join(','), req.ip);
  res.json(rows[0]);
});

// Suppression douce — jamais de DELETE physique depuis l'API (cf. corbeille du CRM HTML).
router.delete('/:id', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE clients SET supprime_le = now() WHERE id = $1 AND supprime_le IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  await logAudit(req.user.id, 'client_corbeille', 'client', req.params.id, null, req.ip);
  res.json({ ok: true });
});

router.post('/:id/restore', async (req, res) => {
  const { rows } = await db.query(
    'UPDATE clients SET supprime_le = NULL WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  await logAudit(req.user.id, 'client_restaure', 'client', req.params.id, null, req.ip);
  res.json(rows[0]);
});

module.exports = router;
