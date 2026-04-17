-- 012_tally_submissions.sql
-- Tally Webhook Submissions für den NELION Friction Survey.
-- Eingehende Tally-Submissions werden hier roh + normalisiert abgelegt.
-- Verknüpfung mit einer Auswertung erfolgt manuell im Frontend
-- (oder über hidden field "auswertung_id" im Tally-Form, falls gesetzt).

CREATE TABLE IF NOT EXISTS tally_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auswertung_id UUID REFERENCES auswertungen(id) ON DELETE SET NULL,
  submission_id TEXT,
  eingegangen_am TIMESTAMPTZ DEFAULT NOW(),
  respondent_rolle TEXT CHECK (
    respondent_rolle IN ('CEO', 'FK', 'Operativ', 'unbekannt')
  ) DEFAULT 'unbekannt',
  rohdaten JSONB,
  scores JSONB,
  ampeln JSONB
);

CREATE INDEX IF NOT EXISTS tally_submissions_auswertung_idx
  ON tally_submissions(auswertung_id);

CREATE INDEX IF NOT EXISTS tally_submissions_submission_idx
  ON tally_submissions(submission_id);
