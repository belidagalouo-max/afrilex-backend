# AFRILEX — Backend Saisines

Un seul role : recevoir les formulaires soumis sur **afrilexsites.netlify.app** et les stocker dans une base de donnees PostgreSQL pour qu'ils apparaissent dans le CRM AFRILEX.

## Deploiement Railway (etapes)

1. Deposez ce dossier sur GitHub (depot prive)
2. Sur railway.com : New Project -> Deploy from GitHub -> selectionnez ce depot
3. Ajoutez un service PostgreSQL dans le meme projet
4. Dans le service backend -> Variables, ajoutez :
   - `DATABASE_URL` = valeur copiee depuis Variables du service Postgres (`DATABASE_PUBLIC_URL`)
5. Settings -> Deploy -> Start Command : `node src/migrate.js && node src/server.js`
6. Deployez

## Routes disponibles

- `GET /health` — verifie que le serveur tourne
- `POST /saisines` — recoit une saisine depuis le site (CORS restreint a afrilexsites.netlify.app)
- `GET /saisines` — liste les saisines (pour le CRM)
- `PATCH /saisines/:id/traitee` — marque une saisine comme traitee

## RGPD

Seules les donnees strictement necessaires au traitement des demandes sont collectees (nom, email, telephone, pays, message, type de demande). Aucune donnee sensible. Aucun compte utilisateur cree par ce backend.
