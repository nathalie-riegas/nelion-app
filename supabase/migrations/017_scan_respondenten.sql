-- ══════════════════════════════════════════════════════════════════════════
-- 017 — Scan Respondenten-Tracking + Arbeitshypothese
-- ══════════════════════════════════════════════════════════════════════════
-- Kontext: Friction Scan Umbau 2026-04-17
-- Phase 1 (Survey) bekommt Respondenten-Tracking pro Rolle (CEO/FK/Operativ).
-- Phase 3 (Erste Einschätzung) bekommt ein freies Arbeitshypothese-Feld.
-- Keine Email-Adressen speichern — nur Rolle, Status, Kürzel, Deadline.
-- Nathalie führt manuell aus (nicht automatisch via Migration-Runner).
-- ══════════════════════════════════════════════════════════════════════════

-- Status je Respondent (ausstehend | verschickt | eingegangen | nicht_erreichbar)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_ceo_status TEXT DEFAULT 'ausstehend';
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_fk_status  TEXT DEFAULT 'ausstehend';
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_op_status  TEXT DEFAULT 'ausstehend';

-- Kürzel / Initialen (max 10 Zeichen, optional — keine Klarnamen)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_ceo_kuerzel TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_fk_kuerzel  TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_op_kuerzel  TEXT;

-- Deadline für Rücklauf
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_ceo_deadline DATE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_fk_deadline  DATE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_op_deadline  DATE;

-- Versandzeitpunkt
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_ceo_verschickt DATE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_fk_verschickt  DATE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS respondent_op_verschickt  DATE;

-- Arbeitshypothese (Freitext, 2–3 Zeilen)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS arbeitshypothese TEXT;

-- Verknüpftes Erstgespräch (Foreign Key zu consultations — optional)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS linked_consultation_id UUID REFERENCES consultations(id) ON DELETE SET NULL;

-- Friction Profil — Manual-Override-Flag (wenn true: Ampeln wurden manuell gesetzt,
-- keine Auto-Befüllung aus Tally-Submissions überschreiben)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS friction_profil_manual_override BOOLEAN DEFAULT FALSE;
