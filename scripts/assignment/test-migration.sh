#!/bin/bash
# Test of migrations/0006_versions.sql (the rebuild of `models` with a wider kind CHECK, the edit-job columns, the usage counters).
#
#   bash scripts/assignment/test-migration.sh              # sqlite3 only (a few seconds)
#   WITH_WRANGLER=1 bash scripts/assignment/test-migration.sh   # also runs the same migration through `wrangler d1 migrations apply --local`
#
# It builds a database with migrations 0001 to 0005 and rows in every table, applies 0006, and checks that nothing was lost
# (rows, their order, every column, the indexes), that the database is sound (integrity and foreign-key checks), that the statements
# of the Worker that is live now still work on the new schema (it keeps running between the migration and the deploy), that the new
# kinds are accepted and a bogus one is not, that the unique index still stops the same result being stored twice for one source, and
# that deleting a project still takes its models with it. Exits 1 when a check fails.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1${2:+  -> $2}"; }
expect() { # name, expected, actual
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
refused() { # name, pattern, sql: the statement must fail with a message matching the pattern
    local out
    out="$(sqlite3 "$DB" "PRAGMA foreign_keys=ON; $3" 2>&1)"
    if echo "$out" | grep -q "$2"; then ok "$1"; else bad "$1" "$out"; fi
}
accepted() { # name, sql
    local out
    if out="$(sqlite3 "$DB" "PRAGMA foreign_keys=ON; $2" 2>&1)"; then ok "$1"; else bad "$1" "$out"; fi
}

seed() { # the rows of a database that has lived through 0001 to 0005
    cat <<'SQL'
INSERT INTO projects (id, name, created_at, modified_at) VALUES ('p1','A','2026-01-01','2026-01-01'), ('p2','B','2026-01-01','2026-01-01');
INSERT INTO jobs (id, project_id, provider, via, prompt, status, created_at, updated_at, model_id) VALUES ('j1','p1','muse','openrouter','a chair','succeeded','2026-01-01','2026-01-01','m1');
INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at) VALUES ('m1','p1','j1','muse','a chair','models/m1.glb',100,'2026-01-01T00:00:01Z');
INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, assembly_hash, meta, analysis) VALUES ('m2','p1','j1','stabilizer','a chair','models/m2.glb',50,'2026-01-01T00:00:02Z','stabilized','m1','h2','{"version":1}','{"a":1}');
INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, example_slug) VALUES ('m3','p2','','example','lamp','static:/assignment_alex/examples/desk-lamp/original.glb',10,'2026-01-01T00:00:02Z','example','desk-lamp');
INSERT INTO usage (day, generations, derived) VALUES ('2026-01-01', 3, 2);
SQL
}

echo "== 0006 on sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
DB="$WORK/test.db"
for f in 0001_init 0002_job_poll_errors 0003_finalize_attempts 0004_model_analysis 0005_derived_models; do
    sqlite3 "$DB" < "$REPO/migrations/$f.sql" || { echo "migration $f failed"; exit 1; }
done
seed | sqlite3 "$DB"
BEFORE_ROWS="$(sqlite3 "$DB" "SELECT group_concat(id) FROM (SELECT id FROM models ORDER BY rowid)")"
BEFORE_DUMP="$(sqlite3 "$DB" "SELECT id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, example_slug, assembly_hash, meta FROM models ORDER BY rowid")"
BEFORE_JOBS="$(sqlite3 "$DB" "SELECT id, project_id, provider, via, prompt, status, progress, stage, model_id FROM jobs")"
if ! sqlite3 "$DB" < "$REPO/migrations/0006_versions.sql"; then bad "0006 applies"; echo "$PASS passed, $FAIL failed"; exit 1; fi
ok "0006 applies on a database with rows"

expect "row order is kept" "$BEFORE_ROWS" "$(sqlite3 "$DB" "SELECT group_concat(id) FROM (SELECT id FROM models ORDER BY rowid)")"
expect "every column of every model row is kept" "$BEFORE_DUMP" "$(sqlite3 "$DB" "SELECT id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, example_slug, assembly_hash, meta FROM models ORDER BY rowid")"
expect "the job rows are kept" "$BEFORE_JOBS" "$(sqlite3 "$DB" "SELECT id, project_id, provider, via, prompt, status, progress, stage, model_id FROM jobs")"
expect "the usage row is kept, the new counters start at 0" "2026-01-01|3|2|0|0" "$(sqlite3 "$DB" "SELECT day, generations, derived, llm, edited FROM usage")"
expect "the three indexes of models are back" "models_derived_once,models_project,models_source" "$(sqlite3 "$DB" "SELECT group_concat(name) FROM (SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='models' AND name NOT LIKE 'sqlite_%' ORDER BY name)")"
expect "the edit-job index exists" "jobs_edit_active" "$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='index' AND name='jobs_edit_active'")"
expect "the partial unique index is still partial" "1" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE name='models_derived_once' AND sql LIKE '%WHERE source_model_id IS NOT NULL AND assembly_hash IS NOT NULL%'")"
expect "no leftover table" "0" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE name='models_new'")"
expect "integrity_check" "ok" "$(sqlite3 "$DB" 'PRAGMA integrity_check')"
expect "foreign_key_check is clean" "" "$(sqlite3 "$DB" 'PRAGMA foreign_key_check')"

echo "== the Worker that is live now keeps working on the new schema"
accepted "old job INSERT (no new columns)" "INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, created_at, updated_at) VALUES ('j2','p1','hunyuan','tencent','x','queued',0,'Queued','t','t');"
expect "...and the job is a generate job" "generate||||" "$(sqlite3 "$DB" "SELECT kind, ifnull(source_model_id,''), ifnull(edit_target,''), ifnull(plan,''), ifnull(model_id,'') FROM jobs WHERE id='j2'")"
accepted "old model INSERT (kind defaults to generated)" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at) VALUES ('m9','p1','j2','hunyuan','x','models/m9.glb',NULL,9,1,'t');"
expect "...with kind generated" "generated" "$(sqlite3 "$DB" "SELECT kind FROM models WHERE id='m9'")"
accepted "old derived INSERT ... SELECT with the caps in WHERE" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, assembly_hash, meta) SELECT 'm10','p1','j1','stabilizer','x','models/m10.glb',NULL,9,1,'t',NULL,'stabilized','m1','h10','{}' WHERE EXISTS (SELECT 1 FROM models WHERE id='m1' AND project_id='p1') AND (SELECT COUNT(*) FROM models WHERE source_model_id='m1') < 10;"
accepted "old usage UPSERT" "INSERT INTO usage (day, derived) VALUES ('2026-01-02', 1) ON CONFLICT (day) DO UPDATE SET derived = derived + 1 WHERE derived < 300;"
accepted "old usage UPDATE" "UPDATE usage SET derived = MAX(0, derived - 1) WHERE day = '2026-01-02';"
accepted "old model read (the columns it selects) and analysis save" "SELECT id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, example_slug, assembly_hash, meta FROM models WHERE project_id='p1' ORDER BY created_at, rowid; UPDATE models SET analysis = '{\"a\":2}' WHERE id='m1' RETURNING id;"
accepted "old job read (the columns it selects) and its updates" "SELECT id, project_id, provider, via, prompt, status, progress, stage, error, provider_task_id, provider_state, created_at, updated_at, polled_at, finished_at, model_id, poll_errors, finalize_attempts FROM jobs WHERE project_id='p1'; UPDATE jobs SET status='failed', error='x', finished_at='t' WHERE id='j2';"
accepted "old delete of a stabilized subtree" "WITH RECURSIVE tree(id) AS (SELECT id FROM models WHERE id='m10' UNION SELECT m.id FROM models m JOIN tree t ON m.source_model_id = t.id) SELECT id FROM tree; DELETE FROM models WHERE id IN ('m10') AND kind = 'stabilized';"
expect "...and the old rows around it are untouched" "m1,m2,m3,m9" "$(sqlite3 "$DB" "SELECT group_concat(id) FROM (SELECT id FROM models WHERE id IN ('m1','m2','m3','m9') ORDER BY id)")"

echo "== the new kinds and counters"
accepted "kind edited" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, assembly_hash, meta) VALUES ('m11','p1','j1','muse','x','models/m11.glb',0,'t','edited','m1','e1','{}');"
accepted "kind optimized" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, assembly_hash) VALUES ('m12','p1','j1','optimizer','x','models/m12.glb',1,'t','optimized','m11','o1');"
refused "a bogus kind is refused by the CHECK" "CHECK constraint" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind) VALUES ('m13','p1','j1','x','x','k',1,'t','bogus');"
refused "the same result twice for one source is refused (UNIQUE)" "UNIQUE constraint" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, assembly_hash) VALUES ('m14','p1','j1','editor','x','models/m14.glb',0,'t','edited','m1','e1');"
accepted "two rows with a NULL hash under one source are fine (partial index)" "INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id) VALUES ('m15','p1','j1','muse','x','models/m15.glb',0,'t','edited','m1'), ('m16','p1','j1','muse','x','models/m16.glb',0,'t','edited','m1');"
accepted "an edit job" "INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, created_at, updated_at, kind, source_model_id, edit_target, plan) VALUES ('j3','p1','muse','openrouter','make it taller','queued',0,'Queued','t','t','edit','m1','mesh','{}');"
refused "a bogus job kind is refused by the CHECK" "CHECK constraint" "INSERT INTO jobs (id, project_id, provider, via, prompt, status, created_at, updated_at, kind) VALUES ('j4','p1','muse','openrouter','x','queued','t','t','bogus');"
accepted "the AI-call counters count" "INSERT INTO usage (day, llm) VALUES ('2026-01-03', 1) ON CONFLICT (day) DO UPDATE SET llm = llm + 1 WHERE llm < 400; UPDATE usage SET edited = edited + 1 WHERE day = '2026-01-03';"
expect "...and they sit in their own columns" "1|1|0|0" "$(sqlite3 "$DB" "SELECT llm, edited, derived, generations FROM usage WHERE day='2026-01-03'")"

echo "== deleting a project"
sqlite3 "$DB" "PRAGMA foreign_keys=ON; DELETE FROM projects WHERE id='p1';"
expect "models of the project go with it (cascade); the other project's example stays" "m3" "$(sqlite3 "$DB" "SELECT group_concat(id) FROM models")"
expect "foreign_key_check is still clean" "" "$(sqlite3 "$DB" 'PRAGMA foreign_key_check')"

if [ "${WITH_WRANGLER:-}" = "1" ]; then
    echo "== the same migration through wrangler d1 migrations apply --local (the D1 path)"
    WR="$REPO/node_modules/.bin/wrangler"
    W="$WORK/wr"
    mkdir -p "$W/migrations"
    cp "$REPO"/migrations/000[1-5]_*.sql "$W/migrations/"
    cat > "$W/wrangler.jsonc" <<'JSON'
{ "name": "migration-test", "compatibility_date": "2026-03-28", "d1_databases": [{ "binding": "DB", "database_name": "assignment-alex", "database_id": "eef6ff34-a14d-4da9-b33f-ff0f9758d76d", "migrations_dir": "migrations" }] }
JSON
    (cd "$W" && "$WR" d1 migrations apply assignment-alex --local --persist-to "$W/state" > "$W/apply1.log" 2>&1) && ok "0001 to 0005 apply" || bad "0001 to 0005 apply" "$(tail -5 "$W/apply1.log")"
    seed > "$W/seed.sql"
    (cd "$W" && "$WR" d1 execute assignment-alex --local --persist-to "$W/state" --file "$W/seed.sql" > "$W/seed.log" 2>&1) && ok "rows seeded" || bad "rows seeded" "$(tail -5 "$W/seed.log")"
    cp "$REPO/migrations/0006_versions.sql" "$W/migrations/"
    (cd "$W" && "$WR" d1 migrations apply assignment-alex --local --persist-to "$W/state" > "$W/apply2.log" 2>&1) && ok "0006 applies through wrangler on a database with rows" || bad "0006 applies through wrangler" "$(tail -8 "$W/apply2.log")"
    OUT="$(cd "$W" && "$WR" d1 execute assignment-alex --local --persist-to "$W/state" --json --command "SELECT group_concat(id) AS ids, (SELECT count(*) FROM pragma_foreign_key_check) AS fk FROM (SELECT id FROM models ORDER BY rowid)" 2>/dev/null)"
    echo "$OUT" | grep -q '"ids": "m1,m2,m3"' && ok "wrangler: the three rows are there in order" || bad "wrangler: rows" "$OUT"
    echo "$OUT" | grep -q '"fk": 0' && ok "wrangler: foreign_key_check is clean" || bad "wrangler: foreign_key_check" "$OUT"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
