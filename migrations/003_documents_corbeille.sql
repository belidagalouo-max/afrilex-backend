-- AFRILEX Backend — Migration 003 : corbeille pour les documents
ALTER TABLE documents ADD COLUMN supprime_le TIMESTAMPTZ;
