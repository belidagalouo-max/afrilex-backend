const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');

let adminToken;
let consultantToken;
let consultantId;
let clientId;

afterAll(async () => {
  await db.pool.end();
});

describe('Santé du serveur', () => {
  test('GET /health répond ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Authentification', () => {
  test('login avec mauvais mot de passe → 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@afrilex.fr', password: 'faux' });
    expect(res.status).toBe(401);
  });

  test('login avec bons identifiants → 200 + token', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@afrilex.fr', password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.role).toBe('admin');
    adminToken = res.body.accessToken;
  });

  test('route protégée sans token → 401', async () => {
    const res = await request(app).get('/clients');
    expect(res.status).toBe(401);
  });

  test('route protégée avec token invalide → 401', async () => {
    const res = await request(app).get('/clients').set('Authorization', 'Bearer token-invalide');
    expect(res.status).toBe(401);
  });
});

describe('Formulaire du site web (le besoin critique)', () => {
  test('POST /public/saisines sans authentification → créé en base', async () => {
    const res = await request(app).post('/public/saisines').send({
      type: 'projet', nom: 'Test E2E', email: 'teste2e@example.com', pays: 'Mali', message: 'Test',
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^SAI-/);
  });

  test('POST /public/saisines avec email invalide → 400', async () => {
    const res = await request(app).post('/public/saisines').send({ nom: 'X', email: 'pas-un-email' });
    expect(res.status).toBe(400);
  });

  test('le CRM (authentifié) voit bien la saisine reçue du site', async () => {
    const res = await request(app).get('/saisines').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some(s => s.email === 'teste2e@example.com')).toBe(true);
  });

  test('une IP ne peut pas dépasser 20 soumissions/heure (rate limit)', async () => {
    // On ne tire pas 20 requêtes ici (lent) — on vérifie juste que le middleware est bien monté
    // en inspectant l'en-tête RateLimit renvoyé par express-rate-limit.
    const res = await request(app).post('/public/saisines').send({ nom: 'X', email: 'ratelimit@example.com' });
    expect(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit']).toBeDefined();
  });
});

describe('Clients + RBAC', () => {
  test('admin peut créer un client', async () => {
    const res = await request(app).post('/clients').set('Authorization', `Bearer ${adminToken}`).send({
      prenom: 'Jean', nom: 'Test', email: 'jean.test@example.com',
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^CLI-/);
    clientId = res.body.id;
  });

  test('un consultant sans dossier assigné ne voit aucun client', async () => {
    // Crée un consultant directement en base pour le test
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('test1234', 4);
    const { rows } = await db.query(
      `INSERT INTO users (email, pwd_hash, prenom, nom, role) VALUES ($1,$2,'Awa','Test','consultant') RETURNING id`,
      ['consultant.test@afrilex.fr', hash]
    );
    consultantId = rows[0].id;
    const login = await request(app).post('/auth/login').send({ email: 'consultant.test@afrilex.fr', password: 'test1234' });
    consultantToken = login.body.accessToken;

    const res = await request(app).get('/clients').set('Authorization', `Bearer ${consultantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0); // aucun dossier ne lui est assigné
  });

  test('après assignation, le consultant voit le dossier assigné', async () => {
    await request(app).patch(`/clients/${clientId}`).set('Authorization', `Bearer ${adminToken}`).send({
      assigned_to: consultantId,
    });
    const res = await request(app).get('/clients').set('Authorization', `Bearer ${consultantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(clientId);
  });

  test('suppression = soft delete (corbeille), pas une perte de données', async () => {
    const del = await request(app).delete(`/clients/${clientId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    const { rows } = await db.query('SELECT supprime_le FROM clients WHERE id = $1', [clientId]);
    expect(rows[0].supprime_le).not.toBeNull(); // toujours en base, juste marqué supprimé

    const restore = await request(app).post(`/clients/${clientId}/restore`).set('Authorization', `Bearer ${adminToken}`);
    expect(restore.status).toBe(200);
    expect(restore.body.supprime_le).toBeNull();
  });
});

describe('Journal d\'audit', () => {
  test('les actions sensibles sont bien tracées', async () => {
    const { rows } = await db.query(
      `SELECT action FROM audit_log WHERE cible_type = 'client' AND cible_id = $1 ORDER BY horodatage`,
      [clientId]
    );
    const actions = rows.map(r => r.action);
    expect(actions).toContain('client_cree');
    expect(actions).toContain('client_corbeille');
    expect(actions).toContain('client_restaure');
  });
});
