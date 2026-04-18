-- 020 — Regime-Begründung auf scans
-- Freitext-Feld für Begründung der Regime-Wahl im Befund-Tab.
-- Nathalie führt manuell aus.
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS regime_begruendung TEXT;
