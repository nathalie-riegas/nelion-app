-- 005: Add organisation column to scans
ALTER TABLE scans ADD COLUMN IF NOT EXISTS organisation TEXT;
