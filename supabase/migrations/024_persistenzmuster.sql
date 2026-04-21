-- Migration 024: Kultur-Indikator (KI-01) — Persistenzmuster + Handlungshinweis
-- 2026-04-20 — nicht automatisch ausführen. Nathalie manuell in Supabase SQL Editor.

ALTER TABLE scans
ADD COLUMN IF NOT EXISTS persistenzmuster TEXT;

ALTER TABLE scans
ADD COLUMN IF NOT EXISTS handlungshinweis TEXT;
