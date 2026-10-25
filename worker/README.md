# Text-to-3D assignment (`/assignment_alex`)

The assignment is a Cloudflare Worker (`worker/`, with D1 for projects and R2 for files) that serves the app and its API;
the rest of the site is static. It also ships bundled examples (`public/assignment_alex/examples/`, rebuilt with
`node scripts/assignment/make-examples.mjs`, verified with `--check`).

Release order matters when a change adds a migration:

```sh
npx wrangler d1 migrations apply assignment-alex --remote   # BEFORE merging or deploying main
```

The Worker answers 503 ("being updated") while the database is behind it, and logs this command. Optionally put a
Cloudflare rate-limiting rule (about 10 a minute per IP) in front of `POST /models/*/derived`, `POST /models/*/edits`,
`POST /models/*/edited`, `POST /llm/*` and `POST /projects/from-example`.

## Muse Spark 1.3: the AI assembly designer (`OPENROUTER_API_KEY`)

One model in the picker is not a 3D model at all: **Muse Spark 1.3** (`meta/muse-spark-1.3-contributor` through OpenRouter) is a
text model. It is asked for a JSON list of named primitive parts (box, cylinder, sphere, cone, capsule, torus: strict
`json_schema`, reasoning effort `low`), and the app builds the multi-part GLB itself. About 20-60 s and $0.001 per design.

```
POST /projects/:id/generate -> providers/openrouter.ts submit() -> Queue "assignment-alex-llm" -> worker/llm.ts (queue consumer)
GET  /jobs/:id              -> providers/openrouter.ts poll()   <- R2 llm/<taskId>.json (status record) / .glb / .cancel
                               on "done": glb.ts copies "r2:llm/<taskId>.glb" into models/, then the staging files are deleted
```

- **Why a queue.** The Free plan gives a request 10 ms of CPU and `waitUntil` 30 s, and the call takes longer. The consumer has no such
  wall clock. Cloudflare documents no CPU exemption for Free-plan consumers, so assume the 10 ms applies there too: what the consumer
  spends CPU on (parse, repair, GLB writing, `shared/partsDesign.ts` + `shared/partsGlb.ts`) measured about 4-5 ms in a cold Node
  process for 60 parts (a capsule or torus only costs its positions, the normals and triangles are shared), 0.5 ms warm. After the first
  deploy, check `npx wrangler tail` or Workers Logs for `cpuTime` and an `exceededCpu` outcome on queue invocations.
- **Repair.** Whatever the model sends is cleaned before anything is built: parts that cannot be built are dropped, sizes clamped to
  5-1000 mm, bad colours replaced, 1-60 parts kept, then the whole assembly is scaled down to fit the 1000 mm cube (never up),
  centred on X/Y and lowered or lifted so its lowest point is z = 0. No usable part: the task fails with a clear message.
- **Retries and money.** A bad or empty answer and transient failures (network, 5xx, a provider error) are tried once more; an answer
  cut off at `max_tokens` is tried once more with a request that asks for a smaller design (at most 16 parts), because the same request
  would be cut off again; a 429 is retried with a delay (queue `max_retries` 2); a rejected key (401), no credits (402, "top up at
  openrouter.ai/settings/credits") or a moderation refusal fails the job at once with that message. The paid answer is saved
  first: the repaired design goes into the `building` record, and a delivery that finds it builds the file from it instead of calling
  OpenRouter again, so a crash or an R2 error after the answer costs a rebuild, not another call. Stop leaves `llm/<taskId>.cancel`,
  which the consumer honours. A design still unfinished 10 minutes after it was queued (the longest consumer path is about 6 minutes,
  and the wait in the queue counts) is given up on and the consumer is told to skip it.
- **Clean-up.** The job engine deletes `llm/<taskId>.*` when a job is over (saved, failed, stopped) and `purgeProjects` deletes the files
  of purged projects. Nothing runs when nobody polls (a closed tab) or when a message is lost, so also let the bucket expire the prefix
  once (this is a remote step, not part of a deploy):
  `npx wrangler r2 bucket lifecycle add assignment-alex-models llm-staging llm/ --expire-days 1`.
  A design that finished but whose tab stayed closed for more than a day is gone then (the job reports that it took too long).
- **Setup.** `npx wrangler queues create assignment-alex-llm` once (it must exist before the Worker is deployed), then
  `npx wrangler secret put OPENROUTER_API_KEY`. Optional var `OPENROUTER_MODEL` picks another OpenRouter model id. `wrangler dev`
  runs the queue locally, so the whole flow works with only the key in `.dev.vars`.
- **Tests.** `node scripts/assignment/test-muse.mjs` (offline: repair, GLB, adapter, consumer, the `r2:` source, and the job engine and the
  project purge against a local D1 from wrangler's `getPlatformProxy`).

## Versions: edits by words and the optimizer (migration `0006_versions.sql`)

A project's models form a tree: `generated` and `example` are the roots, every other kind has a `source_model_id` (`models.kind`:
`stabilized`, `edited`, `optimized`). `DELETE /models/:id` removes a version and every version made from it (and their files in R2, never
the shipped `static:` ones); roots cannot be deleted. `models.meta` holds `DerivedMeta`, `EditMeta` or `OptimizeSummary` by kind
(shared/versionMeta.ts reads them; it also answers `stabilizationsOf(row)` and `representationOf(row)`, the two facts the rules below use).

- **Block versions: `POST /models/:sourceId/derived`** (worker/derived.ts). The body is an assembly GLB with exactly one log:
  `nevo:stabilization` (kind `stabilized`), `nevo:edit` (kind `edited`, target `voxel`) or `nevo:optimization` (kind `optimized`). Nothing the
  client says is believed: the GLB is checked vertex by vertex against its cells, the log is validated and rebuilt, its hash must be the
  cells' hash, and its counts must be what the cells say (derivedChecks.ts, editChecks.ts, `crossCheckOptimized`). The row keeps the Worker's
  own slim copy of the log (`summarizeVoxelEdit`, `summarizeOptimize`) with the chain depth the Worker counted; the full log stays in the GLB.
  - The stabilizations on a chain follow from the source: a stabilization must say `stabilizationsOf(source) + 1` (at most 3, else 409), an
    edit or an optimization must repeat `stabilizationsOf(source)`. Edits and optimizations in between do not use one up.
  - `firstRun` for the stabilizer's cross-check is `representationOf(source) === "mesh"` (generated, example, edited design or mesh); a
    block version keeps the roles and steps of its blocks when it is stabilized again.
  - An edit of a mesh starts at `base_steps` 0; an edit's blocks are role `user`; an optimization names the source's cell hash (`source_hash`,
    null when the source is a mesh) and is only stored when `feasible`.
  - The same blocks under the same source are stored once, whatever the log (a second upload answers 200 with the model that is there).
- **One set of caps for every kind** (worker/versions.ts): 10 versions per source, 40 per project, 12 ancestors above a version (409), 3
  stabilizations on a chain, and 6 mesh edits per project (a mesh edit is 15 to 28 MB). The caps are conditions of the INSERT itself
  (`versionInsert`), so parallel requests cannot pass them; `readVersionCounts` and `versionCapError` give the early, cheap refusal and the
  message. The daily counters are one atomic upsert each (`reserveUpload`): `DAILY_DERIVED_LIMIT` (default 300; every block version saved,
  `usage.derived`) and `DAILY_EDIT_UPLOAD_LIMIT` (default 30; mesh edit uploads, `usage.edited`). Anything that adds a version row (the
  mesh-edit upload, a design edit's `saveModel`) should use `versionInsert`, `chainLengthSql` / `requireChainRoom` and these counters.
- **Design and mesh edits** ride the generation queue (below). **Block edits and optimization goals** use the direct lane (below).
- **CPU.** Reading and checking a 1000-block upload is 18 to 22 ms in a fresh Node process (the same as before for a stabilization; an edit or
  an optimization adds at most 4 ms cold, 0.5 ms warm) and 5 to 6 ms warm. On Workers Free (10 ms) a large save may fail with Cloudflare's
  error 1102; measure on the deployed Worker. Workers Paid is the fix; the per-vertex geometry check stays.
- **Release order.** Apply the migration first (`npx wrangler d1 migrations apply assignment-alex --remote`): the Worker that is live now
  keeps working after it, but cannot read rows of the new kinds, so a rollback after the first edit is saved loses them.
- **Tests.** `node scripts/assignment/test-versions-backend.mjs` runs worker/derived.ts, versions.ts, db.ts and api.ts in Node against SQLite
  (the real migrations) and an in-memory R2 (scripts/assignment/fake-env.mjs), with the real stabilizer for edit-then-stabilize.
  `bash scripts/assignment/test-migration.sh` (sqlite3; `WITH_WRANGLER=1` also runs it through `wrangler d1 migrations apply --local`) and
  `node scripts/assignment/smoke-derived.mjs` against `wrangler dev` (races between parallel requests, the real D1) complete it.

## The AI editor: edits by words and the optimizer's goal writer (Muse Spark through OpenRouter)

Four tasks ask Muse Spark (`meta/muse-spark-1.3-contributor`, strict `json_schema`, effort `low`, $0.0002 to $0.001 a call) for a small JSON
answer. The Worker owns every prompt and schema; the browser sends only the person's words and the facts about its model, so the paid key cannot
be used for anything else. Every answer is cleaned by a pure function that never throws (`applyPatch` + `repairDesign`, `sanitizeProgram`,
`cleanAnswer`, `repairSpec`) on the Worker where there is a Worker-side consumer, and again in the browser before anything is applied.
The contributor tier of the model may use prompts and images for training: the About page says so.

| Task | Lane | Start | Answer |
|---|---|---|---|
| Design edit (a Muse parts model) | queue | `POST /models/:id/edits` `{instruction, target:"design"}` | job; the new `edited` version appears on the job |
| Mesh edit plan (Hunyuan and other fused meshes) | queue | `POST /models/:id/edits` `{instruction, target:"mesh", mesh: <pictures, <= 400 KB>}` | job whose `edit.result.program` is run in the browser |
| Block edit | direct | `POST /llm/voxel-edit` `{instruction, scene}` | `{answer, model, cost_usd, ...}` (the browser applies it) |
| Optimization goal | direct | `POST /llm/optimize-spec` `{goal, brief}` | `{spec, changes, model, cost_usd, ms}` |

- **Queue lane** (worker/edit.ts, worker/jobs.ts `startEditJob`, worker/llm.ts consumer). `POST /models/:id/edits` answers 201 `{job}` or
  400 (bad instruction, target or pictures), 401 (access code), 404, 409 (project in the bin, another edit already running in the project,
  the model cannot be edited that way, a chain deeper than 12), 413, 422 (the parts of the design cannot be read), 429 (a cap or the day's
  count), 503 (no key, no queue, or editing switched off). It takes a slot of the day's count (`usage.llm`), inserts a job row
  (`kind = 'edit'`, `edit_target`, `source_model_id`), queues the message and gives the slot back when any of that fails. The consumer
  reads the source from R2, asks once (one retry for a hiccup, never for a 429), and writes the answer. A design edit saves an `edited` version
  (the file carries the exact design in `scenes[0].extras["nevo:design"]`); `applied: false` or "nothing changed" succeeds with no model and
  the reason on `job.edit.result`; a mesh plan stores the program in `jobs.plan` and leaves no file. The mesh pictures wait in R2 as
  `llm/<taskId>.in.json` (deleted with the other `llm/<taskId>.*` files; the bucket's one-day lifecycle rule on `llm/` covers a lost message).
  The project payload carries `job.edit.result` only for a job that succeeded and has no model.
- **Mesh upload** (worker/editUpload.ts). The browser runs the plan on the person's own copy of the file and sends the result:
  `POST /models/:sourceId/edited?job=<jobId>`, a raw `model/gltf-binary` body of at most 48 MiB (15 to 28 MB in practice). It is piped
  straight into R2 and only the header and the JSON chunk are read back (the geometry bytes never pass through JavaScript). Status codes: 201
  (stored) or 200 (this job already made a model: a retry is safe), 400 (not a GLB, a chunk or accessor out of range, a URI that is not
  `data:`, a picture that is not inside the file, an extension the editor does not write, more than 200 nodes, 1.2 M triangles or 3.6 M points,
  anything but triangles, a stride smaller than the data it strides over, or a picture that is not a PNG or JPEG of at most 4096 x 4096
  pixels (read from its own first 128 KB with a ranged read of R2; four such pictures at most together)), 404, 409 (the job is not a finished
  mesh plan of this model, its plan changed nothing (`applied: false`), the project is in the bin, the model is not a mesh), 411 (no
  Content-Length), 413, 415 (not `model/gltf-binary`), 429 (a cap, or `DAILY_EDIT_UPLOAD_LIMIT` for the day). The record (`EditMeta`) is built
  here from the job row, never from the file. The bounds are those of what everyone's viewer must load when it opens the version (the API has no
  owner): geometry inside them can still be nonsense, and a visitor can still fill a project's 6 mesh-edit places; both are the cost of an open API.
- **Direct lane** (worker/llmCall.ts, worker/voxelEdit.ts, worker/optimizeSpec.ts). One request, one answer, nothing stored, no job: a Worker
  waiting for a subrequest uses no CPU. Guards: the access code, the same lock as generation (a real key with no `ACCESS_CODE` and no
  `ALLOW_OPEN_GENERATION` answers 503 "Editing is disabled"; the offline demo is never locked), a body limit (16 KB for a block edit, 6 KB for a
  goal), the day's count.
  `POST /llm/voxel-edit`: 200, 400 (empty or over-long instruction, a scene that does not start `MODEL: `), 401, 405, 413, 429, 502, 503, 504.
  `POST /llm/optimize-spec`: 200, 400, 401, 405, 413, 429, 502, 503 (the page then offers the four buttons, which need no AI), 504. One retry
  for a 5xx or a timeout, never for the vendor's 429; a slot is handed back when the call failed before the model was paid, and kept when the
  model was paid, whatever came back: an answer cut off at `max_tokens`, a refusal, a filter block or something unusable. "Paid" is
  `wasCharged(usage)` in llmCall.ts (the vendor's cost, or the tokens the model produced), judged over both tries; the queue lane's rule
  (`maybeCharged` in llm.ts) is the same plus "no reply at all counts as maybe charged".
- **Daily counters** (one atomic upsert each). `DAILY_LLM_LIMIT` (default 400; `usage.llm`) counts design edits, mesh plans, block edits
  and goals together (about $0.2 a day at the measured cost). `DAILY_EDIT_UPLOAD_LIMIT` (default 30; `usage.edited`) counts mesh uploads.
  A stabilization, a block edit's save and an optimization's save count in `DAILY_DERIVED_LIMIT`. `GET /providers` reports
  `assist: {available, queued, images, model, daily_limit, used_today}`; `available` follows the generation lock (a real key and no access
  code means off unless `ALLOW_OPEN_GENERATION`).
- **Offline demo.** `MOCK_PROVIDER=1` (local only, `.dev.vars`) answers every task with a canned result and sends nothing to OpenRouter,
  even when `.dev.vars` also holds a real key: a design edit repaints every part, a mesh plan is one whole-model recolor, a block edit is one
  `extrude` of the top layer, a goal is the "lightest stable" preset. `MOCK_LLM=0` with `MOCK_PROVIDER=1` keeps the demo model but
  makes these four tasks live (`mockLlmEnabled` in providers/mock.ts decides, for all four).
- **Settings.** `OPENROUTER_EDIT_MODEL` picks another OpenRouter model id for these tasks (default `OPENROUTER_MODEL`; the non-contributor
  Muse Spark costs about 12 to 21 times as much). `OPENROUTER_API_KEY` is the same secret as the designer's.
- **Tests.** Offline: `test-edit-design.mjs`, `test-edit-mesh.mjs`, `test-llm-call.mjs`, `test-voxel-edit.mjs`, `test-optimize-spec.mjs`
  and `test-muse.mjs`. Against `wrangler dev` (`MOCK_PROVIDER=1`, migrations 0001 to 0006 applied): `smoke-edit-jobs.mjs`,
  `smoke-edit-upload.mjs`, `smoke-voxel-edit.mjs` (`LIMIT=2` and `NO_KEY=1` for the guard runs), `smoke-optimize-spec.mjs`,
  `smoke-optimize-flow.mjs` and `smoke-scenario.mjs` (the whole story: edit, stabilize, edit blocks, optimize, delete; `LIMIT=1` against a server
  started with `--var DAILY_LLM_LIMIT:2` shows the 429 of all four tasks). Opt-in live runs that cost a few cents:
  `live-voxel-edit.mjs` (`LIVE=1`), `live-optimize-spec.mjs` (`BASE=` for a running server), `live-edit-design.mjs` (`LIVE=1`; generates a Muse model, then
  five design edits), `live-edit-mesh.mjs` (a plan straight from OpenRouter on the local Hunyuan chair), `live-mesh-e2e.mjs` (`LIVE=1`; the whole
  mesh path through the Worker: plan, run, upload, undo) and `live-mesh-delete-score.mjs` (scores delete plans against reference regions; the
  second-pass decision rule). They need a `wrangler dev` whose `.dev.vars` has the key and no `MOCK_PROVIDER`.
