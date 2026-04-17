-- 013: Hypothesen + Regime-Auswahl in consultations-Tabelle.
-- hyp_generated: Markdown-Text von Claude (Hypothesen-Auto-Generate im Erstgespräch).
-- hyp_regime: "1" | "2" | "2b" | "3" — manuell gewähltes Regime-Routing.

ALTER TABLE consultations ADD COLUMN IF NOT EXISTS hyp_generated TEXT;
ALTER TABLE consultations ADD COLUMN IF NOT EXISTS hyp_regime TEXT;
