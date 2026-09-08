const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');

afterAll(async () => { await db.pool.end(); });

describe('Webhook Netlify Forms (connexion site web)', () => {
  test('rejette un payload sans email', async () => {
    const res = await request(app).post('/public/webhooks/netlify-forms').send({
      form_name: 'info', data: { nom: 'X' },
    });
    expect(res.status).toBe(400);
  });

  test('accepte une soumission "nouveau-projet" et déduit le bon type', async () => {
    const res = await request(app).post('/public/webhooks/netlify-forms').send({
      form_name: 'nouveau-projet',
      email: 'client.webhook@example.com',
      data: { prenom: 'Fatou', nom: 'Sow', email: 'client.webhook@example.com', pays: 'Sénégal', description: 'Test webhook' },
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^SAI-/);

    const { rows } = await db.query('SELECT * FROM saisines WHERE email = $1', ['client.webhook@example.com']);
    expect(rows[0].type).toBe('projet');
    expect(rows[0].nom).toBe('Fatou Sow');
    expect(rows[0].source).toContain('Netlify');
  });

  test('déduit "reclamation" à partir du nom de formulaire', async () => {
    const res = await request(app).post('/public/webhooks/netlify-forms').send({
      form_name: 'reclamation-client',
      email: 'reclam.webhook@example.com',
      data: { nom: 'Test Reclam', email: 'reclam.webhook@example.com', description: 'Retard' },
    });
    expect(res.status).toBe(201);
    const { rows } = await db.query('SELECT type FROM saisines WHERE email = $1', ['reclam.webhook@example.com']);
    expect(rows[0].type).toBe('reclamation');
  });
});
