-- PAI Audit (Client Self-Assessment) — parallel zum bestehenden PAI Interview
-- Erweitert pai_sessions um tool_type und ada_analysis.
-- Keine neuen Tabellen — pai_erhebung bleibt flexibles Key-Value-Store
-- und kann Interview- und Audit-Felder über session_id trennen.

-- Tool-Typ: 'interview' (bestehend) oder 'audit' (neu).
-- Bestehende Sessions werden automatisch auf 'interview' gesetzt (Default + Backfill).
ALTER TABLE pai_sessions
  ADD COLUMN IF NOT EXISTS tool_type TEXT NOT NULL DEFAULT 'interview';

UPDATE pai_sessions SET tool_type = 'interview' WHERE tool_type IS NULL;

CREATE INDEX IF NOT EXISTS pai_sessions_tool_type_idx
  ON pai_sessions(tool_type);

-- ADA-Analyse-Ergebnis persistiert als JSONB:
-- { l2_signal: string, hypothesen: string[], interview_empfehlungen: string[] }
-- oder Fallback: { raw_text: string, parse_error: true }
ALTER TABLE pai_sessions
  ADD COLUMN IF NOT EXISTS ada_analysis JSONB;
