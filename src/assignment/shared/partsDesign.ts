// A "parts design": what the Muse assembly-designer model returns (a JSON list of named primitive parts) and what the
// app does with it before building a GLB (shared/partsGlb.ts). Pure TypeScript with no DOM and no dependencies: the Worker's
// queue consumer, the Node tests and the browser share it.
//
//   MUSE_SCHEMA / MUSE_SYSTEM_PROMPT   the request: a strict JSON schema and the instructions the model gets
//   repairDesign(raw, opts?)           an untrusted model answer -> a clean, normalised PartsDesign (or null: nothing usable)
//   cleanParts(raw, max?)              the per-part cleaning of repairDesign alone (no centring, no grounding): for parts that are placed on
//                                      something else (an edit's new parts, add_parts on a mesh)
//   normalizeParts(parts)              scale to fit the 1000 mm cube, centre on X/Y, put the lowest point on z = 0
//   PARTS_FORMAT_PROMPT                the units / size / rotation paragraph of the system prompt, reused by the edit prompts
//
// Frame: millimetres, Z up, ground at z = 0 (the frame of the analysis engine). rotation = degrees about the world X, Y and
// Z axes, applied in that order around the part's own centre (matrix Rz Ry Rx). The GLB writer converts to glTF's Y-up.

export const PART_SHAPES = ["box", "cylinder", "sphere", "cone", "capsule", "torus"] as const;
export type PartShape = (typeof PART_SHAPES)[number];
export type Vec3 = [number, number, number];

export interface DesignPart {
    name: string;
    shape: PartShape;
    /** mm. box [x, y, z] edges; cylinder/cone/sphere [dx, dy, dz] (an ellipse when dx != dy); capsule [d, d, length];
     *  torus [outer d, outer d, tube d]. Cylinder, cone, capsule and torus have their axis along local Z. */
    size: Vec3;
    /** mm, the centre of the part. */
    position: Vec3;
    /** degrees about the world X, Y, Z axes, applied in that order. */
    rotation: Vec3;
    /** "#rrggbb" */
    color: string;
}

export interface PartsDesign {
    name: string;
    parts: DesignPart[];
}

export const MIN_PART_MM = 5;
export const MAX_PART_MM = 1000;
export const MAX_PARTS = 60;
/** The object is scaled down (never up) to fit this cube. */
export const TARGET_MM = 1000;
const MAX_POSITION_MM = 2000;
const MAX_CONSIDERED = 200; // raw parts looked at: the CPU stays bounded whatever the model sends
const MAX_NAME_CHARS = 60;
/** A torus tube is at most this fraction of the ring's outer diameter: the hole is then at least 10% of it. */
const TORUS_MAX_TUBE = 0.4;

// ---------- the request ----------

const PART_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["name", "shape", "size", "position", "rotation", "color"],
    properties: {
        name: { type: "string" },
        shape: { type: "string", enum: [...PART_SHAPES] },
        size: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        color: { type: "string" },
    },
} as const;

/** The `json_schema` of OpenRouter's response_format (strict). */
export const MUSE_SCHEMA = {
    name: "assembly",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "parts"],
        properties: { name: { type: "string" }, parts: { type: "array", items: PART_SCHEMA } },
    },
} as const;

export const MUSE_SYSTEM_PROMPT =
    "You design physical objects as assemblies of simple solid parts, like a CAD model built from primitives. " +
    "Units are millimetres. Z is up and the ground is the plane z = 0. " +
    "size: box = edge lengths [x, y, z]; cylinder, cone and capsule = [diameter, diameter, height] with the axis along local Z " +
    "(a cone has its point at +Z; a capsule's height is its total length); sphere = [d, d, d]; " +
    "torus = [outer diameter, outer diameter, tube diameter], a ring lying flat around local Z. " +
    "position = the centre of the part. rotation = degrees [rx, ry, rz] about the X, Y and Z axes, applied in that order " +
    "around the part's centre (to lay a cylinder along X use [0, 90, 0], along Y use [90, 0, 0]). " +
    "The object fits a 1000 mm cube and rests on the ground. Parts must touch or overlap so the assembly is one connected " +
    "object that can stand on its own. Use realistic proportions, 6-40 parts, short descriptive names and #rrggbb colours.";

/** The units, size and rotation paragraph of the prompt above (what a part looks like), reused by the edit prompts (shared/partsEdit.ts). */
export const PARTS_FORMAT_PROMPT = MUSE_SYSTEM_PROMPT.split(" The object fits")[0].replace(/^You design[^.]*\. /, "");

// ---------- cleaning ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Colours used when the model sends none that parses: earthy, distinct, readable on the viewer's light stage. */
export const FALLBACK_COLORS: readonly string[] = [
    "#8d6e63",
    "#90a4ae",
    "#a1887f",
    "#78909c",
    "#bcaaa4",
    "#607d8b",
    "#b08968",
    "#8d99ae",
];

// A Map, not an object: the model chooses the lookup key, and "constructor" or "__proto__" must not find anything.
const SHAPE_ALIASES: ReadonlyMap<string, PartShape> = new Map<string, PartShape>([
    ["cube", "box"],
    ["cuboid", "box"],
    ["ball", "sphere"],
    ["ring", "torus"],
    ["donut", "torus"],
]);

function cleanShape(value: unknown): PartShape | null {
    if (typeof value !== "string") return null;
    const shape = value.trim().toLowerCase();
    if ((PART_SHAPES as readonly string[]).includes(shape)) return shape as PartShape;
    return SHAPE_ALIASES.get(shape) ?? null;
}

/** Three finite numbers (numeric strings are accepted), else null. */
function cleanVec3(value: unknown): Vec3 | null {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const out: number[] = [];
    for (const item of value) {
        const n = typeof item === "string" && item.trim() !== "" ? Number(item) : item;
        if (typeof n !== "number" || !Number.isFinite(n)) return null;
        out.push(n);
    }
    return [out[0], out[1], out[2]];
}

/** "#rrggbb" from "#rrggbb", "rrggbb", "#rgb" or "#rrggbbaa"; a fallback colour for anything else. */
export function cleanColor(value: unknown, index: number): string {
    if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        const long = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text);
        if (long) return `#${long[1]}`;
        const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
        if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    }
    return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function cleanName(value: unknown, shape: PartShape, index: number): string {
    // eslint-disable-next-line no-control-regex
    const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (text) return text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS).trimEnd() : text;
    return `${shape[0].toUpperCase()}${shape.slice(1)} ${index + 1}`;
}

function cleanTitle(value: unknown): string {
    // eslint-disable-next-line no-control-regex
    const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    return text ? text.slice(0, 80).trimEnd() : "Assembly";
}

/**
 * Tube diameter of a torus of outer diameter `outer`: at most 40% of it, so the hole (radius outer/2 - tube) is never closed
 * (a tube of exactly half the outer diameter pinches the ring shut on its axis) and at least `floor`, unless that is thicker
 * than the limit allows.
 */
export function torusTube(outer: number, tube: number, floor: number): number {
    const limit = outer * TORUS_MAX_TUBE;
    return clamp(tube, Math.min(floor, limit), limit);
}

/** Sizes 5-1000 mm (a negative size is read as its magnitude), then each shape's own limits. */
function cleanSize(shape: PartShape, size: Vec3): Vec3 {
    const [x, y, z] = size.map((n) => clamp(Math.abs(n), MIN_PART_MM, MAX_PART_MM)) as Vec3;
    switch (shape) {
        case "capsule": {
            // Round in section, and at least as long as it is wide (two hemispheres).
            return [x, x, Math.max(z, x)];
        }
        case "torus": {
            // A round ring whose tube leaves the hole open (see torusTube).
            return [x, x, torusTube(x, z, MIN_PART_MM)];
        }
        default:
            return [x, y, z];
    }
}

/** Degrees folded into (-180, 180]. */
function cleanAngle(n: number): number {
    const folded = ((((n + 180) % 360) + 360) % 360) - 180;
    return folded === -180 ? 180 : folded;
}

function cleanPart(raw: unknown, index: number): DesignPart | null {
    if (!isRecord(raw)) return null;
    const shape = cleanShape(raw.shape);
    const size = cleanVec3(raw.size);
    const position = cleanVec3(raw.position);
    if (!shape || !size || !position) return null;
    const rotation = cleanVec3(raw.rotation) ?? [0, 0, 0];
    return {
        name: cleanName(raw.name, shape, index),
        shape,
        size: cleanSize(shape, size),
        position: position.map((n) => clamp(n, -MAX_POSITION_MM, MAX_POSITION_MM)) as Vec3,
        rotation: rotation.map(cleanAngle) as Vec3,
        color: cleanColor(raw.color, index),
    };
}

/** Names made unique (case-insensitively): the second "Leg" becomes "Leg 2". Idempotent on names that are unique already. */
export function uniqueNames(names: readonly string[]): string[] {
    const taken = new Set<string>();
    const counters = new Map<string, number>();
    return names.map((name) => {
        let candidate = name;
        let n = counters.get(name.toLowerCase()) ?? 1;
        while (taken.has(candidate.toLowerCase())) {
            n += 1;
            candidate = `${name} ${n}`;
        }
        counters.set(name.toLowerCase(), n);
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

// ---------- geometry: exact bounds without building meshes ----------

/** Row-major 3x3 of R = Rz(rz) Ry(ry) Rx(rx), the part's rotation (degrees). */
export function rotationMatrix(rotation: Vec3): number[] {
    const [rx, ry, rz] = rotation.map((d) => (d * Math.PI) / 180);
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    return [
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
        -sy, cy * sx, cy * cx,
    ];
}

/** Support function: the largest u . v over the points v of the part in its own frame (centred, unrotated). */
function support(shape: PartShape, size: Vec3, ux: number, uy: number, uz: number): number {
    const a = size[0] / 2;
    const b = size[1] / 2;
    const c = size[2] / 2;
    switch (shape) {
        case "box":
            return a * Math.abs(ux) + b * Math.abs(uy) + c * Math.abs(uz);
        case "sphere":
            return Math.sqrt(a * a * ux * ux + b * b * uy * uy + c * c * uz * uz);
        case "cylinder":
            return Math.sqrt(a * a * ux * ux + b * b * uy * uy) + c * Math.abs(uz);
        case "cone": {
            // The base ellipse at z = -c, or the point at z = +c.
            const base = Math.sqrt(a * a * ux * ux + b * b * uy * uy) - c * uz;
            return Math.max(base, c * uz);
        }
        case "capsule": {
            const half = Math.max(0, c - a); // the straight part; two hemispheres of radius a on top
            return half * Math.abs(uz) + a * Math.sqrt(ux * ux + uy * uy + uz * uz);
        }
        case "torus": {
            const tube = size[2] / 2;
            return (a - tube) * Math.sqrt(ux * ux + uy * uy) + tube * Math.sqrt(ux * ux + uy * uy + uz * uz);
        }
    }
}

export interface Bounds {
    min: Vec3;
    max: Vec3;
}

/** The exact world bounding box of the parts (of the true surfaces; the GLB's meshes are inscribed within them). */
export function boundsOfParts(parts: readonly Pick<DesignPart, "shape" | "size" | "position" | "rotation">[]): Bounds | null {
    if (parts.length === 0) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
        const m = rotationMatrix(part.rotation);
        for (let axis = 0; axis < 3; axis++) {
            const ux = m[axis * 3], uy = m[axis * 3 + 1], uz = m[axis * 3 + 2];
            max[axis] = Math.max(max[axis], part.position[axis] + support(part.shape, part.size, ux, uy, uz));
            min[axis] = Math.min(min[axis], part.position[axis] - support(part.shape, part.size, -ux, -uy, -uz));
        }
    }
    return { min, max };
}

export interface Normalization {
    scale: number; // < 1 when the assembly was shrunk to fit the cube
    lifted_mm: number; // how far it was moved up (positive) or down onto z = 0
    size_mm: Vec3; // the final bounding box
}

/** A part's size after the assembly was scaled: at least 1 mm per side, and a torus keeps its hole open whatever the rounding. */
function scaledSize(part: DesignPart, scale: number): Vec3 {
    const size = part.size.map((n) => round2(Math.max(1, n * scale))) as Vec3;
    if (part.shape === "torus") size[2] = round2(torusTube(size[0], size[2], 1));
    return size;
}

/**
 * Scales the whole assembly uniformly so its bounding box fits the 1000 mm cube (only if it is larger), centres it on X/Y and
 * puts its lowest point on z = 0. Returns new parts; the input is left alone.
 */
export function normalizeParts(parts: readonly DesignPart[]): { parts: DesignPart[]; info: Normalization } | null {
    const box = boundsOfParts(parts);
    if (!box) return null;
    const extent = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const scale = extent > TARGET_MM ? TARGET_MM / extent : 1;
    const cx = ((box.min[0] + box.max[0]) / 2) * scale;
    const cy = ((box.min[1] + box.max[1]) / 2) * scale;
    const lift = -box.min[2] * scale;
    const out = parts.map((part) => ({
        ...part,
        size: scaledSize(part, scale),
        position: [round2(part.position[0] * scale - cx), round2(part.position[1] * scale - cy), round2(part.position[2] * scale + lift)] as Vec3,
        rotation: part.rotation.map(round2) as Vec3,
    }));
    return {
        parts: out,
        info: {
            scale,
            lifted_mm: round2(lift),
            size_mm: [
                round2((box.max[0] - box.min[0]) * scale),
                round2((box.max[1] - box.min[1]) * scale),
                round2((box.max[2] - box.min[2]) * scale),
            ],
        },
    };
}

// ---------- the whole repair ----------

export interface CleanedParts {
    /** The parts that survived, names made unique. Not moved, centred or scaled. */
    parts: DesignPart[];
    /** Parts of the answer that were dropped (invalid) or cut (beyond `max`). */
    dropped: number;
    notes: string[];
}

/**
 * The per-part half of repairDesign: drops parts that cannot be built (unknown shape, missing or non-finite size or position), clamps what
 * can be clamped (sizes 5-1000 mm, positions, angles), replaces bad colours, keeps at most `max` parts and makes the names unique. It does
 * not move anything: use it where the parts' positions mean something (new parts of an edit, parts added to a scanned mesh). Never throws.
 */
export function cleanParts(rawParts: unknown, max: number = MAX_PARTS): CleanedParts {
    if (!Array.isArray(rawParts)) return { parts: [], dropped: 0, notes: [] };
    const considered = rawParts.slice(0, MAX_CONSIDERED);
    const valid: DesignPart[] = [];
    const limited: string[] = []; // parts whose size or place was brought inside what the app can build
    let invalid = 0;
    considered.forEach((item, index) => {
        const part = cleanPart(item, index);
        if (part) {
            valid.push(part);
            const size = isRecord(item) ? cleanVec3(item.size) : null;
            const position = isRecord(item) ? cleanVec3(item.position) : null;
            if ((size && size.some((n) => Math.abs(n) > MAX_PART_MM || Math.abs(n) < MIN_PART_MM)) || (position && position.some((n) => Math.abs(n) > MAX_POSITION_MM))) limited.push(part.name);
        } else invalid += 1;
    });
    const notes: string[] = [];
    if (limited.length > 0) notes.push(`limited the size or place of ${limited.slice(0, 3).join(", ")}${limited.length > 3 ? ` and ${limited.length - 3} more` : ""} to what can be built (parts are 5 to 1000 mm)`);
    if (invalid > 0) notes.push(`dropped ${invalid} part${invalid === 1 ? "" : "s"} that could not be built`);
    const beyond = valid.length > max ? valid.length - max : 0;
    const cut = beyond + Math.max(0, rawParts.length - MAX_CONSIDERED);
    if (cut > 0) notes.push(`kept the first ${max} parts, dropped ${cut}`);
    const kept = valid.slice(0, max);
    const names = uniqueNames(kept.map((p) => p.name));
    return { parts: kept.map((part, i) => ({ ...part, name: names[i] })), dropped: invalid + cut, notes };
}

export interface RepairResult {
    /** The clean design, or null when no part survived. */
    design: PartsDesign | null;
    /** Parts of the answer that were dropped (invalid) or cut (beyond the 60 allowed). */
    dropped: number;
    /** What was changed, for the log and the status record (a handful of short lines). */
    notes: string[];
    info: Normalization | null;
}

export interface RepairOptions {
    /** Most parts to keep (default MAX_PARTS = 60; an edited design may have more, MAX_EDIT_PARTS = 120 in contract.ts). */
    maxParts?: number;
}

/**
 * An untrusted model answer -> a clean design. Drops parts that cannot be built (unknown shape, missing or non-finite
 * size or position), clamps what can be clamped (sizes 5-1000 mm, positions, angles), replaces bad colours, makes names
 * unique, keeps at most 60 parts (`opts.maxParts`), then normalises the assembly (see normalizeParts).
 */
export function repairDesign(raw: unknown, opts: RepairOptions = {}): RepairResult {
    const empty: RepairResult = { design: null, dropped: 0, notes: [], info: null };
    if (!isRecord(raw) || !Array.isArray(raw.parts)) return { ...empty, notes: ["the answer has no parts list"] };

    const { parts: named, dropped, notes } = cleanParts(raw.parts, opts.maxParts ?? MAX_PARTS);
    if (named.length === 0) return { design: null, dropped, notes, info: null };
    const normalized = normalizeParts(named);
    if (!normalized) return { design: null, dropped, notes, info: null };
    const { parts, info } = normalized;
    if (info.scale < 1) notes.push(`scaled to ${Math.round(info.scale * 100)}% to fit the 1000 mm cube`);
    if (Math.abs(info.lifted_mm) >= 1) {
        notes.push(info.lifted_mm > 0 ? `moved up ${Math.round(info.lifted_mm)} mm onto the ground` : `moved down ${Math.round(-info.lifted_mm)} mm onto the ground`);
    }
    return {
        design: { name: cleanTitle(raw.name), parts },
        dropped,
        notes,
        info,
    };
}
