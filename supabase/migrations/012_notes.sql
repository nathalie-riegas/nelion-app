-- 012: Freie Notizen — persistente Rich-Text-Notizen pro Nathalie-Account.
-- Wird vom Floating-Notes-Panel auf der NELION App verwendet.
-- Content ist sanitized HTML (b, i, ul, li, p, br, strong, em).
-- Position für Drag-Reorder vorbereitet (Default: MAX+10 serverseitig).

CREATE TABLE IF NOT EXISTS notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  position INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_position_idx ON notes(position);
CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes(updated_at DESC);
