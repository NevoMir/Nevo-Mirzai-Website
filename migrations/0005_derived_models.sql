-- Derived and shared models: stabilized versions of a generated model, and ready-made examples.
--
-- DEPLOY ORDER: apply this BEFORE the Worker that selects the new columns goes live
--     npx wrangler d1 migrations apply assignment-alex --remote
-- (the live site deploys from main with no migrate step). It is additive (nullable columns, defaulted ones, an index), so
-- the Worker that is live now keeps working after it. The other way round, GET /projects/:id and POST /projects/from-example
-- fail ("no such column: kind"): the Worker then answers 503 "being updated" and logs this command.
--
-- kind             'generated' (a provider made it: every row before this migration), 'stabilized' (made in the
--                  browser from another model by the stabilizer), 'example' (the original of a bundled example).
-- source_model_id  the model a stabilized one was made from (same project). NULL for generated and example models.
-- example_slug     the bundled example a model came from (examples/<slug>/ in the static assets), else NULL.
-- assembly_hash    SHA-256 (hex) of the canonical block list of a stabilized model: the same result is never stored
--                  twice for one source (the unique index below), so a double click or a retry is idempotent.
-- meta             DerivedMeta JSON for 'stabilized' (iteration log, before/after numbers, solver); derived data,
--                  validated on write (worker/derived.ts, worker/examples.ts) and only parsed on read, at most 32 KB.
--
-- Models that belong to an example have no file of their own: glb_key holds 'static:<path>' (a file shipped with the
-- site, shared by every project made from that example). purgeProjects must never hand such a key to R2.
-- job_id stays NOT NULL: a stabilized model copies its source's job id, an example model stores ''.

ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'generated' CHECK (kind IN ('generated', 'stabilized', 'example'));
ALTER TABLE models ADD COLUMN source_model_id TEXT;
ALTER TABLE models ADD COLUMN example_slug TEXT;
ALTER TABLE models ADD COLUMN assembly_hash TEXT;
ALTER TABLE models ADD COLUMN meta TEXT;

CREATE INDEX models_source ON models (source_model_id) WHERE source_model_id IS NOT NULL;
CREATE UNIQUE INDEX models_derived_once ON models (source_model_id, assembly_hash)
    WHERE source_model_id IS NOT NULL AND assembly_hash IS NOT NULL;

-- Daily cap on stabilized uploads (R2 writes), next to the generation counter.
ALTER TABLE usage ADD COLUMN derived INTEGER NOT NULL DEFAULT 0;
