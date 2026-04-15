-- 008_auswertungen.sql
-- Interne Arbeitsansicht pro Scan: Heatmap-Überschreibungen, Friction-Point Notizen,
-- Befund-Entwurf nach Minto, Routing-Empfehlung.
-- Eine Auswertung pro Scan (enforced via UNIQUE auf scan_id).

CREATE TABLE IF NOT EXISTS auswertungen (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id UUID REFERENCES scans(id) ON DELETE CASCADE,
  -- { overrides: { "<layer>_<achse>": "gruen"|"gelb"|"rot"|"grau" },
  --   notes:     { "<layer>_<achse>": "freitext" } }
  friction_points JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { schlussfolgerung: string, begruendung: string, massnahmen: string }
  befund_entwurf JSONB NOT NULL DEFAULT '{}'::jsonb,
  routing_empfehlung TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auswertungen_scan_id_idx
  ON auswertungen(scan_id);
