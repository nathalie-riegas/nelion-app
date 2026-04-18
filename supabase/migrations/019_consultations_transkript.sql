-- Migration 019: Consultations Transkript + Analyse (Phase 5)
-- Erstgespräch Phase 5 bekommt Transkript-Upload. Volltext + Claude-Analyse
-- werden persistiert, damit Hypothesen-Generator sie als Kontext einbeziehen kann.

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS transkript_text      TEXT,
  ADD COLUMN IF NOT EXISTS transkript_analyse   JSONB;
