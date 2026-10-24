-- Text-to-3D assignment (/assignment_alex): projects, tags, generation jobs and stored models.
-- Model and thumbnail files live in the R2 bucket bound as FILES; rows keep their keys.

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{"messages":[],"active_model_id":null}',
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT,
    archived_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    thumbnail_key TEXT,
    thumbnail_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tags_name_unique ON tags (lower(name));

CREATE TABLE project_tags (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    via TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'Queued',
    error TEXT,
    provider_task_id TEXT,
    provider_state TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    polled_at TEXT,
    finished_at TEXT,
    model_id TEXT
);
CREATE INDEX jobs_project ON jobs (project_id, created_at);

CREATE TABLE models (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    prompt TEXT NOT NULL,
    glb_key TEXT NOT NULL,
    thumb_key TEXT,
    size_bytes INTEGER NOT NULL,
    part_count INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX models_project ON models (project_id, created_at);

-- One row per UTC day: the global generation cap (DAILY_GENERATION_LIMIT) protects the API credits.
CREATE TABLE usage (
    day TEXT PRIMARY KEY,
    generations INTEGER NOT NULL DEFAULT 0
);
