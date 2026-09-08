const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');
const fs = require('fs');
const path = require('path');

let staffToken, clientId, clientToken, docId;
const testFile = path.join(__dirname, 'fixture.pdf');

beforeAll(() => {
  fs.writeFileSync(testFile, 'contenu de test PDF');
});
afterAll(async () => {
  fs.unlinkSync(testFile);
  await db.pool.end();
});

describe('Documents', () => {
  test('setup', async () => {
    const login = await request(app).post('/auth/login').send({ email: 'admin@afrilex.fr', password: 'admin123' });
    staffToken = login.body.accessToken;
    const client = await request(app).post('/clients').set('Authorization', `Bearer ${staffToken}`).send({
      prenom: 'Doc', nom: 'AutoTest', email: 'doc.autotest@example.com',
    });
    clientId = client.body.id;
  });

  test('le staff peut uploader un document sur une fiche client', async () => {
    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${staffToken}`)
      .field('entity_type', 'client')
      .field('entity_id', clientId)
      .field('categorie', 'Passeport')
      .attach('file', testFile);
    expect(res.status).toBe(201);
    expect(res.body.nom_fichier).toBe('fixture.pdf');
    docId = res.body.id;
  });

  test('un type de fichier interdit est rejeté avec un 400 propre', async () => {
    const badFile = path.join(__dirname, 'bad.exe');
    fs.writeFileSync(badFile, 'malicious');
    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${staffToken}`)
      .field('entity_type', 'client')
      .field('entity_id', clientId)
      .attach('file', badFile, { contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    fs.unlinkSync(badFile);
  });

  test('liste des documents dune fiche', async () => {
    const res = await request(app).get(`/documents?entity_type=client&entity_id=${clientId}`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('téléchargement du document renvoie le bon contenu', async () => {
    const res = await request(app).get(`/documents/${docId}/download`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('contenu de test PDF');
  });

  test('suppression douce puis restauration', async () => {
    const del = await request(app).delete(`/documents/${docId}`).set('Authorization', `Bearer ${staffToken}`);
    expect(del.status).toBe(200);
    const listAfterDelete = await request(app).get(`/documents?entity_type=client&entity_id=${clientId}`).set('Authorization', `Bearer ${staffToken}`);
    expect(listAfterDelete.body.find(d => d.id === docId)).toBeUndefined();

    const restore = await request(app).post(`/documents/${docId}/restore`).set('Authorization', `Bearer ${staffToken}`);
    expect(restore.status).toBe(200);
    const listAfterRestore = await request(app).get(`/documents?entity_type=client&entity_id=${clientId}`).set('Authorization', `Bearer ${staffToken}`);
    expect(listAfterRestore.body.find(d => d.id === docId)).toBeDefined();
  });
});

describe('Documents — portail client', () => {
  test('setup portail', async () => {
    const portal = await request(app).post(`/clients/${clientId}/portal`).set('Authorization', `Bearer ${staffToken}`);
    const login = await request(app).post('/portal/login').send({ email: 'doc.autotest@example.com', password: portal.body.tempPassword });
    clientToken = login.body.accessToken;
  });

  test('le client peut déposer son propre document', async () => {
    const res = await request(app)
      .post('/portal/documents')
      .set('Authorization', `Bearer ${clientToken}`)
      .attach('file', testFile);
    expect(res.status).toBe(201);
  });

  test('le staff voit bien ce document déposé par le client', async () => {
    const res = await request(app).get(`/documents?entity_type=client&entity_id=${clientId}`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.body.some(d => d.categorie === 'Déposé par le client')).toBe(true);
  });

  test('le client voit ses propres documents', async () => {
    const res = await request(app).get('/portal/documents').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('SÉCURITÉ : le client ne peut pas utiliser la route staff /documents', async () => {
    const res = await request(app).get(`/documents?entity_type=client&entity_id=${clientId}`).set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(401);
  });
});
