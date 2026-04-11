-- NELION Modul 2 — Friction Scan Tables
-- Run this in Supabase SQL Editor after 001 (initial schema).

-- ─── SCANS ────────────────────────────────────────────────────────────────────
create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  kunde_name text not null,
  datum_start date not null default current_date,
  anzahl_personen int,
  status text not null default 'mandatscheck',
  regime text,
  friction_vektor text,
  notizen text not null default '',
  survey_verschickt boolean not null default false,
  survey_notizen text not null default '',
  hypothesen_spiegel_done boolean not null default false,
  hypothesen_spiegel_notizen text not null default '',
  mandatscheck_budget boolean not null default false,
  mandatscheck_personen boolean not null default false,
  mandatscheck_kein_krise boolean not null default false,
  current_phase int not null default 0,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scans_created_at_idx on scans(created_at desc);

-- ─── SCAN AMPELN (Traffic Lights) ─────────────────────────────────────────────
-- 12 axes across 3 layers, tracked per phase (survey / interview / final)
create table if not exists scan_ampeln (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  layer text not null,
  achse text not null,
  wert text not null default 'grau',
  phase text not null default 'survey',
  created_at timestamptz not null default now()
);

create index if not exists scan_ampeln_scan_id_idx on scan_ampeln(scan_id);
-- Ensure one entry per scan/layer/achse/phase combination
create unique index if not exists scan_ampeln_unique_idx
  on scan_ampeln(scan_id, layer, achse, phase);

-- ─── INTERVIEWS ───────────────────────────────────────────────────────────────
create table if not exists interviews (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  slot_nr int not null default 1,
  rolle text,
  datum timestamptz,
  audio_typ text,
  primaer_aufnahme boolean not null default false,
  backup_aufnahme boolean not null default false,
  einwilligung boolean not null default false,
  audio_gesichert boolean not null default false,
  whisper_laeuft boolean not null default false,
  transkript_vault boolean not null default false,
  notizen text not null default '',
  plan_b_aktiv boolean not null default false,
  plan_b_wichtigste_aussage text not null default '',
  plan_b_ton_wechsel text not null default '',
  plan_b_nicht_gesagt text not null default '',
  plan_b_layer text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interviews_scan_id_idx on interviews(scan_id);

-- ─── OMISSION BIAS CHECKS ────────────────────────────────────────────────────
create table if not exists omission_bias_checks (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references interviews(id) on delete cascade,
  biologische_last boolean not null default false,
  systemsprache boolean not null default false,
  geschuetzte_kollegen boolean not null default false,
  antrieb_gefragt boolean not null default false,
  ton_wechsel boolean not null default false,
  ton_wechsel_timestamp text,
  created_at timestamptz not null default now()
);

create unique index if not exists omission_bias_interview_idx
  on omission_bias_checks(interview_id);

-- ─── HYPOTHESEN ──────────────────────────────────────────────────────────────
create table if not exists hypothesen (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  slot_nr int not null default 1,
  layer text not null default '',
  mechanismus text not null default '',
  evidenz_zitat text not null default '',
  testfrage text not null default '',
  bestaetigt boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists hypothesen_scan_id_idx on hypothesen(scan_id);

-- ─── BEFUND MASSNAHMEN ───────────────────────────────────────────────────────
create table if not exists befund_massnahmen (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  slot_nr int not null default 1,
  layer text not null default '',
  massnahme text not null default '',
  zeitrahmen text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists befund_massnahmen_scan_id_idx on befund_massnahmen(scan_id);

-- ─── ADA SESSIONS ────────────────────────────────────────────────────────────
create table if not exists ada_sessions (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete set null,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── TRIGGERS ────────────────────────────────────────────────────────────────
-- Reuse existing set_updated_at() function from initial schema

drop trigger if exists scans_set_updated_at on scans;
create trigger scans_set_updated_at
  before update on scans
  for each row execute procedure set_updated_at();

drop trigger if exists interviews_set_updated_at on interviews;
create trigger interviews_set_updated_at
  before update on interviews
  for each row execute procedure set_updated_at();

drop trigger if exists ada_sessions_set_updated_at on ada_sessions;
create trigger ada_sessions_set_updated_at
  before update on ada_sessions
  for each row execute procedure set_updated_at();
