-- 022_pfad_empfehlung.sql — 20. April 2026
-- Block A: Automatische Pfad-Empfehlung (Erstgespräch + Scan).
-- Block B: Saubere Trennung Interview Ungesagtes von plan_b_nicht_gesagt.
-- Nicht ausführen — Nathalie führt manuell aus.

ALTER TABLE consultations
ADD COLUMN IF NOT EXISTS pfad_empfehlung TEXT;

ALTER TABLE scans
ADD COLUMN IF NOT EXISTS pfad_empfehlung TEXT;

-- Hinweis: Tabelle heisst in der Schema-Definition "interviews"
-- (nicht "scan_interviews" wie in Prompt 2026-04-20 formuliert).
ALTER TABLE interviews
ADD COLUMN IF NOT EXISTS ungesagtes TEXT;
