// The generation engine: starts one provider task per selected model, advances jobs when the client polls,
// copies finished GLBs into R2 and turns them into ModelAssets. There is no queue or cron: GET /jobs/:id
// is the heartbeat (throttled to one vendor poll per ~3 s), and finalization is leased so it can be retried.

import { ACCESS_HEADER, TERMINAL_JOB_STATUSES } from "../src/assignment/shared/contract.ts";
import type { Job, JobStatus, ProviderId, ProvidersResponse } from "../src/assignment/shared/contract.ts";
import {
    JOB_COLS,
    MODEL_COLS,
    projectExists,
    toJob,
    toModelAsset,
    touchProject,
    type JobRow,
    type ModelRow,
} from "./db.ts";
import { MAX_STORE_MS, ModelFileError, storeGlb, storeThumbnail } from "./glb.ts";
import { PROVIDER_SPECS, listProviders, resolveProvider } from "./providers/index.ts";
import {
    ProviderError,
    type AdapterState,
    type Env,
    type PollResult,
    type ProviderAdapter,
    type ProviderSpec,
} from "./providers/types.ts";
import { HttpError, errorSummary, nowIso, requireUuid, secretsMatch } from "./util.ts";

const POLL_INTERVAL_MS = 3_000;
const MAX_RUNTIME_MS = 30 * 60 * 1000;
const MAX_POLL_ERRORS = 5;
// One save takes at most MAX_STORE_MS (every download attempt plus the thumbnail). The lease must outlast it, or a
// second visitor's poll would start a parallel copy of the same model.
const FINALIZE_LEASE_MS = MAX_STORE_MS + 45_000;
// Copies of a finished model that may fail (or die) before the job is given up on. Each one re-asks the vendor.
const MAX_FINALIZE_ATTEMPTS = 3;
// After a failed copy the next poll waits this long, so a host that is having a moment can recover.
const RETRY_SAVE_DELAY_MS = 10_000;
const SUBMIT_GRACE_MS = 2 * 60 * 1000;
const MAX_PROMPT_CHARS = 1000;
const MAX_PROVIDERS = 5;
// Wrong access codes tolerated per client per window before it is turned away (see throttleBadCodes).
const MAX_BAD_CODES = 10;
const BAD_CODE_WINDOW_MS = 60_000;

const ACTIVE = "status IN ('queued', 'running', 'finalizing')";

const isTerminal = (status: string) => TERMINAL_JOB_STATUSES.includes(status as JobStatus);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Providers, access, usage ----------

/** A positive DAILY_GENERATION_LIMIT caps paid generations per UTC day; unset (or anything else) means no cap. */
function dailyLimit(env: Env): number | null {
    const parsed = Number.parseInt(env.DAILY_GENERATION_LIMIT ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The access code with stray whitespace removed (a value pasted into the dashboard often carries a newline). */
const configuredCode = (env: Env): string => env.ACCESS_CODE?.trim() ?? "";

const openGenerationAllowed = (env: Env): boolean => env.ALLOW_OPEN_GENERATION === "1";

/**
 * Paid generation is switched off when a real provider has a key but no access code is set (a forgotten or empty
 * secret), instead of silently being open to the whole internet. ALLOW_OPEN_GENERATION=1 is the explicit opt-out.
 * The offline mock costs nothing, so it never counts.
 */
function generationLocked(env: Env): boolean {
    if (configuredCode(env) || openGenerationAllowed(env)) return false;
    return listProviders(env).some((p) => p.available && p.id !== "mock");
}

export async function getProvidersResponse(env: Env): Promise<ProvidersResponse> {
    const locked = generationLocked(env);
    if (locked) console.warn("ACCESS_CODE is not set: generation is disabled (set the secret, or ALLOW_OPEN_GENERATION=1)");
    const providers = listProviders(env).map((p) => (locked && p.id !== "mock" ? { ...p, available: false } : p));
    const available = providers.filter((p) => p.available);
    const used = await env.DB.prepare("SELECT generations FROM usage WHERE day = ?1")
        .bind(today())
        .first<{ generations: number }>();
    return {
        providers,
        default_provider: (available.find((p) => p.id === "tripo-parts") ?? available[0])?.id ?? null,
        access_required: configuredCode(env) !== "",
        daily_limit: dailyLimit(env),
        used_today: used?.generations ?? 0,
    };
}

// Wrong access codes per client, kept in this isolate's memory. Best effort only: another isolate has its own
// count, so the Cloudflare rate-limiting rule on the access endpoints is the real limit (this just stops the
// cheapest loops). Counting in D1 would spend the free plan's write budget on the attacker's behalf.
const badCodes = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
    return request.headers.get("cf-connecting-ip") ?? "local";
}

function throttleBadCodes(request: Request): void {
    const entry = badCodes.get(clientKey(request));
    if (entry && entry.resetAt > Date.now() && entry.count >= MAX_BAD_CODES) {
        throw new HttpError(429, "Too many wrong access codes. Wait a minute and try again.", {
            "Retry-After": String(Math.ceil((entry.resetAt - Date.now()) / 1000)),
        });
    }
}

function noteBadCode(request: Request): void {
    const now = Date.now();
    if (badCodes.size > 1000) {
        for (const [key, entry] of badCodes) if (entry.resetAt <= now) badCodes.delete(key);
        if (badCodes.size > 1000) badCodes.clear();
    }
    const key = clientKey(request);
    const entry = badCodes.get(key);
    if (entry && entry.resetAt > now) entry.count += 1;
    else badCodes.set(key, { count: 1, resetAt: now + BAD_CODE_WINDOW_MS });
}

/** True when `code` is the access code (or none is configured). Wrong codes are counted per client; too many are a 429. */
export async function checkAccessCode(env: Env, request: Request, code: unknown): Promise<boolean> {
    const expected = configuredCode(env);
    if (!expected) return true;
    throttleBadCodes(request);
    const given = typeof code === "string" ? code.trim() : "";
    if (given.length <= 200 && (await secretsMatch(given, expected))) return true;
    if (given) noteBadCode(request);
    return false;
}

async function assertAccess(env: Env, request: Request): Promise<void> {
    if (!configuredCode(env)) return;
    if (!(await checkAccessCode(env, request, request.headers.get(ACCESS_HEADER) ?? ""))) {
        throw new HttpError(401, "Access code required");
    }
}

/**
 * Atomically takes `count` slots from today's cap; hands them back and returns false when that goes over.
 * Without a cap it only counts (the "used today" figure in the About dialog).
 */
async function reserveUsage(env: Env, day: string, count: number): Promise<boolean> {
    const row = await env.DB.prepare(
        `INSERT INTO usage (day, generations) VALUES (?1, ?2)
         ON CONFLICT (day) DO UPDATE SET generations = generations + excluded.generations
         RETURNING generations`,
    )
        .bind(day, count)
        .first<{ generations: number }>();
    const limit = dailyLimit(env);
    if (limit !== null && (!row || row.generations > limit)) {
        await refundUsage(env, day, count);
        return false;
    }
    return true;
}

async function refundUsage(env: Env, day: string, count: number): Promise<void> {
    await env.DB.prepare("UPDATE usage SET generations = MAX(0, generations - ?1) WHERE day = ?2")
        .bind(count, day)
        .run()
        .catch(() => {});
}

// ---------- Reading jobs ----------

async function getJobRow(env: Env, id: string): Promise<JobRow | null> {
    return env.DB.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?1`).bind(id).first<JobRow>();
}

/** A row as the contract's Job, with its ModelAsset embedded once it has one. */
async function viewJob(env: Env, row: JobRow): Promise<Job> {
    let model = null;
    if (row.model_id) {
        const modelRow = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE id = ?1`)
            .bind(row.model_id)
            .first<ModelRow>();
        if (modelRow) model = toModelAsset(modelRow);
    }
    return toJob(row, model);
}

async function reload(env: Env, id: string): Promise<Job> {
    const row = await getJobRow(env, id);
    if (!row) throw new HttpError(404, "Job not found");
    return viewJob(env, row);
}

function parseState(raw: string | null): AdapterState {
    if (!raw) return null;
    try {
        const state: unknown = JSON.parse(raw);
        return state && typeof state === "object" ? (state as AdapterState) : null;
    } catch {
        return null;
    }
}

/** The adapter that started a job: matched on the stored `via`, not on today's key configuration. */
function adapterFor(providerId: string, via: string): { spec: ProviderSpec; adapter: ProviderAdapter } | null {
    const spec = PROVIDER_SPECS.find((s) => s.id === providerId);
    const route = spec?.routes.find((r) => r.via === via);
    return spec && route ? { spec, adapter: route.adapter } : null;
}

/** Best-effort vendor-side cancel: a failure here must never block marking the job canceled. */
async function tryCancel(env: Env, adapter: ProviderAdapter, taskId: string, state: AdapterState): Promise<void> {
    try {
        await adapter.cancel?.(env, taskId, state);
    } catch {
        // ignored on purpose
    }
}

/** The job is over: lets the adapter delete what it staged for it (the Muse designer's files in R2). Best effort, never throws. */
async function releaseTask(env: Env, row: JobRow): Promise<void> {
    if (!row.provider_task_id) return;
    const route = adapterFor(row.provider, row.via);
    if (!route?.adapter.cleanup) return;
    try {
        await route.adapter.cleanup(env, row.provider_task_id, parseState(row.provider_state));
    } catch {
        // ignored on purpose
    }
}

/** Reloads the job after a poll's verdict and, when that verdict landed (the job is over), releases the adapter's staging. */
async function reloadAndRelease(env: Env, row: JobRow): Promise<Job> {
    const job = await reload(env, row.id);
    if (isTerminal(job.status)) await releaseTask(env, row);
    return job;
}

const safeMessage = (err: unknown, fallback: string) => (err instanceof ProviderError ? err.message : fallback);

/**
 * A vendor task with no cancel API keeps running (and billing) whatever we record, so "canceling" it would only
 * throw its result away. The offline demo provider costs nothing and can always be dropped.
 */
const canBeStopped = (adapter: ProviderAdapter): boolean => Boolean(adapter.cancel) || adapter.via === "mock";

// ---------- Starting generation ----------

export async function startGeneration(
    env: Env,
    request: Request,
    rawProjectId: string,
    body: Record<string, unknown>,
): Promise<Job[]> {
    await assertAccess(env, request);
    const projectId = requireUuid(rawProjectId, "project id");
    const project = await projectExists(env, projectId);
    if (!project) throw new HttpError(404, "Project not found");
    if (project.deleted_at) throw new HttpError(409, "This project is in the trash. Restore it to generate.");

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
        throw new HttpError(400, `prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
    }
    const requested = body.providers;
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_PROVIDERS) {
        throw new HttpError(400, `providers must list 1 to ${MAX_PROVIDERS} models`);
    }
    if (new Set(requested).size !== requested.length) throw new HttpError(400, "providers must be distinct");
    const resolved = requested.map((id) => {
        if (typeof id !== "string" || !PROVIDER_SPECS.some((s) => s.id === id)) {
            throw new HttpError(400, "Unknown provider");
        }
        const route = resolveProvider(env, id as ProviderId);
        if (!route) throw new HttpError(400, `${PROVIDER_SPECS.find((s) => s.id === id)?.info.label} is not available`);
        return { id: id as ProviderId, ...route };
    });
    if (generationLocked(env) && resolved.some((r) => r.id !== "mock")) {
        throw new HttpError(503, "Generation is disabled: ACCESS_CODE is not configured on the server.");
    }

    // One running job per model and project: a double click or a second tab must not pay for the same run twice.
    // (The workspace sends the next prompt only once the previous one has finished, and Retry starts a model whose
    // earlier job is over, so neither trips this.) Other models of the project may keep running.
    const running = await env.DB.prepare(
        `SELECT provider FROM jobs WHERE project_id = ?1 AND provider IN (SELECT value FROM json_each(?2))
         AND ${ACTIVE} LIMIT 1`,
    )
        .bind(projectId, JSON.stringify(resolved.map((r) => r.id)))
        .first<{ provider: string }>();
    if (running) {
        const label = PROVIDER_SPECS.find((s) => s.id === running.provider)?.info.label ?? "This model";
        throw new HttpError(
            409,
            `${label} is already generating in this project. Wait for it to finish or stop it first.`,
        );
    }

    // The daily cap protects API credits: the offline demo costs nothing, so it takes no slot.
    const day = today();
    const paid = resolved.filter((r) => r.via !== "mock").length;
    if (paid > 0 && !(await reserveUsage(env, day, paid))) {
        throw new HttpError(429, `Daily generation limit reached (${dailyLimit(env)} per day). Try again tomorrow.`);
    }
    // From here on, a slot that does not become a started vendor task goes back to the pool.
    try {
        await touchProject(env, projectId);
    } catch (err) {
        if (paid > 0) await refundUsage(env, day, paid);
        throw err;
    }

    // allSettled, not all: a vendor task that did start must reach the client even if a sibling's bookkeeping failed.
    const settled = await Promise.allSettled(
        resolved.map((r) => submitOne(env, projectId, prompt, r.id, r.via, r.adapter, day)),
    );
    const rows: JobRow[] = [];
    let failure: unknown;
    for (const outcome of settled) {
        if (outcome.status === "fulfilled") rows.push(outcome.value);
        else {
            failure ??= outcome.reason;
            console.error(`submit bookkeeping failed: ${errorSummary(outcome.reason)}`);
        }
    }
    if (rows.length === 0) throw failure;
    return Promise.all(rows.map((row) => viewJob(env, row)));
}

/**
 * Creates the job row, then hands the prompt to the vendor. A failure only fails this job. Its slot is refunded
 * when the vendor definitely did not take the task; after a timeout or network error it may have, so the slot stays.
 */
async function submitOne(
    env: Env,
    projectId: string,
    prompt: string,
    provider: ProviderId,
    via: string,
    adapter: ProviderAdapter,
    day: string,
): Promise<JobRow> {
    const id = crypto.randomUUID();
    const now = nowIso();
    const holdsSlot = via !== "mock"; // see generate(): demo runs take no daily slot, so they give none back
    try {
        await env.DB.prepare(
            `INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, 'Queued', ?6, ?6)`,
        )
            .bind(id, projectId, provider, via, prompt, now)
            .run();
    } catch (err) {
        // A D1 error, or the project was purged meanwhile: nothing reached the vendor.
        if (holdsSlot) await refundUsage(env, day, 1);
        throw err;
    }
    try {
        const submitted = await adapter.submit(env, prompt);
        if (!submitted.taskId) throw new ProviderError("The provider did not return a task id.");
        const started = await env.DB.prepare(
            `UPDATE jobs SET provider_task_id = ?1, provider_state = ?2, status = 'running', stage = 'Submitted',
             updated_at = ?3 WHERE id = ?4 AND status = 'queued'`,
        )
            .bind(submitted.taskId, submitted.state ? JSON.stringify(submitted.state) : null, nowIso(), id)
            .run();
        // Canceled (or given up on) while the vendor was creating the task: stop it, nobody will collect the result.
        if (started.meta.changes !== 1) await tryCancel(env, adapter, submitted.taskId, submitted.state ?? null);
    } catch (err) {
        console.error(`submit failed (${provider}/${via}): ${errorSummary(err)}`);
        await markFailed(env, id, safeMessage(err, "Could not start the generation. Please try again."));
        // retryable = a timeout or network error: the vendor may have created (and may bill) the task anyway.
        if (holdsSlot && err instanceof ProviderError && !err.retryable) await refundUsage(env, day, 1);
    }
    const row = await getJobRow(env, id);
    if (!row) throw new Error("job vanished after insert");
    return row;
}

/** What a vendor poll's follow-up writes need to prove they are allowed to land (see advanceJob). */
interface PollClaim {
    /** The polled_at value this poll wrote when it won the throttle; a newer poll overwrites it. */
    token: string;
    /** A finalizing job older than this has lost its lease (its saver is presumed dead). */
    leaseCutoff: string;
}

/**
 * UPDATE a job on behalf of one vendor poll. It lands only if this poll still holds the newest claim (a slow older
 * poll must not overwrite what a newer one did) and nobody is saving the model right now; a finalize whose lease
 * has run out may be written over, otherwise a vendor error could strand it forever. `assignments` use ?1..?n.
 */
async function updateClaimed(
    env: Env,
    id: string,
    claim: PollClaim,
    assignments: string,
    values: Array<string | number | null>,
): Promise<void> {
    const n = values.length;
    await env.DB.prepare(
        `UPDATE jobs SET ${assignments} WHERE id = ?${n + 1} AND polled_at = ?${n + 2}
         AND (status IN ('queued', 'running') OR (status = 'finalizing' AND updated_at < ?${n + 3}))`,
    )
        .bind(...values, id, claim.token, claim.leaseCutoff)
        .run();
}

/** Fails a job. With a claim it is a poll's verdict (guarded, see updateClaimed); without, any active job may be failed. */
async function markFailed(env: Env, id: string, error: string, claim?: PollClaim): Promise<void> {
    const now = nowIso();
    const assignments = "status = 'failed', stage = 'Failed', error = ?1, finished_at = ?2, updated_at = ?2";
    if (claim) {
        await updateClaimed(env, id, claim, assignments, [error, now]);
        return;
    }
    await env.DB.prepare(`UPDATE jobs SET ${assignments} WHERE id = ?3 AND ${ACTIVE}`).bind(error, now, id).run();
}

// ---------- Advancing a job ----------

export async function advanceJob(env: Env, ctx: ExecutionContext, rawId: string): Promise<Job> {
    const id = requireUuid(rawId, "job id");
    const row = await getJobRow(env, id);
    if (!row) throw new HttpError(404, "Job not found");
    if (isTerminal(row.status)) return viewJob(env, row);

    const now = Date.now();
    // Another request is saving the model right now; its lease only expires if it died.
    if (row.status === "finalizing" && now - Date.parse(row.updated_at) <= FINALIZE_LEASE_MS) {
        return viewJob(env, row);
    }
    // The vendor task is still being created by the request that started this job.
    if (!row.provider_task_id) {
        if (now - Date.parse(row.created_at) > SUBMIT_GRACE_MS) {
            await markFailed(env, id, "The request was interrupted before it reached the provider.");
            return reload(env, id);
        }
        return viewJob(env, row);
    }

    // At most one vendor poll per interval, however many tabs ask. The polled_at it writes doubles as this poll's
    // claim token: every write that follows is conditional on it still being there (see updateClaimed).
    const token = new Date(now).toISOString();
    const won = await env.DB.prepare(
        `UPDATE jobs SET polled_at = ?1 WHERE id = ?2 AND ${ACTIVE} AND (polled_at IS NULL OR polled_at < ?3)`,
    )
        .bind(token, id, new Date(now - POLL_INTERVAL_MS).toISOString())
        .run();
    if (won.meta.changes !== 1) return viewJob(env, row);
    const claim: PollClaim = { token, leaseCutoff: new Date(now - FINALIZE_LEASE_MS).toISOString() };

    const route = adapterFor(row.provider, row.via);
    if (!route) {
        await markFailed(env, id, "This model is no longer available.", claim);
        return reload(env, id);
    }
    const state = parseState(row.provider_state);

    let result: PollResult;
    try {
        result = await route.adapter.poll(env, row.provider_task_id, state);
    } catch (err) {
        console.error(`poll failed (${row.provider}/${row.via}): ${errorSummary(err)}`);
        return recordPollError(env, row, err, claim);
    }

    switch (result.status) {
        case "queued":
        case "running": {
            // The time cap judges what the vendor says now, after asking: a model that finished while nobody was
            // polling (a closed tab) is still saved, however long ago the job began.
            if (now - Date.parse(row.created_at) > MAX_RUNTIME_MS) {
                await tryCancel(env, route.adapter, row.provider_task_id, state);
                await markFailed(env, id, "The provider took longer than 30 minutes, so the job was stopped.", claim);
                return reload(env, id);
            }
            const estimate = Math.min(
                95,
                Math.round(((now - Date.parse(row.created_at)) / 1000 / route.spec.info.approx_seconds) * 90),
            );
            const progress = Math.max(row.progress, Math.min(99, Math.max(0, Math.round(result.progress ?? estimate))));
            await updateClaimed(
                env,
                id,
                claim,
                `status = ?1, progress = ?2, stage = ?3, provider_state = COALESCE(?4, provider_state),
                 poll_errors = 0, updated_at = ?5`,
                [
                    result.status,
                    progress,
                    result.stage ?? (result.status === "queued" ? "Queued" : "Generating"),
                    result.state ? JSON.stringify(result.state) : null,
                    nowIso(),
                ],
            );
            return reload(env, id);
        }
        case "failed":
            await markFailed(env, id, result.error || "The provider reported a failure.", claim);
            return reloadAndRelease(env, row);
        case "canceled": {
            const finished = nowIso();
            await updateClaimed(
                env,
                id,
                claim,
                "status = 'canceled', stage = 'Canceled', finished_at = ?1, updated_at = ?1",
                [finished],
            );
            return reloadAndRelease(env, row);
        }
        case "succeeded":
            return finalizeJob(env, ctx, row, result, claim);
    }
}

/**
 * A failed vendor poll keeps the job running; several in a row end it. Adapters normally absorb vendor hiccups
 * themselves (guardPoll), so what reaches here is either a definite error (a ProviderError that is not retryable:
 * bad key, no credits, task rejected) or something unexpected (network trouble, a parse error): the first fails the
 * job at once with its message, the second gets MAX_POLL_ERRORS tries.
 */
async function recordPollError(env: Env, row: JobRow, err: unknown, claim: PollClaim): Promise<Job> {
    if (err instanceof ProviderError && !err.retryable) {
        await markFailed(env, row.id, err.message, claim);
        return reload(env, row.id);
    }
    const errors = row.poll_errors + 1;
    if (errors >= MAX_POLL_ERRORS) {
        await markFailed(env, row.id, `Lost contact with the provider: ${safeMessage(err, "network error")}`, claim);
    } else {
        await updateClaimed(env, row.id, claim, "stage = 'Waiting for provider…', poll_errors = ?1, updated_at = ?2", [
            errors,
            nowIso(),
        ]);
    }
    return reload(env, row.id);
}

// ---------- Finalizing ----------

async function finalizeJob(
    env: Env,
    ctx: ExecutionContext,
    row: JobRow,
    result: Extract<PollResult, { status: "succeeded" }>,
    claim: PollClaim,
): Promise<Job> {
    // Copies that failed or died already used up the tries: stop asking the vendor for the same file.
    if (row.finalize_attempts >= MAX_FINALIZE_ATTEMPTS) {
        const error = "Could not save the generated model after several tries. Please generate it again.";
        await markFailed(env, row.id, error, claim);
        return reloadAndRelease(env, row); // the job is over: whatever the adapter staged for it can go
    }
    // The lease: only one request saves the model. A crashed one is retried after FINALIZE_LEASE_MS, and its
    // own late write then fails because updated_at no longer matches the token it holds.
    const token = nowIso();
    const claimed = await env.DB.prepare(
        `UPDATE jobs SET status = 'finalizing', stage = 'Saving model', progress = MAX(progress, 97),
         provider_state = COALESCE(?1, provider_state), poll_errors = 0, finalize_attempts = finalize_attempts + 1,
         updated_at = ?2
         WHERE id = ?3 AND (status IN ('queued', 'running') OR (status = 'finalizing' AND updated_at < ?4))
         RETURNING finalize_attempts`,
    )
        .bind(
            result.state ? JSON.stringify(result.state) : null,
            token,
            row.id,
            new Date(Date.now() - FINALIZE_LEASE_MS).toISOString(),
        )
        .first<{ finalize_attempts: number }>();
    if (!claimed) return reload(env, row.id);

    // waitUntil keeps the copy running even if the client that triggered it goes away.
    const work = saveModel(env, row, result, token, claimed.finalize_attempts);
    ctx.waitUntil(work.catch(() => {}));
    await work;
    return reload(env, row.id);
}

async function saveModel(
    env: Env,
    row: JobRow,
    result: Extract<PollResult, { status: "succeeded" }>,
    token: string,
    attempt: number,
): Promise<void> {
    const modelId = crypto.randomUUID();
    const glbKey = `models/${modelId}.glb`;
    let thumbKey: string | null = null;
    try {
        const stored = await storeGlb(env, result.glbUrl, glbKey);
        if (result.thumbnailUrl) thumbKey = await storeThumbnail(env, result.thumbnailUrl, modelId);
        const finished = nowIso();
        const [jobUpdate] = await env.DB.batch([
            env.DB.prepare(
                `UPDATE jobs SET status = 'succeeded', progress = 100, stage = 'Done', error = NULL, model_id = ?1,
                 finished_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'finalizing' AND updated_at = ?4`,
            ).bind(modelId, finished, row.id, token),
            env.DB.prepare(
                `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
                 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?3 AND model_id = ?1 AND status = 'succeeded')`,
            ).bind(
                modelId,
                row.project_id,
                row.id,
                row.provider,
                row.prompt,
                glbKey,
                thumbKey,
                stored.size,
                stored.partCount,
                finished,
            ),
            env.DB.prepare(
                "UPDATE projects SET modified_at = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM models WHERE id = ?3)",
            ).bind(finished, row.project_id, modelId),
        ]);
        if (jobUpdate.meta.changes !== 1) {
            // The lease was lost (another request took over, or the project was deleted): drop our copy.
            await deleteKeys(env, [glbKey, thumbKey]);
        } else {
            await releaseTask(env, row); // the model is ours now: the adapter's staging copy can go
        }
    } catch (err) {
        await deleteKeys(env, [glbKey, thumbKey]);
        // A problem with the file itself (not a GLB, too big, a 4xx) will not go away; anything else (a dropped
        // download, a 5xx, a D1 or R2 error) gets another go while tries remain.
        const fileProblem = err instanceof ModelFileError && !err.retryable;
        let message = "Could not save the generated model. Please try again.";
        if (err instanceof ModelFileError) message = err.message;
        else console.error(`finalize failed (${row.provider}): ${errorSummary(err)}`);
        try {
            const finished = nowIso();
            if (!fileProblem && attempt < MAX_FINALIZE_ATTEMPTS) {
                // Back to "running": the next poll asks the vendor again, which hands out a fresh result and URL.
                await env.DB.prepare(
                    `UPDATE jobs SET status = 'running', stage = 'Retrying the save', polled_at = ?1, updated_at = ?2
                     WHERE id = ?3 AND status = 'finalizing' AND updated_at = ?4`,
                )
                    .bind(new Date(Date.now() + RETRY_SAVE_DELAY_MS).toISOString(), finished, row.id, token)
                    .run();
            } else {
                const failed = await env.DB.prepare(
                    `UPDATE jobs SET status = 'failed', stage = 'Failed', error = ?1, finished_at = ?2, updated_at = ?2
                     WHERE id = ?3 AND status = 'finalizing' AND updated_at = ?4`,
                )
                    .bind(message, finished, row.id, token)
                    .run();
                // Over for good: the adapter's staging copy has no more use (the retry branch above keeps it for the next poll).
                if (failed.meta.changes === 1) await releaseTask(env, row);
            }
        } catch (dbErr) {
            // The job stays "finalizing" and is picked up again when its lease runs out.
            console.error(`finalize bookkeeping failed (${row.provider}): ${errorSummary(dbErr)}`);
        }
    }
}

async function deleteKeys(env: Env, keys: Array<string | null>): Promise<void> {
    const present = keys.filter((k): k is string => Boolean(k));
    if (present.length > 0) await env.FILES.delete(present).catch(() => {});
}

// ---------- Canceling ----------

export async function cancelJob(env: Env, request: Request, rawId: string): Promise<Job> {
    await assertAccess(env, request);
    const id = requireUuid(rawId, "job id");
    const row = await getJobRow(env, id);
    if (!row) throw new HttpError(404, "Job not found");
    // A finalizing job is moments from done; letting it finish beats leaving a half-saved model.
    if (row.status !== "queued" && row.status !== "running") return viewJob(env, row);

    const route = adapterFor(row.provider, row.via);
    // Refuse rather than pretend: the vendor would carry on and charge for a model nobody would ever see.
    if (route && !canBeStopped(route.adapter)) {
        throw new HttpError(
            409,
            "This model can't be stopped once it has started. It will finish in the background and appear in the project.",
        );
    }
    if (route && row.provider_task_id) {
        await tryCancel(env, route.adapter, row.provider_task_id, parseState(row.provider_state));
    }
    const now = nowIso();
    const canceled = await env.DB.prepare(
        `UPDATE jobs SET status = 'canceled', stage = 'Canceled', finished_at = ?1, updated_at = ?1
         WHERE id = ?2 AND status IN ('queued', 'running')`,
    )
        .bind(now, id)
        .run();
    // Whatever the adapter staged for a job that finished while Stop was on its way would otherwise stay (see releaseTask).
    if (canceled.meta.changes === 1) await releaseTask(env, row);
    return reload(env, id);
}
