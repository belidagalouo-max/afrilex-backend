-- AFRILEX Backend — Schéma initial (V0.1)
-- Portée de cette V0.1 : authentification collaborateurs, clients, mandats,
-- saisines du site web (le besoin immédiat), documents (métadonnées),
-- journal d'audit. Les autres modules (factures, comptabilité, partenaires...)
-- suivront le même schéma dans des migrations ultérieures.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- pour gen_random_uuid()

-- ============================================================
-- UTILISATEURS (collaborateurs AFRILEX)
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  pwd_hash      VARCHAR(255) NOT NULL,
  prenom        VARCHAR(100) NOT NULL,
  nom           VARCHAR(100) NOT NULL,
  role          VARCHAR(30) NOT NULL DEFAULT 'consultant'
                CHECK (role IN ('admin','manager','consultant','lecture')),
  secteur       VARCHAR(100),
  poste         VARCHAR(100),
  actif         BOOLEAN NOT NULL DEFAULT true,
  dernier_login TIMESTAMPTZ,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           VARCHAR(30) UNIQUE NOT NULL,
  civilite      VARCHAR(10),
  prenom        VARCHAR(100) NOT NULL,
  nom           VARCHAR(100) NOT NULL,
  email         VARCHAR(255),
  telephone     VARCHAR(50),
  adresse       TEXT,
  nationalite   VARCHAR(100),
  date_naissance DATE,
  piece_identite VARCHAR(100),
  assigned_to   UUID REFERENCES users(id) ON DELETE SET NULL,
  statut_dossier VARCHAR(40) DEFAULT 'nouveau',
  notes         TEXT,
  cree_par      UUID REFERENCES users(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  supprime_le   TIMESTAMPTZ -- soft delete (corbeille), NULL = actif
);

-- ============================================================
-- COMPTES PORTAIL CLIENT
-- ============================================================
CREATE TABLE client_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID UNIQUE NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email             VARCHAR(255) NOT NULL,
  pwd_hash          VARCHAR(255),               -- NULL tant que le client n'a pas activé
  statut            VARCHAR(20) NOT NULL DEFAULT 'invite'
                    CHECK (statut IN ('invite','actif','suspendu','lecture_seule','ferme')),
  token_activation  VARCHAR(64),
  token_expire_le   TIMESTAMPTZ,
  active_le         TIMESTAMPTZ,
  dernier_login     TIMESTAMPTZ,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MANDATS
-- ============================================================
CREATE TABLE mandats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           VARCHAR(30) UNIQUE NOT NULL,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type          VARCHAR(50),
  pays          VARCHAR(100),
  ville         VARCHAR(100),
  budget        NUMERIC(14,2),
  commission_pct NUMERIC(5,2) DEFAULT 7,
  statut        VARCHAR(30) NOT NULL DEFAULT 'en_cours'
                CHECK (statut IN ('en_cours','signe','suspendu','resilie','termine')),
  date_debut    DATE,
  duree         VARCHAR(50),
  resiliation_motif    TEXT,
  resiliation_date     DATE,
  assigned_to   UUID REFERENCES users(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  supprime_le   TIMESTAMPTZ
);

-- ============================================================
-- SAISINES DU SITE WEB — LE BESOIN IMMÉDIAT
-- ============================================================
-- Ce que le formulaire du site (afrilex.fr / afrilexsite.netlify.app)
-- doit appeler via POST /public/saisines. Aucune authentification requise
-- (c'est un formulaire public), mais protégé par rate-limiting + validation.
CREATE TABLE saisines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           VARCHAR(30) UNIQUE NOT NULL,
  type          VARCHAR(30) NOT NULL DEFAULT 'info'
                CHECK (type IN ('projet','financement','partenariat','reclamation','mediation','info')),
  nom           VARCHAR(150),
  email         VARCHAR(255),
  telephone     VARCHAR(50),
  pays          VARCHAR(100),
  message       TEXT,
  source        VARCHAR(100) DEFAULT 'Site web',
  statut        VARCHAR(20) NOT NULL DEFAULT 'nouveau'
                CHECK (statut IN ('nouveau','traite','archive')),
  ip_origine    VARCHAR(64),
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- DOCUMENTS (métadonnées — fichiers réels sur disque/S3 dans /uploads)
-- ============================================================
CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   VARCHAR(30) NOT NULL,
  entity_id     UUID NOT NULL,
  groupe_id     UUID NOT NULL DEFAULT gen_random_uuid(), -- pour le versioning
  version       INT NOT NULL DEFAULT 1,
  nom_fichier   VARCHAR(255) NOT NULL,
  chemin        VARCHAR(500) NOT NULL,
  categorie     VARCHAR(100),
  mime          VARCHAR(100),
  taille_octets BIGINT,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_entity ON documents(entity_type, entity_id);

-- ============================================================
-- JOURNAL D'AUDIT — append-only
-- ============================================================
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(100) NOT NULL,
  cible_type    VARCHAR(50),
  cible_id      UUID,
  details       TEXT,
  ip            VARCHAR(64),
  horodatage    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Aucune politique de UPDATE/DELETE n'est exposée par l'API sur cette table :
-- elle ne peut que grandir, jamais être modifiée depuis l'application.

CREATE INDEX idx_clients_assigned ON clients(assigned_to);
CREATE INDEX idx_mandats_client ON mandats(client_id);
CREATE INDEX idx_saisines_statut ON saisines(statut);
