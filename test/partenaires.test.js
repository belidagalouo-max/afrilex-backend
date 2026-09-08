const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');

let staffToken, partenaireId, partnerToken, tempPwd;

afterAll(async () => { await db.pool.end(); });

describe('Partenaires + Portail partenaire', () => {
  test('setup: connexion staff', async () => {
    const login = await request(app).post('/auth/login').send({ email: 'admin@afrilex.fr', password: 'admin123' });
    staffToken = login.body.accessToken;
  });

  test('le staff peut créer un partenaire', async () => {
    const res = await request(app).post('/partenaires').set('Authorization', `Bearer ${staffToken}`).send({
      organisation: 'Notaire Test SCP', email: 'notaire.portaltest@example.com', type: 'notaire', pays: 'Côte d\'Ivoire',
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^PAR-/);
    partenaireId = res.body.id;
  });

  test('le staff peut créer un portail pour ce partenaire', async () => {
    const res = await request(app).post(`/partenaires/${partenaireId}/portal`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(201);
    tempPwd = res.body.tempPassword;
  });

  test('le partenaire peut se connecter', async () => {
    const res = await request(app).post('/partner-portal/login').send({ email: 'notaire.portaltest@example.com', password: tempPwd });
    expect(res.status).toBe(200);
    partnerToken = res.body.accessToken;
  });

  test('le partenaire voit son propre profil', async () => {
    const res = await request(app).get('/partner-portal/me').set('Authorization', `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.organisation).toBe('Notaire Test SCP');
  });

  test("SÉCURITÉ : un jeton partenaire est rejeté sur les routes staff", async () => {
    const res = await request(app).get('/clients').set('Authorization', `Bearer ${partnerToken}`);
    expect(res.status).toBe(401);
  });

  test("SÉCURITÉ : un jeton partenaire est rejeté sur le portail client", async () => {
    const res = await request(app).get('/portal/me').set('Authorization', `Bearer ${partnerToken}`);
    expect(res.status).toBe(401);
  });

  test("SÉCURITÉ : un jeton staff est rejeté sur le portail partenaire", async () => {
    const res = await request(app).get('/partner-portal/me').set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(401);
  });

  test('le staff peut suspendre le portail partenaire', async () => {
    await request(app).patch(`/partenaires/${partenaireId}/portal/status`).set('Authorization', `Bearer ${staffToken}`).send({ statut: 'suspendu' });
    const res = await request(app).post('/partner-portal/login').send({ email: 'notaire.portaltest@example.com', password: tempPwd });
    expect(res.status).toBe(403);
  });
});

describe('Mandats', () => {
  let clientId, mandatId;

  test('setup: création client', async () => {
    const res = await request(app).post('/clients').set('Authorization', `Bearer ${staffToken}`).send({
      prenom: 'Mandat', nom: 'Test2', email: 'mandat.test2@example.com',
    });
    clientId = res.body.id;
  });

  test('création dun mandat', async () => {
    const res = await request(app).post('/mandats').set('Authorization', `Bearer ${staffToken}`).send({
      client_id: clientId, type: 'construction', pays: 'Bénin', commission_pct: 8,
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^MAN-/);
    mandatId = res.body.id;
  });

  test('résiliation sans motif → rejetée', async () => {
    const res = await request(app).patch(`/mandats/${mandatId}/statut`).set('Authorization', `Bearer ${staffToken}`).send({ statut: 'resilie' });
    expect(res.status).toBe(400);
  });

  test('résiliation avec motif → acceptée', async () => {
    const res = await request(app).patch(`/mandats/${mandatId}/statut`).set('Authorization', `Bearer ${staffToken}`).send({
      statut: 'resilie', resiliation_motif: 'Test automatisé',
    });
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('resilie');
  });

  test('le mandat résilié apparaît dans le portail client', async () => {
    const portal = await request(app).post(`/clients/${clientId}/portal`).set('Authorization', `Bearer ${staffToken}`);
    const login = await request(app).post('/portal/login').send({ email: 'mandat.test2@example.com', password: portal.body.tempPassword });
    const dossier = await request(app).get('/portal/dossier').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(dossier.body.mandats.some(m => m.statut === 'resilie')).toBe(true);
  });
});
