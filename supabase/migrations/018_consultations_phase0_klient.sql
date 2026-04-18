-- Migration 018: Consultations Phase 0 (Klient-Block)
-- Erstgespräch-Tab bekommt eine neue Phase 0 vor Phase 1, die den Klient erfasst.
-- Name = contacts.name (existiert bereits), Datum = consultations.consultation_date (existiert bereits).
-- Neu pro Consultation: Unternehmen (Pflicht), Abteilung (optional), Phase-0-Notiz (optional).

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS unternehmen   TEXT,
  ADD COLUMN IF NOT EXISTS abteilung     TEXT,
  ADD COLUMN IF NOT EXISTS phase0_notiz  TEXT;
