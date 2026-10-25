-- Versions: edited and optimized models, edit jobs, and the daily counters of the AI calls.
-- DEPLOY ORDER: apply BEFORE the Worker that writes kind 'edited' or 'optimized' goes live:
--     npx wrangler d1 migrations apply assignment-alex --remote
-- The Worker that is live now keeps working after it (same columns; the CHECK is only wider). Rollback caveat: that old Worker cannot read rows of the new kinds.
--
-- models.kind    'generated' | 'stabilized' | 'example' | 'edited' | 'optimized'. SQLite cannot change a CHECK constraint, so the table is rebuilt
--                once: create, copy in rowid order, drop, rename, recreate the three indexes. Nothing references `models` (jobs.model_id is a plain
--                TEXT; models -> projects is the only foreign key and it points the other way), so the drop is safe; defer_foreign_keys covers it.
-- models.meta    by kind: DerivedMeta (stabilized, as before), EditMeta (edited), OptimizeSummary (optimized); written by the Worker from a
--                validated upload, at most 32 KB / 8 KB / 4 KB.
-- jobs.kind      'generate' (every row so far) | 'edit' (a design or mesh edit on the queue, worker/edit.ts).
-- jobs.source_model_id, jobs.edit_target, jobs.plan   the model an edit works on, 'design' | 'mesh', and the EditResult JSON (at most 64 KB).
PRAGMA defer_foreign_keys = true;

CREATE TABLE models_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    prompt TEXT NOT NULL,
    glb_key TEXT NOT NULL,
    thumb_key TEXT,
    size_bytes INTEGER NOT NULL,
    part_count INTEGER,
    created_at TEXT NOT NULL,
    analysis TEXT,
    kind TEXT NOT NULL DEFAULT 'generated' CHECK (kind IN ('generated', 'stabilized', 'example', 'edited', 'optimized')),
    source_model_id TEXT,
    example_slug TEXT,
    assembly_hash TEXT,
    meta TEXT
);
INSERT INTO models_new (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, example_slug, assembly_hash, meta)
    SELECT id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, example_slug, assembly_hash, meta FROM models ORDER BY rowid;
DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
CREATE INDEX models_project ON models (project_id, created_at);
CREATE INDEX models_source ON models (source_model_id) WHERE source_model_id IS NOT NULL;
CREATE UNIQUE INDEX models_derived_once ON models (source_model_id, assembly_hash)
    WHERE source_model_id IS NOT NULL AND assembly_hash IS NOT NULL;

-- Edit jobs (design and mesh edits ride the same job table and queue as generation).
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'generate' CHECK (kind IN ('generate', 'edit'));
ALTER TABLE jobs ADD COLUMN source_model_id TEXT;   -- the model an edit job works on
ALTER TABLE jobs ADD COLUMN edit_target TEXT;       -- 'design' | 'mesh'
ALTER TABLE jobs ADD COLUMN plan TEXT;              -- EditResult JSON, <= 64 KB; NULL for generate jobs
CREATE INDEX jobs_edit_active ON jobs (project_id, status) WHERE kind = 'edit';

-- usage.llm    Muse calls per UTC day: edit jobs started, /llm/voxel-edit, /llm/optimize-spec (DAILY_LLM_LIMIT, default 400)
-- usage.edited mesh edits uploaded per UTC day (R2 writes of 15 to 28 MB; DAILY_EDIT_UPLOAD_LIMIT, default 30)
-- (stabilized, edited(voxel) and optimized uploads keep counting in usage.derived / DAILY_DERIVED_LIMIT)
ALTER TABLE usage ADD COLUMN llm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
