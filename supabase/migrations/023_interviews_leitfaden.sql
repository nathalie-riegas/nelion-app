-- Migration 023 — Strukturierter Interview-Leitfaden + Perspektiven (2026-04-20)
--
-- Ergänzt die Tabelle `interviews` um Notizspalten pro Leitfaden-Block
-- (Einstieg, 3 Universal-Kernfragen + Lösungsbild, 2 Vertiefungsfragen)
-- sowie die neue Spalte `perspektive` (ersetzt schrittweise `rolle`:
-- legacy-Werte bleiben lesbar, neue Einträge schreiben nach `perspektive`).
--
-- Alle Spalten sind TEXT + nullable — keine Constraints nötig, keine
-- Datenmigration erforderlich.
--
-- Ausführung: manuell in Supabase SQL-Editor durch Nathalie.

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS einstieg_notiz      TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS f1_notiz            TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS f2_notiz            TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS f3_notiz            TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS abschluss_notiz     TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS vertiefung_1_notiz  TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS vertiefung_2_notiz  TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS perspektive         TEXT;
