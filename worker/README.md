# Text-to-3D assignment (`/assignment_alex`)

The assignment is a Cloudflare Worker (`worker/`, with D1 for projects and R2 for files) that serves the app and its API;
the rest of the site is static. It also ships bundled examples (`public/assignment_alex/examples/`, rebuilt with
`node scripts/assignment/make-examples.mjs`, verified with `--check`).

Release order matters when a change adds a migration:

```sh
npx wrangler d1 migrations apply assignment-alex --remote   # BEFORE merging or deploying main
```

The Worker answers 503 ("being updated") while the database is behind it, and logs this command. Optionally put a
Cloudflare rate-limiting rule (about 10 a minute per IP) in front of `POST /models/*/derived` and `POST /projects/from-example`.

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
