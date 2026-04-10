-- NELION Cockpit — Supabase schema
-- Run this once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  initial_note text,
  created_at timestamptz not null default now()
);

create table if not exists consultations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  consultation_date date not null default current_date,
  current_phase int not null default 1,
  phase1_notes text not null default '',
  phase2_notes text not null default '',
  phase3_notes text not null default '',
  phase4_notes text not null default '',
  phase5_notes text not null default '',
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists consultations_contact_id_idx
  on consultations(contact_id);
create index if not exists consultations_created_at_idx
  on consultations(created_at desc);

-- Keep updated_at in sync automatically
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists consultations_set_updated_at on consultations;
create trigger consultations_set_updated_at
  before update on consultations
  for each row execute procedure set_updated_at();
