-- AFRILEX Backend — Migration 002 : Partenaires + portail partenaire
-- Même logique que clients/client_accounts, pour les apporteurs d'affaires,
-- banques partenaires, notaires, etc.

CREATE TABLE partenaires (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           VARCHAR(30) UNIQUE NOT NULL,
  organisation  VARCHAR(200) NOT NULL,
  contact       VARCHAR(150),
  email         VARCHAR(255),
  telephone     VARCHAR(50),
  type          VARCHAR(30) DEFAULT 'autre'
                CHECK (type IN ('bancaire','apporteur','association','promoteur','agence','notaire','autre')),
  pays          VARCHAR(100),
  commission_apporteur_pct NUMERIC(5,2) DEFAULT 0,
  commission_partenaire_pct NUMERIC(5,2) DEFAULT 0,
  statut        VARCHAR(30) DEFAULT 'actif',
  notes         TEXT,
  cree_par      UUID REFERENCES users(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  supprime_le   TIMESTAMPTZ
);

CREATE TABLE partner_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partenaire_id     UUID UNIQUE NOT NULL REFERENCES partenaires(id) ON DELETE CASCADE,
  email             VARCHAR(255) NOT NULL,
  pwd_hash          VARCHAR(255),
  statut            VARCHAR(20) NOT NULL DEFAULT 'actif'
                    CHECK (statut IN ('actif','suspendu','lecture_seule','ferme')),
  dernier_login     TIMESTAMPTZ,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un partenaire peut être lié à plusieurs mandats (apporteur ou banque)
ALTER TABLE mandats ADD COLUMN partenaire_id UUID REFERENCES partenaires(id) ON DELETE SET NULL;
ALTER TABLE mandats ADD COLUMN partenaire_role VARCHAR(20) CHECK (partenaire_role IN ('banque','apporteur') OR partenaire_role IS NULL);

CREATE INDEX idx_mandats_partenaire ON mandats(partenaire_id);
