// A mesh edit program: the short list of operations Muse Spark plans for a fused mesh (Hunyuan) from three labelled pictures, and
// everything both sides need to agree on: the types, the request (strict JSON schema + system prompt + the user message), and the
// cleaner that turns an untrusted answer into a program the browser can run. Pure TypeScript, no DOM and no Workers imports: the
// queue consumer (worker/llm.ts), the browser (edit/*) and the Node tests share it.
//
// Frame: millimetres, Z up, ground z = 0, x/y centred, the whole model scaled so its longest side is 1000 mm (the edit frame, spec 5.2).
//
//   MESH_PROGRAM_SCHEMA / MESH_SYSTEM_PROMPT   the request
//   meshUserText(pkg, instruction)             the text part of the user message (the pictures travel next to it)
//   sanitizeProgram(raw)                       an untrusted model answer -> a clean program (or why not); never throws
//   toExecutorOp(op)                           the flat op the schema forces -> the executor's op (where = boxes / exclude / feather)

import { MAX_ADDED_PARTS, MAX_MESH_OPS, MESH_REFINE_OPS, type MeshOpName, type MeshPackage } from "./contract.ts";
import { MAX_PART_MM, MIN_PART_MM, MUSE_SYSTEM_PROMPT, PART_SHAPES, cleanColor, torusTube, uniqueNames, type DesignPart, type PartShape } from "./partsDesign.ts";

export type MeshVec3 = [number, number, number];

/** An axis-aligned box of the edit frame, mm. After cleaning min <= max on every axis and each side is at least 1 mm. */
export interface MeshBox {
    min: MeshVec3;
    max: MeshVec3;
}

/**
 * One operation as sanitizeProgram returns it (the flat strict-schema form: every op carries a selection and only the fields its kind
 * uses are meaningful). The executor reads `where` = { boxes, exclude, feather_mm } through toExecutorOp.
 */
export interface MeshOp {
    op: MeshOpName;
    label: string; // plain-English name of what the op acts on ("left armrest"), <= 60
    boxes: MeshBox[]; // the selection; empty = the whole model (never for delete and mirror_copy)
    exclude: MeshBox[]; // taken out of the selection
    feather_mm: number; // 0.5 to 200
    axis: "x" | "y" | "z";
    from_mm?: number; // stretch
    to_mm?: number;
    amount_mm?: number; // stretch (non-zero)
    vector_mm?: MeshVec3; // move
    factors?: MeshVec3; // scale
    pivot_mm?: MeshVec3; // scale, rotate
    degrees?: number; // rotate
    mirror_at_mm?: number; // mirror_copy
    color?: string; // recolor: #rrggbb
    strength?: number; // recolor: 0..1
    parts?: DesignPart[]; // add_parts: millimetres in the same frame
}

/** A cleaned program. `applied: false` means the model said the request cannot be done: ops is empty and `summary` says why. */
export interface MeshProgram {
    summary: string; // <= 160
    applied: boolean;
    ops: MeshOp[]; // at most MAX_MESH_OPS
}

/** What the executor runs: an op plus its selection in one object. */
export interface ExecutorOp extends MeshOp {
    where: { boxes: MeshBox[]; exclude: MeshBox[]; feather_mm: number };
}

export const toExecutorOp = (o: MeshOp): ExecutorOp => ({ ...o, where: { boxes: o.boxes, exclude: o.exclude, feather_mm: o.feather_mm } });

/**
 * A cleaned program back in the flat strict-schema shape the model answers in (every op field present, unused ones neutral): what the
 * second pass shows the model as its own first answer. cleaning this gives the same program again.
 */
export function flatAnswerOf(program: MeshProgram, regenPrompt: string | null = null): Record<string, unknown> {
    return {
        summary: program.summary,
        applied: program.applied,
        ops: program.ops.map((o) => ({
            op: o.op,
            label: o.label,
            boxes: o.boxes,
            exclude: o.exclude,
            feather_mm: o.feather_mm,
            axis: o.axis,
            from_mm: o.from_mm ?? 0,
            to_mm: o.to_mm ?? 0,
            amount_mm: o.amount_mm ?? 0,
            vector_mm: o.vector_mm ?? [0, 0, 0],
            factors: o.factors ?? [1, 1, 1],
            pivot_mm: o.pivot_mm ?? [0, 0, 0],
            degrees: o.degrees ?? 0,
            mirror_at_mm: o.mirror_at_mm ?? 0,
            color: o.color ?? "#000000",
            strength: o.strength ?? 0,
            parts: o.parts ?? [],
        })),
        regen_prompt: regenPrompt ?? "",
    };
}

export const MESH_OP_NAMES: readonly MeshOpName[] = ["stretch", "move", "scale", "rotate", "delete", "recolor", "add_parts", "mirror_copy"];

/** Ops whose result depends on how tight the selection is (the second pass, MESH_REFINE_OPS, looks at these). */
export const needsRefine = (program: Pick<MeshProgram, "ops">): boolean => program.ops.some((o) => (MESH_REFINE_OPS as readonly string[]).includes(o.op));

// ---------- the request ----------

const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const BOX = { type: "object", additionalProperties: false, required: ["min", "max"], properties: { min: V3, max: V3 } } as const;
const PART = {
    type: "object",
    additionalProperties: false,
    required: ["name", "shape", "size", "position", "rotation", "color"],
    properties: {
        name: { type: "string" },
        shape: { type: "string", enum: [...PART_SHAPES] },
        size: V3,
        position: V3,
        rotation: V3,
        color: { type: "string" },
    },
} as const;

/** The `json_schema` of OpenRouter's response_format (strict). Flat: strict mode wants every field of an op, unused ones carry neutral values. */
export const MESH_PROGRAM_SCHEMA = {
    name: "mesh_edit_program",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "applied", "ops", "regen_prompt"],
        properties: {
            summary: { type: "string" },
            applied: { type: "boolean" },
            ops: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["op", "label", "boxes", "exclude", "feather_mm", "axis", "from_mm", "to_mm", "amount_mm", "vector_mm", "factors", "pivot_mm", "degrees", "mirror_at_mm", "color", "strength", "parts"],
                    properties: {
                        op: { type: "string", enum: [...MESH_OP_NAMES] },
                        label: { type: "string" },
                        boxes: { type: "array", items: BOX },
                        exclude: { type: "array", items: BOX },
                        feather_mm: { type: "number" },
                        axis: { type: "string", enum: ["x", "y", "z"] },
                        from_mm: { type: "number" },
                        to_mm: { type: "number" },
                        amount_mm: { type: "number" },
                        vector_mm: V3,
                        factors: V3,
                        pivot_mm: V3,
                        degrees: { type: "number" },
                        mirror_at_mm: { type: "number" },
                        color: { type: "string" },
                        strength: { type: "number" },
                        parts: { type: "array", items: PART },
                    },
                },
            },
            // Last on purpose: the model plans the ops first. Used by "Generate it again" (a new model from the original prompt + the change).
            regen_prompt: { type: "string" },
        },
    },
} as const;

/** The units / size / rotation paragraph of the parts designer's prompt, without its first sentence (the part format of add_parts). */
const PARTS_FORMAT = MUSE_SYSTEM_PROMPT.split(" The object fits")[0].replace(/^You design[^.]*\. /, "");

export const MESH_SYSTEM_PROMPT =
    "You edit a textured 3D model (one fused mesh made by a text-to-3D generator, no separate parts) by writing a short EDIT PROGRAM that the app runs on the mesh. " +
    "Coordinates are millimetres, X/Y horizontal, Z up, the ground is z = 0; the model is centred on X/Y and scaled so its longest side is 1000 mm. " +
    "You get three orthographic pictures (FRONT, SIDE, TOP) with a labelled 100 mm grid, and a few facts. Read positions off the grid. " +
    "Each op acts on a SELECTION: `boxes` = axis-aligned boxes {min:[x,y,z], max:[x,y,z]} in mm that together cover the part to change (leave `boxes` empty to select the whole model), " +
    "`exclude` = boxes taken out of the selection, `feather_mm` = softness of the selection edge (20-60 for deformations, 1-5 for delete). Make boxes tight: they must contain the part and as little else as possible. " +
    'Ops (fill only the fields an op uses; give every other field a neutral value: [0,0,0] vectors, [1,1,1] factors, 0 numbers, "#000000", "x", empty lists): ' +
    "stretch = make something taller/longer/wider: along `axis`, material between from_mm and to_mm is stretched by amount_mm and everything beyond to_mm inside the selection moves by amount_mm (the selection's range along `axis` is ignored, only its footprint counts; put from_mm above whatever must not change); " +
    "move = shift the selection by vector_mm; scale = scale the selection by `factors` (per axis, 1 = unchanged) about pivot_mm; rotate = turn it by `degrees` about `axis` through pivot_mm; " +
    "delete = remove the selection (use a box that contains the whole piece, supports included, and nothing else); " +
    "recolor = tint the selection to `color` (#rrggbb) with `strength` 0-1, keeping the shading and texture detail (empty `boxes` = the whole model); " +
    "add_parts = add new primitive parts (`parts`, same format as below, millimetres in this same frame) that TOUCH or slightly overlap the surface of the model; " +
    "mirror_copy = copy the selection mirrored about the plane `axis` = mirror_at_mm (to add a matching part on the other side). " +
    `Part format for add_parts: ${PARTS_FORMAT} ` +
    "Rules: (1) Do exactly what was asked, with as few ops as possible, in the order they should run. (2) Left and right are the object's own (as seen by someone using it), as given in the facts. " +
    "(3) Never select more than needed; do not cut through things the user did not mention. (4) `label` = the plain-English name of what the op acts on (\"left armrest\"). " +
    "(5) summary = one plain sentence (at most 100 characters) saying what was done. (6) If the request cannot be done with these ops, or is not about this object, set applied to false, ops empty, and say why in the summary. " +
    "(7) Where a part ends in free air put the box face about 10 mm beyond it; where it joins something that must stay, put the face exactly at the joint. " +
    "Use `exclude` only to protect neighbours, never to keep a piece of what you are deleting. " +
    "Positive `degrees` = counter-clockwise seen from +axis toward the origin (right-hand rule). " +
    "(8) For a stretch the box must cover the footprint of the part over its WHOLE height: a part that leans (a chair back) sits further back at the top than at the bottom, so read its footprint at the top and at the bottom in the SIDE picture and make the box wide enough for both, with about 50 mm to spare on every side in X and Y " +
    "(a footprint a little too wide is harmless because only what is above from_mm moves; one a little too narrow tears the part, and knobs and rails at the top often reach further out than the shaft below them). " +
    "(9) regen_prompt: when the facts give an Original description, rewrite it as ONE description of the object with the requested change included (at most 400 characters); otherwise an empty string.";

/** The "Model facts" line the model reads next to the pictures. `colors` are plain words ("orange-brown wood"). */
export function factsText(a: { sizeMm: readonly number[]; tris: number; facing?: "-Y"; textured?: boolean; colors?: readonly string[] }): string {
    const textured = a.textured ?? true;
    return (
        `Model facts: size X ${Math.round(a.sizeMm[0])} mm, Y ${Math.round(a.sizeMm[1])} mm, Z ${Math.round(a.sizeMm[2])} mm; ${Math.round(a.tris).toLocaleString("en-US")} triangles; ` +
        `${textured ? "textured" : "untextured"}; main colours ${a.colors && a.colors.length > 0 ? a.colors.join(", ") : "n/a"}. ` +
        "The object faces -Y (toward you in the FRONT picture); its up is +Z; its LEFT hand side is +X and its RIGHT is -X; its back is +Y."
    );
}

/** One line, no control characters: the instruction as it goes into the prompt. */
export const oneLine = (text: string, max = 500): string =>
    // eslint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The text part of the first-pass user message: facts, the other pieces of the package, the picture captions, the instruction. The
 * pictures (`pkg.views[].image`) go next to it as image parts, in the same order.
 */
export function meshUserText(pkg: Pick<MeshPackage, "facts" | "views" | "pieces" | "extras" | "original_prompt">, instruction: string): string {
    const lines = [pkg.facts];
    if (pkg.extras) lines.push(oneLine(pkg.extras, 1500));
    if (pkg.pieces) lines.push(oneLine(pkg.pieces, 1500));
    if (pkg.original_prompt) lines.push(`Original description: ${JSON.stringify(oneLine(pkg.original_prompt, 600))}`);
    for (const view of pkg.views) lines.push(view.caption);
    return `${lines.join("\n")}\n\nEdit instruction: ${oneLine(instruction)}`;
}

/** The user turn that follows the model's own first program in the second pass (zoomed pictures with the selection in red). */
export const REFINE_USER_TEXT =
    "Second pass. Below are ZOOMED pictures (grid line every 20 mm, stronger line every 100 mm) of the region around your first selection, which is tinted RED. " +
    "Read exact extents from them. Check against the instruction: is every part of the target red, and is nothing else red? " +
    "Where the target ends in free air, put the box face about 10 mm beyond it; where it joins something that must stay, put the face exactly at the joint. " +
    "Return the corrected full program (the same program if it was already right).";

// ---------- cleaning an untrusted answer ----------

const LIMIT_MM = 3000;
const AXES = ["x", "y", "z"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, lo: number, hi: number, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback);
const vec = (value: unknown, lo: number, hi: number, fallback: MeshVec3): MeshVec3 =>
    Array.isArray(value) && value.length === 3 ? [num(value[0], lo, hi, fallback[0]), num(value[1], lo, hi, fallback[1]), num(value[2], lo, hi, fallback[2])] : [fallback[0], fallback[1], fallback[2]];
const text = (value: unknown, max: number): string =>
    // eslint-disable-next-line no-control-regex
    typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trimEnd() : "";

/** Degrees folded into (-180, 180]. */
function foldAngle(n: number): number {
    const folded = ((((n + 180) % 360) + 360) % 360) - 180;
    return folded === -180 ? 180 : folded;
}

function cleanBox(value: unknown): MeshBox | null {
    if (!isRecord(value) || !Array.isArray(value.min) || !Array.isArray(value.max) || value.min.length !== 3 || value.max.length !== 3) return null;
    const a = vec(value.min, -LIMIT_MM, LIMIT_MM, [0, 0, 0]);
    const b = vec(value.max, -LIMIT_MM, LIMIT_MM, [0, 0, 0]);
    const min: MeshVec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const max: MeshVec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    for (let i = 0; i < 3; i++) if (max[i] - min[i] < 1) max[i] = min[i] + 1;
    return { min, max };
}

const cleanBoxes = (value: unknown): MeshBox[] => {
    const out: MeshBox[] = [];
    for (const item of (Array.isArray(value) ? value : []).slice(0, 8)) {
        const box = cleanBox(item);
        if (box) out.push(box);
    }
    return out;
};

/**
 * The per-part rules of a design WITHOUT its normalisation: repairDesign re-centres and re-grounds a whole design, which would move
 * parts that are placed on a mesh. Sizes 5 to 1000 mm, positions in the frame's range, angles folded, colours repaired, names unique.
 */
function cleanAddedParts(value: unknown, room: number): DesignPart[] {
    const out: DesignPart[] = [];
    for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
        if (out.length >= room) break;
        if (!isRecord(raw) || typeof raw.shape !== "string" || !(PART_SHAPES as readonly string[]).includes(raw.shape)) continue;
        if (!Array.isArray(raw.size) || raw.size.length !== 3 || !Array.isArray(raw.position) || raw.position.length !== 3) continue;
        const finite = [...raw.size, ...raw.position].every((n) => typeof n === "number" && Number.isFinite(n));
        if (!finite) continue;
        const shape = raw.shape as PartShape;
        // A negative size is read as its magnitude (as repairDesign does), then every side is held to 5..1000 mm.
        const [sx, sy, sz] = (raw.size as number[]).map((n) => Math.min(MAX_PART_MM, Math.max(MIN_PART_MM, Math.abs(n))));
        const size: MeshVec3 =
            shape === "capsule" ? [sx, sx, Math.max(sz, sx)] : shape === "torus" ? [sx, sx, torusTube(sx, sz, MIN_PART_MM)] : [sx, sy, sz];
        out.push({
            name: text(raw.name, 60) || `${shape[0].toUpperCase()}${shape.slice(1)} ${index + 1}`,
            shape,
            size,
            position: vec(raw.position, -LIMIT_MM, LIMIT_MM, [0, 0, 0]),
            rotation: vec(raw.rotation, -1e6, 1e6, [0, 0, 0]).map(foldAngle) as MeshVec3,
            color: cleanColor(raw.color, index),
        });
    }
    const names = uniqueNames(out.map((p) => p.name));
    return out.map((p, i) => ({ ...p, name: names[i] }));
}

export type SanitizeResult =
    | { ok: true; program: MeshProgram; notes: string[]; regen_prompt: string | null }
    /** `error` is the model's answer being unusable (no ops list, or every op was dropped): a message fit for the user. */
    | { ok: false; error: string };

/**
 * An untrusted model answer (the flat strict-schema shape) -> a program the executor can run, or why not. Never throws; every number is
 * bounded: at most MAX_MESH_OPS ops (unknown ones dropped), 8 boxes and 8 excludes per op (min / max swapped when reversed, 1 mm minimum),
 * mm clamped to +-3000, feather 0.5 to 200, stretch and move +-1500, scale 0.1 to 5, rotate +-360, delete and mirror_copy need a selection,
 * recolor needs a colour, add_parts at most MAX_ADDED_PARTS parts in all. `applied: false` is a success with no ops.
 */
export function sanitizeProgram(raw: unknown): SanitizeResult {
    try {
        return sanitize(raw);
    } catch {
        return { ok: false, error: "The model's answer could not be read." };
    }
}

function sanitize(raw: unknown): SanitizeResult {
    if (!isRecord(raw) || !Array.isArray(raw.ops)) return { ok: false, error: "The model's answer has no list of steps." };
    const summary = text(raw.summary, 160) || "Edited the model";
    const regen = text(raw.regen_prompt, 1024) || null;
    if (raw.applied === false) return { ok: true, program: { summary, applied: false, ops: [] }, notes: [], regen_prompt: regen };

    const notes: string[] = [];
    if (raw.ops.length > MAX_MESH_OPS) notes.push(`only the first ${MAX_MESH_OPS} steps were used`);
    const ops: MeshOp[] = [];
    let partsLeft = MAX_ADDED_PARTS;
    for (const [i, o] of raw.ops.slice(0, MAX_MESH_OPS).entries()) {
        const n = i + 1;
        if (!isRecord(o) || typeof o.op !== "string" || !(MESH_OP_NAMES as readonly string[]).includes(o.op)) {
            notes.push(`step ${n}: unknown step dropped`);
            continue;
        }
        const kind = o.op as MeshOpName;
        const boxes = cleanBoxes(o.boxes);
        const exclude = cleanBoxes(o.exclude);
        const clean: MeshOp = {
            op: kind,
            label: text(o.label, 60) || kind,
            boxes,
            exclude,
            feather_mm: num(o.feather_mm, 0.5, 200, 20),
            axis: (AXES as readonly unknown[]).includes(o.axis) ? (o.axis as "x" | "y" | "z") : "z",
        };
        switch (kind) {
            case "stretch": {
                let from = num(o.from_mm, -LIMIT_MM, LIMIT_MM);
                let to = num(o.to_mm, -LIMIT_MM, LIMIT_MM);
                if (to < from) [from, to] = [to, from];
                if (to - from < 1) to = from + 1;
                const amount = num(o.amount_mm, -1500, 1500);
                if (amount === 0) {
                    notes.push(`step ${n}: stretch by 0 dropped`);
                    continue;
                }
                Object.assign(clean, { from_mm: from, to_mm: to, amount_mm: amount });
                break;
            }
            case "move": {
                const vector = vec(o.vector_mm, -1500, 1500, [0, 0, 0]);
                if (vector.every((v) => v === 0)) {
                    notes.push(`step ${n}: move by 0 dropped`);
                    continue;
                }
                clean.vector_mm = vector;
                break;
            }
            case "scale": {
                const factors = vec(o.factors, 0.1, 5, [1, 1, 1]);
                if (factors.every((v) => v === 1)) {
                    notes.push(`step ${n}: scale by 1 dropped`);
                    continue;
                }
                Object.assign(clean, { factors, pivot_mm: vec(o.pivot_mm, -LIMIT_MM, LIMIT_MM, [0, 0, 0]) });
                break;
            }
            case "rotate": {
                const degrees = num(o.degrees, -360, 360);
                if (degrees === 0) {
                    notes.push(`step ${n}: rotate by 0 dropped`);
                    continue;
                }
                Object.assign(clean, { degrees, pivot_mm: vec(o.pivot_mm, -LIMIT_MM, LIMIT_MM, [0, 0, 0]) });
                break;
            }
            case "delete":
                if (boxes.length === 0) {
                    notes.push(`step ${n}: delete without a place to cut dropped`);
                    continue;
                }
                break;
            case "mirror_copy":
                if (boxes.length === 0) {
                    notes.push(`step ${n}: mirror without a selection dropped`);
                    continue;
                }
                clean.mirror_at_mm = num(o.mirror_at_mm, -LIMIT_MM, LIMIT_MM);
                break;
            case "recolor": {
                const match = /^#?([0-9a-f]{6})$/i.exec(typeof o.color === "string" ? o.color.trim() : "");
                if (!match) {
                    notes.push(`step ${n}: recolor with a bad colour dropped`);
                    continue;
                }
                clean.color = `#${match[1].toLowerCase()}`;
                clean.strength = num(o.strength, 0, 1, 1) || 1;
                break;
            }
            case "add_parts": {
                const parts = cleanAddedParts(o.parts, partsLeft);
                if (parts.length === 0) {
                    notes.push(`step ${n}: adding parts without usable parts dropped`);
                    continue;
                }
                clean.parts = parts;
                partsLeft -= parts.length;
                break;
            }
        }
        ops.push(clean);
    }
    if (ops.length === 0) return { ok: false, error: "The model did not return a usable step." };
    return { ok: true, program: { summary, applied: true, ops }, notes, regen_prompt: regen };
}
