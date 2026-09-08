const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');

let staffToken, clientId, clientToken, tempPwd;

afterAll(async () => { await db.pool.end(); });

describe('Portail client', () => {
  test('setup: connexion staff + création client', async () => {
    const login = await request(app).post('/auth/login').send({ email: 'admin@afrilex.fr', password: 'admin123' });
    staffToken = login.body.accessToken;
    const client = await request(app).post('/clients').set('Authorization', `Bearer ${staffToken}`).send({
      prenom: 'Portal', nom: 'Test', email: 'portal.test@example.com',
    });
    clientId = client.body.id;
    expect(client.status).toBe(201);
  });

  test('le staff peut créer un portail pour ce client', async () => {
    const res = await request(app).post(`/clients/${clientId}/portal`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toBeDefined();
    tempPwd = res.body.tempPassword;
  });

  test('le client peut se connecter avec le mot de passe temporaire', async () => {
    const res = await request(app).post('/portal/login').send({ email: 'portal.test@example.com', password: tempPwd });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    clientToken = res.body.accessToken;
  });

  test('mauvais mot de passe → rejeté', async () => {
    const res = await request(app).post('/portal/login').send({ email: 'portal.test@example.com', password: 'faux' });
    expect(res.status).toBe(401);
  });

  test('le client voit son propre profil', async () => {
    const res = await request(app).get('/portal/me').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('portal.test@example.com');
  });

  test("SÉCURITÉ : un jeton client est rejeté sur les routes staff", async () => {
    const res = await request(app).get('/clients').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(401);
  });

  test("SÉCURITÉ : un jeton staff est rejeté sur les routes portail", async () => {
    const res = await request(app).get('/portal/me').set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(401);
  });

  test('le staff peut suspendre le portail, bloquant la connexion', async () => {
    await request(app).patch(`/clients/${clientId}/portal/status`).set('Authorization', `Bearer ${staffToken}`).send({ statut: 'suspendu' });
    const res = await request(app).post('/portal/login').send({ email: 'portal.test@example.com', password: tempPwd });
    expect(res.status).toBe(403);
  });

  test('le staff peut réactiver le portail', async () => {
    await request(app).patch(`/clients/${clientId}/portal/status`).set('Authorization', `Bearer ${staffToken}`).send({ statut: 'actif' });
    const res = await request(app).post('/portal/login').send({ email: 'portal.test@example.com', password: tempPwd });
    expect(res.status).toBe(200);
  });

  test('un consultant (non admin/manager) ne peut pas créer de portail', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('test1234', 4);
    await db.query(`INSERT INTO users (email, pwd_hash, prenom, nom, role) VALUES ($1,$2,'C','T','consultant')`, ['consultant.portal@afrilex.fr', hash]);
    const login = await request(app).post('/auth/login').send({ email: 'consultant.portal@afrilex.fr', password: 'test1234' });
    const res = await request(app).post(`/clients/${clientId}/portal`).set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(403);
  });
});
