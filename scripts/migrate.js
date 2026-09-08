// Applique migrations/001_init.sql (et suivantes) dans l'ordre alphabétique.
// Usage : node scripts/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_le TIMESTAMPTZ DEFAULT now())`);
  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [file]);
    if (rows.length) {
      console.log(`⏭  ${file} déjà appliquée`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`▶  Application de ${file}...`);
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
    console.log(`✅ ${file} appliquée`);
  }
  await pool.end();
}

migrate().catch(err => {
  console.error('❌ Échec de la migration :', err.message);
  process.exit(1);
});
