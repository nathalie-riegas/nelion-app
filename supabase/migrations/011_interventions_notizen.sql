-- 011: Netzwerk-Notizen pro Friction-Point im Interventionen-Tab.
-- Schema: { "<layer>_<achse>": "freitext" } — ein Eintrag pro Friction-Point.
-- Wird vom Interventionen-Tab via PATCH /api/auswertungen/:id persistiert.

ALTER TABLE auswertungen
  ADD COLUMN IF NOT EXISTS interventions_notizen JSONB;
