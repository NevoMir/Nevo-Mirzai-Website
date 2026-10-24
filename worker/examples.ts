// Bundled examples: GET /examples lists them, POST /projects/from-example opens one as a new project.
//
// An example is a folder of static files shipped with the site (public/assignment_alex/examples/<slug>/):
//   original.glb     a generated-style model with structural problems (an ordinary mesh GLB)
//   stabilized.glb   its corrected block assembly (shared/assemblyGlb.ts), carrying the stabilizer's log
//   cover.png        512 x 384, the new project's card image (a PNG: the build has no WebP encoder; cover.webp is accepted too)
//   detail.json      { "derived": DerivedMeta } the full log (the manifest only carries the summary numbers)
// and a line in examples/manifest.json (ExampleSummary[]). scripts/assignment/make-examples.mjs writes all of it.
//
// Opening one creates a project and two model rows (one, for a control the stabilizer added nothing to) that POINT AT those
// files (glb_key "static:<path>"): nothing is generated, copied into R2 or paid for, creating a project is one D1 batch,
// and any number of projects share the same files. The only R2 write is the cover (about 40 KB), so the project has a card image in the hub straight away.
// purgeProjects never hands a "static:" key to R2, so deleting a project cannot delete an example.

import { APP_BASE, type ChatMessage, type ExampleSummary, type ExamplesResponse, type ProjectDetail } from "../src/assignment/shared/contract.ts";
import { checkAnalysisSummary } from "../src/assignment/shared/analysisSummary.ts";
import { readDerivedMeta } from "../src/assignment/shared/derivedMeta.ts";
import { MAX_PROJECTS, STATIC_KEY_PREFIX, getProjectDetail } from "./db.ts";
import type { Env } from "./providers/types.ts";
import { DEFAULT_PROJECT_NAME, HttpError, imageSize, isRecord, nowIso, sniffImageType } from "./util.ts";

const EXAMPLES_DIR = `${APP_BASE}/examples`;
const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const CACHE_MS = 5 * 60 * 1000;
// An empty list (no manifest yet, or every entry invalid) is looked at again soon: it is the state of a deploy in progress.
const EMPTY_CACHE_MS = 10 * 1000;
const COVER_LIMIT = 256 * 1024;
const COVER_FILE_RE = /^cover\.(png|webp)$/;
const COVER_MAX_SIDE = 2048;

let cached: { at: number; examples: ExampleSummary[] } | null = null;

async function fetchAsset(env: Env, path: string): Promise<Response> {
    return env.ASSETS.fetch(new Request(new URL(path, "https://assets.local")));
}

async function fetchJson(env: Env, path: string): Promise<unknown> {
    const res = await fetchAsset(env, path);
    const isJson = res.ok && !(res.headers.get("content-type") ?? "").includes("text/html"); // the SPA fallback answers a missing file with HTML
    if (!isJson) {
        await res.body?.cancel().catch(() => {});
        return null;
    }
    try {
        return await res.json();
    } catch {
        return null;
    }
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown, max = 1000): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** One manifest entry, rebuilt field by field; null when anything is off (that example is then left out of the list). */
function parseExample(value: unknown): ExampleSummary | null {
    if (!isRecord(value) || !isRecord(value.original) || !isRecord(value.stabilized)) return null;
    const { slug, title, prompt, blurb, tags, cover_url, version } = value;
    if (typeof slug !== "string" || !SLUG_RE.test(slug) || !text(title, 80) || !text(prompt, 200) || !text(blurb, 300) || !text(version, 16)) return null;
    if (!Array.isArray(tags) || tags.length > 8 || !tags.every((t) => text(t, 24))) return null;
    if (typeof cover_url !== "string" || !cover_url.startsWith(`${EXAMPLES_DIR}/${slug}/`) || !COVER_FILE_RE.test(cover_url.slice(`${EXAMPLES_DIR}/${slug}/`.length))) return null;
    const o = value.original;
    const s = value.stabilized;
    const oa = checkAnalysisSummary(o.analysis, null);
    const sa = checkAnalysisSummary(s.analysis, null);
    if (!oa.ok || !sa.ok) return null;
    if (!count(o.size_bytes, 5 * 1024 * 1024) || !count(s.size_bytes, 1024 * 1024) || !count(s.added_blocks)) return null;
    if (o.part_count !== null && !count(o.part_count, 10000)) return null;
    const before = readStepMetrics(s.before);
    const after = readStepMetrics(s.after);
    if (!before || !after) return null;
    return {
        slug,
        title,
        prompt,
        blurb,
        tags: [...(tags as string[])],
        cover_url,
        original: { size_bytes: o.size_bytes, part_count: (o.part_count as number | null) ?? null, analysis: oa.value },
        stabilized: { size_bytes: s.size_bytes, analysis: sa.value, added_blocks: s.added_blocks, before, after },
        version,
    };
}

function readStepMetrics(v: unknown): ExampleSummary["stabilized"]["before"] | null {
    if (!isRecord(v)) return null;
    const keys = ["blocks", "errors", "warnings", "floating_blocks", "over_limit", "longest_cantilever", "overstressed_blocks"] as const;
    if (!keys.every((k) => count(v[k]))) return null;
    const margin = v.cog_margin_mm === null ? null : typeof v.cog_margin_mm === "number" && Number.isFinite(v.cog_margin_mm) ? v.cog_margin_mm : undefined;
    const util = v.max_utilisation === null ? null : typeof v.max_utilisation === "number" && Number.isFinite(v.max_utilisation) && v.max_utilisation >= 0 && v.max_utilisation <= 50 ? v.max_utilisation : undefined;
    if (margin === undefined || util === undefined) return null;
    const n = v as Record<(typeof keys)[number], number>;
    return {
        blocks: n.blocks,
        errors: n.errors,
        warnings: n.warnings,
        floating_blocks: n.floating_blocks,
        over_limit: n.over_limit,
        longest_cantilever: n.longest_cantilever,
        cog_margin_mm: margin,
        max_utilisation: util,
        overstressed_blocks: n.overstressed_blocks,
    };
}

export async function listExamples(env: Env): Promise<ExamplesResponse> {
    if (cached && Date.now() - cached.at < (cached.examples.length > 0 ? CACHE_MS : EMPTY_CACHE_MS)) return { examples: cached.examples };
    const raw = await fetchJson(env, `${EXAMPLES_DIR}/manifest.json`);
    const list = isRecord(raw) && Array.isArray(raw.examples) ? raw.examples : [];
    const seen = new Set<string>();
    const examples: ExampleSummary[] = [];
    for (const entry of list.slice(0, 24)) {
        const parsed = parseExample(entry);
        if (parsed && !seen.has(parsed.slug)) {
            seen.add(parsed.slug);
            examples.push(parsed);
        }
    }
    cached = { at: Date.now(), examples };
    return { examples };
}

/** The assistant's opening line for a project made from an example. Plain text with **bold**, as the chat renders it. */
function openingLine(example: ExampleSummary): string {
    const before = example.stabilized.before;
    const problems = before.errors > 0 ? `${before.errors} ${before.errors === 1 ? "problem" : "problems"}` : before.warnings > 0 ? `${before.warnings} ${before.warnings === 1 ? "warning" : "warnings"}` : "no problems";
    const after = example.stabilized.after;
    const added = example.stabilized.added_blocks;
    // A control: the model stands as it is, so there is no second version to open (a copy with the same blocks would only confuse).
    if (added === 0) {
        return `Opened the example **${example.title}**. The generated model has ${problems}, so the stabilizer has nothing to add and there is only the original. Open Analysis to see the checks it passes.`;
    }
    return `Opened the example **${example.title}**. The generated model has ${problems}. Stabilizing it added ${added} ${added === 1 ? "block" : "blocks"}${after.errors === 0 ? " and it now passes every check" : ""}. Both versions are in the Models tab.`;
}

/** POST /projects/from-example. Resolves to the new project, ready to show. */
export async function createProjectFromExample(env: Env, slug: unknown, tagId: string | undefined): Promise<ProjectDetail> {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new HttpError(400, "slug must be the name of an example");
    const example = (await listExamples(env)).examples.find((e) => e.slug === slug);
    if (!example) throw new HttpError(404, "Example not found");
    const detail = await fetchJson(env, `${EXAMPLES_DIR}/${slug}/detail.json`);
    const derived = isRecord(detail) ? readDerivedMeta(detail.derived) : null;
    if (!derived) throw new HttpError(404, "Example not found");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PROJECTS) throw new HttpError(429, "Project limit reached. Delete some projects first.");
    if (tagId && !(await env.DB.prepare("SELECT 1 AS ok FROM tags WHERE id = ?1").bind(tagId).first())) throw new HttpError(404, "Tag not found");

    const projectId = crypto.randomUUID();
    const originalId = crypto.randomUUID();
    // An example the stabilizer added nothing to (a control that already passes) has no stabilized version: only the original is made.
    const stabilizedId = example.stabilized.added_blocks > 0 ? crypto.randomUUID() : null;
    const now = nowIso();
    const messages: ChatMessage[] = [
        { id: crypto.randomUUID(), role: "user", content: example.prompt, timestamp: now },
        { id: crypto.randomUUID(), role: "assistant", content: openingLine(example), timestamp: now, model_ids: stabilizedId ? [originalId, stabilizedId] : [originalId] },
    ];
    const data = JSON.stringify({ messages, active_model_id: originalId });
    const originalKey = `${STATIC_KEY_PREFIX}${EXAMPLES_DIR}/${slug}/original.glb`;
    const stabilizedKey = `${STATIC_KEY_PREFIX}${EXAMPLES_DIR}/${slug}/stabilized.glb`;
    const insertModel = (id: string, kind: "example" | "stabilized", key: string, size: number, parts: number | null, analysis: unknown, sourceId: string | null, hash: string | null, meta: unknown) =>
        env.DB.prepare(
            `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at,
                                 analysis, kind, source_model_id, example_slug, assembly_hash, meta)
             VALUES (?1, ?2, '', ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        ).bind(id, projectId, kind === "example" ? "example" : "stabilizer", example.prompt, key, size, parts, now, JSON.stringify(analysis), kind, sourceId, slug, hash, meta === null ? null : JSON.stringify(meta));

    const statements = [
        env.DB.prepare("INSERT INTO projects (id, name, data, created_at, modified_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(projectId, example.title || DEFAULT_PROJECT_NAME, data, now),
        insertModel(originalId, "example", originalKey, example.original.size_bytes, example.original.part_count, example.original.analysis, null, null, null),
    ];
    if (stabilizedId) {
        statements.push(
            insertModel(stabilizedId, "stabilized", stabilizedKey, example.stabilized.size_bytes, 1 + Object.keys(derived.added_by_role).length, derived.after_summary, originalId, derived.assembly_hash, derived),
        );
    }
    if (tagId) statements.push(env.DB.prepare("INSERT INTO project_tags (project_id, tag_id, created_at) VALUES (?1, ?2, ?3)").bind(projectId, tagId, now));
    await env.DB.batch(statements);

    // The cover becomes the project's card image. A failure here only means the hub shows no picture until the first visit.
    try {
        const res = await fetchAsset(env, example.cover_url);
        if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            // The same checks as PUT /projects/:id/thumbnail: the bytes are the type they say, and the size is sane.
            const type = bytes.byteLength > 0 && bytes.byteLength <= COVER_LIMIT ? sniffImageType(bytes) : null;
            const size = type ? imageSize(bytes, type) : null;
            if (!type || !size || size.width < 1 || size.height < 1 || size.width > COVER_MAX_SIDE || size.height > COVER_MAX_SIDE) throw new Error("cover");
            const key = `thumbs/${projectId}`;
            await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
            await env.DB.prepare("UPDATE projects SET thumbnail_key = ?1, thumbnail_version = 1 WHERE id = ?2").bind(key, projectId).run();
        } else await res.body?.cancel().catch(() => {});
    } catch {
        // no cover
    }
    const project = await getProjectDetail(env, projectId);
    if (!project) throw new Error("project vanished after insert");
    return project;
}

