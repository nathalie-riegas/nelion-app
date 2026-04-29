-- 025_interviews_kontext_felder.sql
-- Fuegt 4 optionale Kontext-Felder pro Interview-Person hinzu:
-- Altersgruppe, Geschlecht, Branche, Teamgroesse.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS altersgruppe TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS geschlecht   TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS branche      TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS teamgroesse  INTEGER;
