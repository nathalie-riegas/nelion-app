-- 015: Zusätzliche Notiz-Felder für Erstgespräch-Guide + Friction Scan Kernfragen.
-- Feedback-Runde 2 (17. April 2026) — Felder werden pro Guide-Frage bzw. pro
-- Kernfrage im Interview einzeln autosaved.

-- Consultations: Guide-Notizen (Phase 4 Schritt, Phase 5 Fragen, Multiplikator)
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS phase4_schritt_notizen TEXT;
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS phase5_mitnehmen_notizen TEXT;
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS phase5_naechster_schritt_notizen TEXT;
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS phase5_multiplikator TEXT;

-- Scans: Notizen pro Kernfrage im Interview-Tab (Phase 2)
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS interview_f1_notiz TEXT;
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS interview_f2_notiz TEXT;
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS interview_f3_notiz TEXT;
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS interview_abschluss_notiz TEXT;
