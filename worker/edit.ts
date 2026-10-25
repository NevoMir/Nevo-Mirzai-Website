// POST /models/:sourceId/edits: start an edit by words on a model of a project. Two targets run on the Muse queue (spec 3.1 to 3.3, 5.1, 5.2):
//
//   design  the source is a Muse parts model. The consumer reads its GLB, asks the model for a PATCH (parts to add, change, remove), applies it
//           and builds the new GLB; the job engine then saves it as an "edited" version (worker/jobs.ts insertEditedModel). 5 to 13 s, $0.0004.
//   mesh    the source is a fused mesh (Hunyuan). The browser sends three labelled pictures and a few facts (the package, <= EDIT_PACKAGE_LIMIT as
//           JSON); the consumer asks the model for an EDIT PROGRAM, cleans it and leaves it in the job (jobs.plan). The browser applies it to the mesh
//           and uploads the result (worker/editUpload.ts). 15 to 30 s.
//
// The site has no login and anyone can call this, so nothing the client says is believed: the instruction is cleaned and bounded, the package is
// rebuilt field by field (only data: URLs of PNG/JPEG pictures, bounded text) before it is stored, the source must be a model of this project that
// the target can work on, the prompts and schemas are the server's, and the call is paid for from the day's AI-call cap (usage.llm). One edit per
// project runs at a time (the check is part of the job's INSERT). Nothing here calls Muse: that happens in the queue consumer (worker/llm.ts).

import { EDIT_INSTRUCTION_MAX, EDIT_PACKAGE_LIMIT, MESH_REFINE_OPS } from "../src/assignment/shared/contract.ts";
import type { Job, MeshPackage, MeshView, ModelKind } from "../src/assignment/shared/contract.ts";
import { cleanInstruction, designFromGlb } from "../src/assignment/shared/partsEdit.ts";
import { representationOf } from "../src/assignment/shared/versionMeta.ts";
import { assistLocked, requireAccess, startEditJob } from "./jobs.ts";
import { mockLlmEnabled } from "./providers/mock.ts";
import type { EditSubmit, Env } from "./providers/types.ts";
import { HttpError, isRecord, readJsonObject, requireUuid } from "./util.ts";
import { chainLengthSql, readVersionCounts, requireChainRoom, versionCapError } from "./versions.ts";

/** The request carries the package once (the zoomed pictures of a second pass would add another while MESH_REFINE_OPS is non-empty), plus a little text. */
const BODY_LIMIT = EDIT_PACKAGE_LIMIT * (MESH_REFINE_OPS.length > 0 ? 2 : 1) + 16 * 1024;
/** The source GLB of a design edit is 10 to 40 KB (120 parts); a file much bigger is not a parts design. */
const MAX_SOURCE_BYTES = 1024 * 1024;

const IMAGE_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const VIEW_ID = /^[A-Za-z0-9 _-]{1,16}$/;
const MAX_VIEWS = 6;

function text(value: unknown, what: string, max: number, min = 1): string {
    if (typeof value !== "string" || value.length < min || value.length > max) throw new HttpError(400, `${what} must be text of ${min} to ${max} characters`);
    return value;
}

function optionalText(value: unknown, what: string, max: number): string | null {
    if (value === null || value === undefined) return null;
    return text(value, what, max, 0);
}

function views(value: unknown, what: string): MeshView[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VIEWS) throw new HttpError(400, `${what} must list 1 to ${MAX_VIEWS} pictures`);
    return value.map((view, i) => {
        if (!isRecord(view)) throw new HttpError(400, `${what}[${i}] must be an object`);
        const image = view.image;
        if (typeof image !== "string" || !IMAGE_URL.test(image)) throw new HttpError(400, `${what}[${i}].image must be a PNG or JPEG data: URL`);
        const id = view.id;
        if (typeof id !== "string" || !VIEW_ID.test(id)) throw new HttpError(400, `${what}[${i}].id must be a short name`);
        return { id, caption: text(view.caption, `${what}[${i}].caption`, 400), image };
    });
}

/** The package the browser sent, rebuilt field by field: nothing unexpected is stored or sent to the model. `text` is its JSON (stored as it is). */
export function checkMeshPackage(value: unknown): { pkg: MeshPackage; text: string } {
    if (!isRecord(value) || value.version !== 1) throw new HttpError(400, "mesh must be a picture package of version 1");
    const frame = value.frame;
    const size = isRecord(frame) ? frame.size_mm : null;
    if (!isRecord(frame) || frame.facing !== "-Y" || !Array.isArray(size) || size.length !== 3 || !size.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10_000)) {
        throw new HttpError(400, "mesh.frame must give the size in millimetres and face -Y");
    }
    const pkg: MeshPackage = {
        version: 1,
        frame: { size_mm: [size[0] as number, size[1] as number, size[2] as number], facing: "-Y" },
        facts: text(value.facts, "mesh.facts", 3000),
        views: views(value.views, "mesh.views"),
        pieces: optionalText(value.pieces, "mesh.pieces", 3000),
        extras: optionalText(value.extras, "mesh.extras", 3000),
        original_prompt: optionalText(value.original_prompt, "mesh.original_prompt", 1000),
    };
    const json = JSON.stringify(pkg);
    if (json.length > EDIT_PACKAGE_LIMIT) throw new HttpError(413, `The pictures are too big (more than ${Math.round(EDIT_PACKAGE_LIMIT / 1024)} KB). Send smaller ones.`);
    return { pkg, text: json };
}

/** A second pass (off while MESH_REFINE_OPS is empty): the first program and the zoomed pictures of the region it selects. */
function checkRefine(value: unknown): { program: unknown; views: MeshView[] } {
    if (!isRecord(value) || !isRecord(value.program)) throw new HttpError(400, "refine must hold the first program and the zoomed pictures");
    if (JSON.stringify(value.program).length > 64 * 1024) throw new HttpError(413, "refine.program is too long");
    const zoom = views(value.views, "refine.views");
    if (JSON.stringify(zoom).length > EDIT_PACKAGE_LIMIT) throw new HttpError(413, "The zoomed pictures are too big.");
    return { program: value.program, views: zoom };
}

interface SourceRow {
    id: string;
    project_id: string;
    kind: string;
    provider: string;
    prompt: string;
    glb_key: string;
    meta: string | null;
    deleted_at: string | null;
    chain: number | null;
}

export async function handleStartEdit(env: Env, _ctx: ExecutionContext, request: Request, rawSourceId: string): Promise<Job> {
    await requireAccess(env, request);
    const sourceId = requireUuid(rawSourceId, "model id");
    const body = await readJsonObject(request, BODY_LIMIT);

    // Cheapest refusals first: nothing below touches D1 or the bucket until the request looks like an edit.
    const instruction = cleanInstruction(body.instruction);
    if (instruction === null) throw new HttpError(400, `instruction must be 1 to ${EDIT_INSTRUCTION_MAX} characters`);
    const target = body.target;
    if (target !== "design" && target !== "mesh") throw new HttpError(400, 'target must be "design" or "mesh"');
    let submit: EditSubmit | null = null;
    if (target === "mesh") {
        const { text } = checkMeshPackage(body.mesh);
        let refine: { program: unknown; views: MeshView[] } | null = null;
        if (body.refine !== undefined && body.refine !== null) {
            if (MESH_REFINE_OPS.length === 0) throw new HttpError(400, "A second pass is not available.");
            refine = checkRefine(body.refine);
        }
        // Put together by hand so the pictures (most of the 400 KB) are not serialised a second time.
        submit = { target: "mesh", request: `{"package":${text},"refine":${refine ? JSON.stringify(refine) : "null"}}`, refine: refine !== null };
    }
    if (assistLocked(env)) throw new HttpError(503, "Editing is disabled: ACCESS_CODE is not configured on the server.");
    if (!mockLlmEnabled(env) && !env.OPENROUTER_API_KEY?.trim()) throw new HttpError(503, "The AI editor is not set up on the server.");
    if (!env.LLM_QUEUE) throw new HttpError(503, "The design queue is not set up on the server.");

    const source = await env.DB.prepare(
        `SELECT m.id, m.project_id, m.kind, m.provider, m.prompt, m.glb_key, m.meta, p.deleted_at, ${chainLengthSql("m.id")} AS chain
         FROM models m JOIN projects p ON p.id = m.project_id WHERE m.id = ?1`,
    )
        .bind(sourceId)
        .first<SourceRow>();
    if (!source) throw new HttpError(404, "Model not found");
    if (source.deleted_at) throw new HttpError(409, "This project is in the bin. Restore it to edit.");

    const kind = source.kind as ModelKind;
    if (kind === "example") throw new HttpError(409, "Edits work on models you generate.");
    if (representationOf({ kind, meta: source.meta }) !== "mesh") {
        throw new HttpError(409, "This version is made of blocks. Change it from the Stability tab.");
    }
    if (!source.glb_key.startsWith("models/")) throw new HttpError(409, "Edits work on models you generate.");
    if (target === "design" && source.provider !== "muse") {
        throw new HttpError(409, "Only models made by Muse Spark can be changed by editing their parts. Change this one as a mesh.");
    }
    if (target === "mesh" && source.provider === "muse") {
        throw new HttpError(409, "This model is made of parts. Change it by editing its parts.");
    }
    // Early refusals. They are not the caps: parallel requests read the same counts, so the INSERT that saves the version checks them again.
    const full = versionCapError(await readVersionCounts(env, sourceId, source.project_id), target === "mesh");
    if (full) throw full;
    requireChainRoom(source.chain);

    if (target === "design") {
        // The parts must be readable now: a model whose design cannot be recovered fails here, not after a queue wait.
        const object = await env.FILES.get(source.glb_key);
        if (!object) throw new HttpError(404, "The model's file is missing.");
        if (object.size > MAX_SOURCE_BYTES) throw new HttpError(422, "This model's parts can't be read, so it can't be edited here.");
        if (!designFromGlb(new Uint8Array(await object.arrayBuffer()))) {
            throw new HttpError(422, "This model's parts can't be read, so it can't be edited here.");
        }
        submit = { target: "design", sourceGlbKey: source.glb_key, originalPrompt: source.prompt ? source.prompt.slice(0, 300) : null };
    }
    if (!submit) throw new HttpError(400, 'target must be "design" or "mesh"');

    return startEditJob(env, { projectId: source.project_id, sourceId, instruction, target, submit });
}
