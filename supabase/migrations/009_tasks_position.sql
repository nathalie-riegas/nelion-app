-- 009: Add position column for drag-and-drop task ordering
-- Run once in Supabase SQL editor.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position INTEGER;

-- Initialize position for existing rows.
-- id is UUID, so id::int is not valid — use ROW_NUMBER() over created_at
-- to assign stable integer positions (10, 20, 30, ...) to existing tasks.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at) * 10 AS new_pos
  FROM tasks
)
UPDATE tasks
SET position = numbered.new_pos
FROM numbered
WHERE tasks.id = numbered.id
  AND tasks.position IS NULL;

-- Optional cleanup: drop the deprecated sort_order column once you've
-- verified position is populated. Uncomment to run:
-- ALTER TABLE tasks DROP COLUMN IF EXISTS sort_order;
