// The JSON API under /api/assignment_alex: routing, request validation and error shaping.
// Handlers live next to their data (db.ts, jobs.ts, files.ts); this file only wires and validates.

import { API_BASE } from "../src/assignment/shared/contract.ts";
import type { BulkAction, ChatMessage, ProjectData } from "../src/assignment/shared/contract.ts";
import { ANALYSIS_BODY_LIMIT, parseAnalysisSummary } from "./analysis.ts";
import {
    bulkProjects,
    bulkTag,
    createProject,
    createTag,
    deleteTag,
    getProjectDetail,
    listProjectsAndTags,
    listTags,
    patchProject,
    patchTag,
    saveModelAnalysis,
    type ProjectPatch,
    type TagPatch,
} from "./db.ts";
import { createDerivedModel, deleteDerivedModel } from "./derived.ts";
import { createProjectFromExample, listExamples } from "./examples.ts";
import { putThumbnail, serveFile } from "./files.ts";
import { advanceJob, cancelJob, checkAccessCode, getProvidersResponse, startGeneration } from "./jobs.ts";
import type { Env } from "./providers/types.ts";
import {
    HttpError,
    errorSummary,
    isRecord,
    isSchemaMismatch,
    isUuid,
    json,
    jsonError,
    parseColor,
    parseIcon,
    parseIdList,
    parseName,
    readJsonObject,
    requireUuid,
} from "./util.ts";

const BULK_ACTIONS: readonly BulkAction[] = ["trash", "restore", "archive", "unarchive", "purge"];

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
        return await route(request, env, ctx);
    } catch (err) {
        if (err instanceof HttpError) return jsonError(err.status, err.message, err.headers);
        // The Worker is newer than its database: say so in the log (with the fix) and tell the visitor to retry soon,
        // instead of an anonymous 500 on every project.
        if (isSchemaMismatch(err)) {
            console.error(`database schema is out of date, apply the migrations (npx wrangler d1 migrations apply assignment-alex --remote): ${errorSummary(err)}`);
            return jsonError(503, "The server is being updated. Please try again in a few minutes.", { "Retry-After": "60" });
        }
        // Never echo internals (stack traces, SQL, vendor bodies) to the client.
        console.error(`unhandled error: ${errorSummary(err)}`);
        return jsonError(500, "Something went wrong on the server. Please try again.");
    }
}

function methodNotAllowed(...allowed: string[]): never {
    throw new HttpError(405, "Method not allowed", { Allow: allowed.join(", ") });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.slice(API_BASE.length).split("/").filter(Boolean);
    const method = request.method === "HEAD" ? "GET" : request.method;
    const [resource, a, b] = segments;

    switch (resource) {
        case "providers":
            if (segments.length !== 1) break;
            if (method !== "GET") methodNotAllowed("GET", "HEAD");
            return json(await getProvidersResponse(env));

        case "access":
            if (a !== "check" || segments.length !== 2) break;
            if (method !== "POST") methodNotAllowed("POST");
            return json({ ok: await checkAccessCode(env, request, (await readJsonObject(request)).code) });

        case "projects":
            return projectRoutes(request, env, method, segments);

        case "tags":
            return tagRoutes(request, env, method, segments);

        case "jobs":
            if (!a || (segments.length !== 2 && !(segments.length === 3 && b === "cancel"))) break;
            if (segments.length === 2) {
                if (method !== "GET") methodNotAllowed("GET", "HEAD");
                return json({ job: await advanceJob(env, ctx, a) });
            }
            if (method !== "POST") methodNotAllowed("POST");
            return json({ job: await cancelJob(env, request, a) });

        case "models": {
            if (!a) break;
            // DELETE /models/:id: a stabilized version only.
            if (segments.length === 2) {
                if (method !== "DELETE") methodNotAllowed("DELETE");
                await deleteDerivedModel(env, a);
                return json({ ok: true });
            }
            if (segments.length !== 3) break;
            // POST /models/:sourceId/derived: store a stabilized version (raw GLB body, see worker/derived.ts).
            if (b === "derived") {
                if (method !== "POST") methodNotAllowed("POST");
                const { status, model } = await createDerivedModel(env, request, a);
                return json({ model }, status);
            }
            // PUT /models/:id/analysis. Open like the rest of the API except generation: it costs nothing and only
            // overwrites derived data. A malformed id or summary is a 400, a well-formed unknown id a 404.
            if (b !== "analysis") break;
            if (method !== "PUT") methodNotAllowed("PUT");
            const id = requireUuid(a, "model id");
            const summary = parseAnalysisSummary(await readJsonObject(request, ANALYSIS_BODY_LIMIT));
            const model = await saveModelAnalysis(env, id, summary);
            if (!model) throw new HttpError(404, "Model not found");
            return json({ model });
        }

        case "examples":
            if (segments.length !== 1) break;
            if (method !== "GET") methodNotAllowed("GET", "HEAD");
            // The list changes only with a deploy. An empty one is not cached: it is a deploy in progress, not an answer.
            {
                const list = await listExamples(env);
                return json(list, 200, list.examples.length > 0 ? { "Cache-Control": "public, max-age=300" } : undefined);
            }

        case "files":
            if (!a || !b || segments.length !== 3) break;
            if (request.method !== "GET" && request.method !== "HEAD") methodNotAllowed("GET", "HEAD");
            return serveFile(request, env, a, b);
    }
    throw new HttpError(404, "Not found");
}

// ---------- Projects ----------

async function projectRoutes(
    request: Request,
    env: Env,
    method: string,
    segments: string[],
): Promise<Response> {
    const count = segments.length;
    const [, a, b] = segments;
    // /projects
    if (count === 1) {
        if (method === "GET") return json(await listProjectsAndTags(env));
        if (method === "POST") {
            const body = await readJsonObject(request);
            const name = body.name === undefined || body.name === null ? undefined : parseName(body.name);
            const tagId = body.tag_id === undefined || body.tag_id === null ? undefined : requireUuid(body.tag_id, "tag id");
            return json({ project: await createProject(env, name, tagId) }, 201);
        }
        methodNotAllowed("GET", "HEAD", "POST");
    }

    // /projects/bulk and /projects/tags are literal paths, matched before /projects/:id.
    if (count === 2 && a === "bulk") {
        if (method !== "POST") methodNotAllowed("POST");
        const body = await readJsonObject(request);
        const ids = parseIdList(body.ids);
        const action = body.action;
        if (typeof action !== "string" || !BULK_ACTIONS.includes(action as BulkAction)) {
            throw new HttpError(400, `action must be one of ${BULK_ACTIONS.join(", ")}`);
        }
        return json({ count: await bulkProjects(env, ids, action as BulkAction) });
    }
    // POST /projects/from-example: a project that holds a bundled example (worker/examples.ts).
    if (count === 2 && a === "from-example") {
        if (method !== "POST") methodNotAllowed("POST");
        const body = await readJsonObject(request);
        const tagId = body.tag_id === undefined || body.tag_id === null ? undefined : requireUuid(body.tag_id, "tag id");
        return json({ project: await createProjectFromExample(env, body.slug, tagId) }, 201);
    }
    if (count === 2 && a === "tags") {
        if (method !== "POST") methodNotAllowed("POST");
        const body = await readJsonObject(request);
        const ids = parseIdList(body.ids);
        const tagId = requireUuid(body.tag_id, "tag id");
        if (typeof body.add !== "boolean") throw new HttpError(400, "add must be true or false");
        return json({ count: await bulkTag(env, ids, tagId, body.add) });
    }

    const id = requireUuid(a, "project id");

    // /projects/:id
    if (count === 2) {
        if (method === "GET") {
            const project = await getProjectDetail(env, id);
            if (!project) throw new HttpError(404, "Project not found");
            return json({ project });
        }
        if (method === "PATCH") {
            return json({ project: await patchProject(env, id, parseProjectPatch(await readJsonObject(request))) });
        }
        methodNotAllowed("GET", "HEAD", "PATCH");
    }

    // /projects/:id/thumbnail and /projects/:id/generate
    if (count === 3 && b === "thumbnail") {
        if (method !== "PUT") methodNotAllowed("PUT");
        return putThumbnail(request, env, id);
    }
    if (count === 3 && b === "generate") {
        if (method !== "POST") methodNotAllowed("POST");
        const jobs = await startGeneration(env, request, id, await readJsonObject(request));
        return json({ jobs });
    }
    throw new HttpError(404, "Not found");
}

function parseProjectPatch(body: Record<string, unknown>): ProjectPatch {
    const patch: ProjectPatch = {};
    if (body.name !== undefined) patch.name = parseName(body.name);
    if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") throw new HttpError(400, "pinned must be true or false");
        patch.pinned = body.pinned;
    }
    if (body.data !== undefined) patch.data = parseProjectData(body.data);
    return patch;
}

// A chat longer than this keeps its newest messages: saving must not fail for good once a conversation grows.
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 4000;
const MAX_MESSAGE_JOBS = 10;
const MAX_MESSAGE_MODELS = 10;

/** Checks the workspace data and rebuilds it field by field, so nothing unexpected is stored or served back. */
function parseProjectData(value: unknown): ProjectData {
    if (!isRecord(value) || !Array.isArray(value.messages)) {
        throw new HttpError(400, "data must be an object with a messages array");
    }
    const active = value.active_model_id;
    if (active !== null && !isUuid(active)) {
        throw new HttpError(400, "data.active_model_id must be a model id or null");
    }
    const dropped = Math.max(0, value.messages.length - MAX_MESSAGES);
    const messages = value.messages.slice(dropped).map((message, i) => parseChatMessage(message, dropped + i));
    return { messages, active_model_id: active };
}

function parseChatMessage(value: unknown, index: number): ChatMessage {
    const bad = (why: string) => new HttpError(400, `data.messages[${index}] ${why}`);
    if (!isRecord(value)) throw bad("must be an object");
    const { id, role, content, timestamp, job_ids, model_ids } = value;
    if (typeof id !== "string" || id.length < 1 || id.length > 64) throw bad("needs an id of 1 to 64 characters");
    if (role !== "user" && role !== "assistant") throw bad('needs a role of "user" or "assistant"');
    if (typeof content !== "string" || content.length > MAX_MESSAGE_CHARS) {
        throw bad(`needs content of at most ${MAX_MESSAGE_CHARS} characters`);
    }
    if (typeof timestamp !== "string" || timestamp.length < 1 || timestamp.length > 40) throw bad("needs a timestamp");
    const message: ChatMessage = { id, role, content, timestamp };
    if (job_ids !== undefined) {
        if (!Array.isArray(job_ids) || job_ids.length > MAX_MESSAGE_JOBS || !job_ids.every(isUuid)) {
            throw bad("has invalid job_ids");
        }
        message.job_ids = job_ids;
    }
    if (model_ids !== undefined) {
        if (!Array.isArray(model_ids) || model_ids.length > MAX_MESSAGE_MODELS || !model_ids.every(isUuid)) {
            throw bad("has invalid model_ids");
        }
        message.model_ids = model_ids;
    }
    return message;
}

// ---------- Tags ----------

async function tagRoutes(
    request: Request,
    env: Env,
    method: string,
    segments: string[],
): Promise<Response> {
    const count = segments.length;
    const rawId = segments[1];
    if (count === 1) {
        if (method === "GET") return json({ tags: await listTags(env) });
        if (method === "POST") {
            const body = await readJsonObject(request);
            const tag = await createTag(env, parseName(body.name), parseIcon(body.icon), parseColor(body.color));
            return json({ tag }, 201);
        }
        methodNotAllowed("GET", "HEAD", "POST");
    }
    if (count !== 2) throw new HttpError(404, "Not found");

    const id = requireUuid(rawId, "tag id");
    if (method === "PATCH") {
        const body = await readJsonObject(request);
        const patch: TagPatch = {};
        if (body.name !== undefined) patch.name = parseName(body.name);
        if (body.icon !== undefined) patch.icon = parseIcon(body.icon);
        if (body.color !== undefined) patch.color = parseColor(body.color);
        return json({ tag: await patchTag(env, id, patch) });
    }
    if (method === "DELETE") {
        await deleteTag(env, id);
        return json({ ok: true });
    }
    return methodNotAllowed("PATCH", "DELETE");
}
