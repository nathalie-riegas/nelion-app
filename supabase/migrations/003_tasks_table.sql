-- 003: Tasks table + ada_sessions title column
CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  titel TEXT NOT NULL,
  prioritaet INTEGER CHECK (prioritaet IN (1,2,3)) DEFAULT 2,
  deadline DATE,
  gate_bezug INTEGER CHECK (gate_bezug IN (1,2,3)),
  status TEXT CHECK (status IN ('offen','erledigt')) DEFAULT 'offen',
  ada_vorschlag BOOLEAN DEFAULT false,
  nathalie_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add title column to ada_sessions for session naming
ALTER TABLE ada_sessions ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Neue Session';
