const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ============================================================
// WEBHOOK NETLIFY FORMS — pont entre afrilexsites.netlify.app et le CRM
// ============================================================
// Aucune modification du site n'est nécessaire : Netlify Forms capte déjà
// les 6 formulaires (Nouveau projet, Financement, Partenariat, Réclamation,
// Médiation, Info) automatiquement, car ils sont hébergés sur Netlify.
// Il suffit d'ajouter UNE notification sortante dans le tableau de bord
// Netlify (Site settings → Forms → Form notifications → Outgoing webhook)
// pointant vers : POST https://<votre-domaine-backend>/public/webhooks/netlify-forms
//
// Format du payload envoyé par Netlify (variable selon les noms de champs
// réels du formulaire — ce mapper essaie plusieurs variantes courantes) :
// { form_name, email, created_at, data: { ...champs du formulaire... } }

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 }); // 60/min — Netlify peut relayer plusieurs formulaires

// Un même site Netlify peut avoir plusieurs formulaires (un par onglet) ;
// on déduit le type de saisine à partir du nom du formulaire Netlify.
// ⚠️ À ajuster si les noms réels des formulaires diffèrent (dis-moi les noms
// exacts si ce mapping ne correspond pas, ou je peux le rendre configurable).
function inferSaisineType(formName) {
  const n = (formName || '').toLowerCase();
  if (n.includes('financ')) return 'financement';
  if (n.includes('partena')) return 'partenariat';
  if (n.includes('reclam')) return 'reclamation';
  if (n.includes('mediat')) return 'mediation';
  if (n.includes('projet') || n.includes('contact')) return 'projet';
  return 'info';
}

// Les formulaires n'utilisent pas forcément les mêmes noms de champs —
// on cherche plusieurs variantes plausibles pour chaque information.
function pick(data, ...keys) {
  for (const k of keys) {
    if (data[k] !== undefined && data[k] !== '') return data[k];
    // essaie aussi une version insensible à la casse / underscores
    const found = Object.keys(data).find(dk => dk.toLowerCase().replace(/[\s_-]/g, '') === k.toLowerCase().replace(/[\s_-]/g, ''));
    if (found && data[found] !== '') return data[found];
  }
  return null;
}

async function nextSaisineRef() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM saisines");
  return 'SAI-' + String(rows[0].n + 1).padStart(4, '0');
}

router.post('/public/webhooks/netlify-forms', webhookLimiter, async (req, res) => {
  const payload = req.body || {};
  const data = payload.data || payload.payload?.data || {};

  // Validation minimale : on exige au moins un email quelque part dans le payload.
  const email = pick(data, 'email', 'Email', 'e-mail') || payload.email;
  if (!email) {
    return res.status(400).json({ error: "Payload invalide : aucun champ email trouvé" });
  }

  const type = inferSaisineType(payload.form_name);
  const prenom = pick(data, 'prenom', 'prénom', 'firstname', 'first_name') || '';
  const nom = pick(data, 'nom', 'lastname', 'last_name', 'nomorganisation', 'organisation', 'société') || '';
  const nomComplet = [prenom, nom].filter(Boolean).join(' ') || pick(data, 'name', 'nom complet') || 'Non renseigné';
  const telephone = pick(data, 'telephone', 'téléphone', 'phone', 'whatsapp');
  const pays = pick(data, 'pays', 'paysduprojet', 'country', "pays d'activité", 'paysdactivite');
  const message = pick(data, 'description', 'message', 'exposedesfaits', 'descriptiondevotreprojet', 'descriptionduprojetafinancer', 'descriptiondevotreproposition', 'votremessage');

  const ref = await nextSaisineRef();
  const { rows } = await db.query(
    `INSERT INTO saisines (ref, type, nom, email, telephone, pays, message, source, ip_origine)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ref`,
    [ref, type, nomComplet, email, telephone, pays, message, `Netlify (${payload.form_name || 'formulaire'})`, req.ip]
  );

  await logAudit(null, 'saisine_recue_netlify', 'saisine', rows[0].id, `${type} — ${nomComplet} (${email}) via ${payload.form_name}`, req.ip);

  res.status(201).json({ ok: true, ref: rows[0].ref });
});

module.exports = router;
