-- PAI Onboarding Sessions
CREATE TABLE IF NOT EXISTS pai_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  person_name TEXT NOT NULL,
  person_rolle TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'aktiv',
  current_phase INTEGER DEFAULT 0
);

-- PAI Erhebungsdaten je Phase
CREATE TABLE IF NOT EXISTS pai_erhebung (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES pai_sessions(id) ON DELETE CASCADE,
  phase INTEGER NOT NULL,
  feld TEXT NOT NULL,
  wert TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(session_id, phase, feld)
);

-- PAI Friction Profil (12 Ampeln wie NELION Scan)
CREATE TABLE IF NOT EXISTS pai_ampeln (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES pai_sessions(id) ON DELETE CASCADE,
  layer TEXT NOT NULL,
  achse TEXT NOT NULL,
  status TEXT DEFAULT 'gruen',
  notiz TEXT,
  UNIQUE(session_id, layer, achse)
);

-- PAI KPI Tracking
CREATE TABLE IF NOT EXISTS pai_kpis (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES pai_sessions(id) ON DELETE CASCADE,
  kpi_key TEXT NOT NULL,
  wert INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(session_id, kpi_key)
);
