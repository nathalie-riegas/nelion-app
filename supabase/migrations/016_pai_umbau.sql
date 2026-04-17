-- 016_pai_umbau.sql — PAI Komplettumbau (2026-04-17)
-- Fügt drei neue Spalten auf pai_sessions hinzu, die der zusammengeführte
-- PAI-Tab (Interview + Self-Assessment, 4 Phasen) nutzt.
--
-- - pai_transkript_analyse (JSONB): Phase 2 — Ergebnis der Linguistik- und
--   Layer-Signal-Analyse. Struktur: { text: string, analyzed_at: ISO-8601 }
-- - pai_abschluss_ampeln (JSONB):  Phase 4 — manuelle Beraterinnen-Ampeln
--   pro Layer. Struktur: { L1: "gruen"|"gelb"|"rot", L2: …, L3: … }
-- - pai_next_session (TEXT):        Phase 4 — Themen/Fragen für die nächste
--   Session.
--
-- Manuell im Supabase SQL-Editor ausführen — nicht automatisiert.

ALTER TABLE pai_sessions
  ADD COLUMN IF NOT EXISTS pai_transkript_analyse JSONB;

ALTER TABLE pai_sessions
  ADD COLUMN IF NOT EXISTS pai_abschluss_ampeln JSONB;

ALTER TABLE pai_sessions
  ADD COLUMN IF NOT EXISTS pai_next_session TEXT;
