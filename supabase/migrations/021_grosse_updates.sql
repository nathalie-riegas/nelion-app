-- 021_grosse_updates.sql — 19. April 2026
-- Block B2: Phase 5 Abschlussfrage "Ungesagtes" in consultations.
-- Block E:  Task-Notizen (kurz, pro Task) in tasks.
-- Nicht ausführen — Nathalie führt manuell aus.

ALTER TABLE consultations
ADD COLUMN IF NOT EXISTS phase5_ungesagtes TEXT;

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS notiz TEXT;
