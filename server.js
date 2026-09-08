const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(express.json({ limit: '5mb' }));
app.use(cors({ origin: '*' }));
const limit = rateLimit({ windowMs: 60000, max: 60 });

app.get('/health', (req, res) => res.json({ ok: true }));

// Init tables
pool.query(`
  CREATE TABLE IF NOT EXISTS saisines (
    id SERIAL PRIMARY KEY, ref TEXT, type TEXT, nom TEXT,
    email TEXT, telephone TEXT, pays TEXT, message TEXT,
    recu_le TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS portail_acces (
    id SERIAL PRIMARY KEY,
    client_id TEXT UNIQUE,
    client_nom TEXT,
    email TEXT,
    pwd TEXT,
    statut TEXT DEFAULT 'actif',
    motif_fermeture TEXT,
    cree_le TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS portail_messages (
    id SERIAL PRIMARY KEY, client_id TEXT, expediteur TEXT,
    message TEXT, lu BOOLEAN DEFAULT false,
    envoye_le TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS portail_documents (
    id SERIAL PRIMARY KEY, client_id TEXT, client_nom TEXT,
    nom_fichier TEXT, type_fichier TEXT, data TEXT,
    lu BOOLEAN DEFAULT false,
    envoye_le TIMESTAMPTZ DEFAULT now()
  );
`).catch(e => console.error(e.message));

// ===== SAISINES =====
app.post('/saisines', limit, async (req, res) => {
  const { type, nom, email, telephone, pays, message } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requis' });
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM saisines');
  const ref = 'SAI-' + String(parseInt(rows[0].n) + 1).padStart(4, '0');
  await pool.query('INSERT INTO saisines (ref,type,nom,email,telephone,pays,message) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [ref, type||'info', nom||'', email, telephone||'', pays||'', message||'']);
  res.status(201).json({ ok: true, ref });
});

app.get('/saisines', limit, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM saisines ORDER BY recu_le DESC');
  res.json(rows);
});

// ===== PORTAIL ACCES =====
// CRM cree ou met a jour un acces portail
app.post('/portail/acces', limit, async (req, res) => {
  const { client_id, client_nom, email, pwd, statut, motif_fermeture } = req.body || {};
  if (!client_id || !email || !pwd) return res.status(400).json({ error: 'Champs requis' });
  await pool.query(`
    INSERT INTO portail_acces (client_id, client_nom, email, pwd, statut, motif_fermeture)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (client_id) DO UPDATE SET
      client_nom=EXCLUDED.client_nom, email=EXCLUDED.email,
      pwd=EXCLUDED.pwd, statut=EXCLUDED.statut, motif_fermeture=EXCLUDED.motif_fermeture
  `, [client_id, client_nom||'', email, pwd, statut||'actif', motif_fermeture||null]);
  res.status(201).json({ ok: true });
});

// Portail client se connecte
app.post('/portail/login', limit, async (req, res) => {
  const { email, pwd } = req.body || {};
  if (!email || !pwd) return res.status(400).json({ error: 'Email et mot de passe requis' });
  const { rows } = await pool.query('SELECT * FROM portail_acces WHERE LOWER(email)=$1 AND pwd=$2', [email.toLowerCase(), pwd]);
  if (!rows.length) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const acces = rows[0];
  if (acces.statut !== 'actif') return res.status(403).json({ error: 'Acces ferme', motif: acces.motif_fermeture });
  res.json({ ok: true, client_id: acces.client_id, client_nom: acces.client_nom, email: acces.email });
});

// Client change son mot de passe
app.patch('/portail/pwd', limit, async (req, res) => {
  const { client_id, ancien_pwd, nouveau_pwd } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM portail_acces WHERE client_id=$1 AND pwd=$2', [client_id, ancien_pwd]);
  if (!rows.length) return res.status(401).json({ error: 'Mot de passe incorrect' });
  await pool.query('UPDATE portail_acces SET pwd=$1 WHERE client_id=$2', [nouveau_pwd, client_id]);
  res.json({ ok: true });
});

// ===== MESSAGES =====
app.post('/portail/messages', limit, async (req, res) => {
  const { client_id, expediteur, message } = req.body || {};
  if (!client_id || !message) return res.status(400).json({ error: 'Champs requis' });
  await pool.query('INSERT INTO portail_messages (client_id, expediteur, message) VALUES ($1,$2,$3)',
    [client_id, expediteur||'Client', message]);
  res.status(201).json({ ok: true });
});

app.get('/portail/messages/:client_id', limit, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM portail_messages WHERE client_id=$1 ORDER BY envoye_le ASC', [req.params.client_id]);
  res.json(rows);
});

app.get('/portail/messages', limit, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM portail_messages WHERE lu=false AND expediteur != $1 ORDER BY envoye_le DESC', ['AFRILEX']);
  res.json(rows);
});

app.patch('/portail/messages/:id/lu', limit, async (req, res) => {
  await pool.query('UPDATE portail_messages SET lu=true WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ===== DOCUMENTS =====
app.post('/portail/documents', limit, async (req, res) => {
  const { client_id, client_nom, nom_fichier, type_fichier, data } = req.body || {};
  if (!client_id || !nom_fichier) return res.status(400).json({ error: 'Champs requis' });
  await pool.query('INSERT INTO portail_documents (client_id, client_nom, nom_fichier, type_fichier, data) VALUES ($1,$2,$3,$4,$5)',
    [client_id, client_nom||'', nom_fichier, type_fichier||'', data||'']);
  res.status(201).json({ ok: true });
});

app.get('/portail/documents', limit, async (req, res) => {
  const { rows } = await pool.query('SELECT id, client_id, client_nom, nom_fichier, type_fichier, lu, envoye_le FROM portail_documents WHERE lu=false ORDER BY envoye_le DESC');
  res.json(rows);
});

app.patch('/portail/documents/:id/lu', limit, async (req, res) => {
  await pool.query('UPDATE portail_documents SET lu=true WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 4000, () => console.log('Demarre'));
