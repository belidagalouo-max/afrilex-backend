// seed.js — ne cree AUCUN compte par defaut.
// Les utilisateurs sont crees depuis le CRM AFRILEX directement.
// Ce script verifie uniquement que les migrations sont appliquees.
async function seed() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as n FROM users");
    console.log(`✅ Base de donnees OK — ${rows[0].n} utilisateur(s) enregistre(s)`);
    console.log('ℹ️  Les comptes sont geres depuis le CRM AFRILEX (aucun compte cree par defaut).');
  } catch(e) {
    console.log('⚠️  Table users non trouvee — lancez npm run migrate d abord');
  } finally {
    await pool.end();
  }
}
seed().catch(err => { console.error('❌', err.message); process.exit(1); });
