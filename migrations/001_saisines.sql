-- AFRILEX — Table saisines
-- Recoit les formulaires soumis sur afrilexsites.netlify.app
-- Donnees conservees uniquement le temps du traitement du dossier (RGPD art. 5)

CREATE TABLE IF NOT EXISTS saisines (
  id          SERIAL PRIMARY KEY,
  ref         VARCHAR(20) UNIQUE NOT NULL,
  type        VARCHAR(30) DEFAULT 'info',
  nom         VARCHAR(200),
  email       VARCHAR(255),
  telephone   VARCHAR(50),
  pays        VARCHAR(100),
  message     TEXT,
  source      VARCHAR(100) DEFAULT 'afrilexsites.netlify.app',
  recue_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  traitee     BOOLEAN DEFAULT false
);
