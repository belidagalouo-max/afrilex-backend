const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// Base de donnees
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// CORS : uniquement afrilexsites.netlify.app
app.use(cors({
  origin: ['https://afrilexsites.netlify.app', 'https://www.afrilex.fr'],
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

// Limite : 20 requetes par minute pour eviter le spam
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

// Sante du serveur
app.get('/health', (req, res) => res.json({ ok: true }));

// Reception des saisines depuis afrilexsites.netlify.app
app.post('/saisines', limiter, async (req, res) => {
  const b = req.body || {};

  // Champs attendus (tous optionnels sauf email)
  const type      = String(b.type || 'info').slice(0, 30);
  const nom       = String(b.nom || '').slice(0, 200);
  const email     = String(b.email || '').slice(0, 255);
  const telephone = String(b.telephone || '').slice(0, 50);
  const pays      = String(b.pays || '').slice(0, 100);
  const message   = String(b.message || '').slice(0, 4000);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email requis' });
  }

  // Reference unique
  const { rows: cnt } = await pool.query('SELECT COUNT(*) AS n FROM saisines');
  const ref = 'SAI-' + String(parseInt(cnt[0].n) + 1).padStart(4, '0');

  await pool.query(
    `INSERT INTO saisines (ref, type, nom, email, telephone, pays, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ref, type, nom, email, telephone, pays, message]
  );

  res.status(201).json({ ok: true, ref });
});

// Lecture des saisines depuis le CRM (GET)
app.get('/saisines', limiter, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM saisines ORDER BY recue_le DESC LIMIT 500'
  );
  res.json(rows);
});

// Marquer une saisine comme traitee
app.patch('/saisines/:id/traitee', limiter, async (req, res) => {
  await pool.query('UPDATE saisines SET traitee = true WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Serveur AFRILEX demarre sur le port ' + PORT));
