-- 014: Phase 4 (Slice + Idealzustand) in zwei getrennte Felder aufgeteilt.
-- Altes phase4_notes bleibt bestehen für Rückwärtskompatibilität.
-- Neue Felder werden separat autosaved.

ALTER TABLE consultations ADD COLUMN IF NOT EXISTS phase4_schritt TEXT;
ALTER TABLE consultations ADD COLUMN IF NOT EXISTS phase4_idealzustand TEXT;
