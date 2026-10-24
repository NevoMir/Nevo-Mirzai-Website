-- How many times the Worker has tried to copy a finished model into R2. A transient failure (a dropped
-- download, a D1 hiccup) puts the job back to "running" so the next poll re-asks the vendor for a fresh
-- URL; the counter is what ends that loop.
ALTER TABLE jobs ADD COLUMN finalize_attempts INTEGER NOT NULL DEFAULT 0;

-- The 7-day trash purge looks up expired projects on every hub load; without this it scans the whole table.
CREATE INDEX projects_deleted ON projects (deleted_at) WHERE deleted_at IS NOT NULL;
