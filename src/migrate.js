const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_saisines.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration appliquee');
  await pool.end();
}

migrate().catch(e => { console.error(e.message); process.exit(1); });
