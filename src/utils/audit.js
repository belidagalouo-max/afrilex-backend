const db = require('../db');

async function logAudit(userId, action, cibleType, cibleId, details, ip) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, cible_type, cible_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, cibleType, cibleId, details, ip]
    );
  } catch (e) {
    // Le journal d'audit ne doit jamais faire planter la requête principale,
    // mais une erreur ici est sérieuse : on la log bruyamment côté serveur.
    console.error('⚠️  Échec écriture audit_log :', e.message);
  }
}

module.exports = { logAudit };
