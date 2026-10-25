// Offline tests for the Muse assembly designer (an LLM via OpenRouter returns named primitive parts; the app builds a GLB):
// the shared design repair and GLB writer, the adapter (worker/providers/openrouter.ts), the queue consumer (worker/llm.ts)
// and the "r2:" source of worker/glb.ts. No network, no keys: fetch, the queue and the R2 bucket are stubs.
//
//   node scripts/assignment/test-muse.mjs
//
// The last group ("engine:") runs the job engine and the project purge (worker/jobs.ts, worker/db.ts) against a real local D1
// database from wrangler's getPlatformProxy (no server, no port, nothing persisted beyond a temp folder); it is skipped with a
// note when wrangler cannot start.
//
// Needs Node >= 22.18 (imports the .ts sources directly; on 22.6-22.17 add --experimental-strip-types).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { MAX_GLB_BYTES, ModelFileError, storeGlb } from "../../worker/glb.ts";
import { OPENROUTER_URL, extractJson, handleLlmBatch } from "../../worker/llm.ts";
import { DESIGN_TIMEOUT_MS, llmKey, modelOf, openRouterDesigner, readRecord, stagingKeys } from "../../worker/providers/openrouter.ts";
import { purgeProjects } from "../../worker/db.ts";
import { advanceJob, cancelJob } from "../../worker/jobs.ts";
import { PROVIDER_SPECS, listProviders, resolveProvider } from "../../worker/providers/index.ts";
import { ProviderError } from "../../worker/providers/types.ts";
import {
    FALLBACK_COLORS,
    MAX_PARTS,
    MUSE_SCHEMA,
    MUSE_SYSTEM_PROMPT,
    boundsOfParts,
    cleanColor,
    repairDesign,
    uniqueNames,
} from "../../src/assignment/shared/partsDesign.ts";
import { buildPartMesh, buildPartsGlb, partPrimitive } from "../../src/assignment/shared/partsGlb.ts";
import { EDIT_PATCH_SCHEMA, EDIT_SYSTEM_PROMPT, designFromGlb, designHash } from "../../src/assignment/shared/partsEdit.ts";
import { MESH_PROGRAM_SCHEMA, MESH_SYSTEM_PROMPT, meshUserText } from "../../src/assignment/shared/meshProgram.ts";
import { readFileSync as readFile } from "node:fs";

const KEY = "sk-or-v1-test-0123456789abcdef0123456789abcdef";
const TASK = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const TASK2 = "0b8f3c52-5d0e-4e0c-9d57-2f4a1f6c9a10";

// ---------- tiny harness ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const logged = [];
console.log = (...args) => logged.push(args.map(String).join(" "));
console.error = (...args) => logged.push(args.map(String).join(" "));

// Workers' FixedLengthStream is a TransformStream whose length is known; Node has no such class.
globalThis.FixedLengthStream ??= class {
    constructor(length) {
        this.length = length;
        const { readable, writable } = new TransformStream();
        this.readable = readable;
        this.writable = writable;
    }
};

/** An in-memory R2 bucket with the calls the Worker makes. `fail.get` / `fail.put` make that call throw; `fail.putWhen(key, value)` only some puts. */
function makeBucket() {
    const store = new Map();
    const fail = { get: false, put: false, head: false, putWhen: null };
    const bytesOf = async (value) => {
        if (typeof value === "string") return new TextEncoder().encode(value);
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        const chunks = [];
        for await (const chunk of value) chunks.push(chunk);
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
    };
    const view = (key, entry, range) => {
        const bytes = range ? entry.bytes.subarray(range.offset, range.offset + range.length) : entry.bytes;
        return {
            key,
            size: entry.bytes.byteLength,
            httpMetadata: { contentType: entry.contentType },
            body: new Response(bytes).body,
            arrayBuffer: async () => bytes.slice().buffer,
            text: async () => new TextDecoder().decode(bytes),
            json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        };
    };
    return {
        store,
        fail,
        async get(key, options = {}) {
            if (fail.get) throw new Error("R2 is down");
            const entry = store.get(key);
            return entry ? view(key, entry, options.range) : null;
        },
        async head(key) {
            if (fail.head) throw new Error("R2 is down");
            const entry = store.get(key);
            return entry ? { key, size: entry.bytes.byteLength } : null;
        },
        async put(key, value, options = {}) {
            if (fail.put || fail.putWhen?.(key, value)) throw new Error("R2 is down");
            store.set(key, { bytes: await bytesOf(value), contentType: options.httpMetadata?.contentType ?? null });
        },
        async delete(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        },
        text: (key) => new TextDecoder().decode(store.get(key).bytes),
        json: (key) => JSON.parse(new TextDecoder().decode(store.get(key).bytes)),
        has: (key) => store.has(key),
    };
}

function makeEnv(extra = {}) {
    const sent = [];
    const queue = {
        sent,
        failNext: false,
        async send(body) {
            if (this.failNext) throw new Error("queue unavailable");
            sent.push(body);
            return {};
        },
    };
    return { OPENROUTER_API_KEY: KEY, FILES: makeBucket(), LLM_QUEUE: queue, ...extra };
}

/** A queue message with ack/retry recorded. */
function makeMessage(body, attempts = 1) {
    const message = { body, attempts, acked: false, retried: null };
    message.ack = () => {
        assert.ok(!message.acked && message.retried === null, "a message is answered once");
        message.acked = true;
    };
    message.retry = (options) => {
        assert.ok(!message.acked && message.retried === null, "a message is answered once");
        message.retried = options ?? {};
    };
    return message;
}

/** Replaces fetch. `script` is an array of replies consumed in order, or a function (call) => reply. */
function stubFetch(script) {
    const calls = [];
    const queue = Array.isArray(script) ? [...script] : null;
    globalThis.fetch = async (url, init = {}) => {
        const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
        const call = {
            url: String(url),
            method: init.method ?? "GET",
            headers,
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            signal: init.signal,
        };
        calls.push(call);
        const reply = queue ? queue.shift() : script(call);
        assert.ok(reply, `unexpected extra fetch: ${call.method} ${call.url}`);
        if (reply instanceof Error) throw reply;
        const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
        return new Response(text, { status: reply.status ?? 200, headers: reply.headers ?? {} });
    };
    return calls;
}

const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

// ---------- fixtures ----------

const part = (name, shape, size, position, rotation = [0, 0, 0], color = "#8d6e63") => ({ name, shape, size, position, rotation, color });

/** A small stool whose parts touch: used wherever a valid answer is needed. */
const STOOL = {
    name: "Wooden stool",
    parts: [
        part("Seat", "cylinder", [320, 320, 30], [0, 0, 430], [0, 0, 0], "#a1887f"),
        part("Leg", "cylinder", [30, 30, 420], [110, 110, 210], [0, 0, 0], "#8d6e63"),
        part("Leg", "cylinder", [30, 30, 420], [-110, 110, 210]),
        part("Leg", "cylinder", [30, 30, 420], [110, -110, 210]),
        part("Leg", "cylinder", [30, 30, 420], [-110, -110, 210]),
        part("Ring brace", "torus", [260, 260, 24], [0, 0, 150], [0, 0, 0], "#6d4c41"),
    ],
};

const ORIGIN = [0, 0, 0];
const modelReply = (design, usage = {}) => ({
    json: {
        id: "gen-test",
        model: "meta/muse-spark-1.3-contributor",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(design) } }],
        usage: { prompt_tokens: 330, completion_tokens: 2100, completion_tokens_details: { reasoning_tokens: 800 }, cost: 0.0008, ...usage },
    },
});
const textReply = (content, extra = {}) => ({
    json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { cost: 0.0004 }, ...extra },
});
const errorReply = (status, message, extra = {}) => ({ status, json: { error: { code: status, message, ...extra } } });

const io = new NodeIO();
const parse = (bytes) => io.readBinary(bytes);

// ---------- the repair ----------

test("repairDesign: a valid answer keeps its parts, names and colours", () => {
    const { design, dropped, notes, info } = repairDesign(STOOL);
    assert.ok(design);
    assert.equal(design.name, "Wooden stool");
    assert.deepEqual(design.parts.map((p) => p.shape), ["cylinder", "cylinder", "cylinder", "cylinder", "cylinder", "torus"]);
    assert.equal(design.parts[0].color, "#a1887f");
    assert.equal(dropped, 0);
    assert.equal(info.scale, 1);
    assert.deepEqual(notes, []);
});

test("repairDesign: parts that cannot be built are dropped, bad numbers are repaired", () => {
    const raw = {
        name: "x",
        parts: [
            part("good", "box", [100, 100, 100], [0, 0, 50]),
            part("nan size", "box", [Number.NaN, 10, 10], [0, 0, 0]),
            part("infinite position", "box", [10, 10, 10], [Number.POSITIVE_INFINITY, 0, 0]),
            part("text size", "box", ["wide", 10, 10], [0, 0, 0]),
            part("two numbers", "box", [10, 10], [0, 0, 0]),
            part("no position", "box", [10, 10, 10], undefined),
            part("unknown shape", "pyramid", [10, 10, 10], [0, 0, 0]),
            "not a part",
            null,
            part("bad rotation", "box", [100, 100, 100], [200, 0, 50], ["a", 0, 0]), // rotation falls back to none
            part("numeric strings", "box", ["60", "60", "60"], ["300", "0", "30"]),
        ],
    };
    const { design, dropped } = repairDesign(raw);
    assert.deepEqual(design.parts.map((p) => p.name), ["good", "bad rotation", "numeric strings"]);
    assert.equal(dropped, 8);
    assert.deepEqual(design.parts[1].rotation, [0, 0, 0]);
    for (const p of design.parts) for (const n of [...p.size, ...p.position, ...p.rotation]) assert.ok(Number.isFinite(n));
});

test("repairDesign: sizes are clamped to 5-1000 mm, negative sizes read as magnitudes, angles folded", () => {
    const { design } = repairDesign({
        parts: [part("tiny", "box", [0, 1, 2], [0, 0, 0], [450, -270, 0]), part("huge", "box", [-300, 5000, 400], [0, 0, 0])],
    });
    const [tiny, huge] = design.parts;
    // the assembly was 1000+ mm tall after clamping, so it is scaled: compare ratios instead of absolutes
    assert.ok(tiny.size.every((n) => n > 0));
    assert.deepEqual(tiny.rotation, [90, 90, 0]);
    assert.ok(Math.abs(huge.size[0] / huge.size[2] - 300 / 400) < 0.01, "magnitude of the negative size kept");
    assert.ok(Math.abs(huge.size[1] / huge.size[2] - 1000 / 400) < 0.01, "5000 clamped to 1000");
    const raw = repairDesign({ parts: [part("a", "box", [0, 1, 2], ORIGIN), part("b", "box", [-30, 4000, 20], [100, 0, 0])] });
    assert.ok(raw.design.parts.every((p) => p.size.every((n) => n >= 5 - 0.01 && n <= 1000)));
});

test("repairDesign: capsule and torus are made round, the tube leaves the hole open", () => {
    const { design } = repairDesign({
        parts: [part("capsule", "capsule", [60, 20, 40], [0, 0, 30]), part("torus", "torus", [100, 40, 90], [0, 0, 100])],
    });
    const [capsule, torus] = design.parts;
    assert.equal(capsule.size[0], capsule.size[1]);
    assert.ok(capsule.size[2] >= capsule.size[0], "at least as long as wide");
    assert.equal(torus.size[0], torus.size[1]);
    assert.ok(torus.size[2] <= 0.4 * torus.size[0] + 1e-9, "tube at most 40% of the outer diameter");
});

test("repairDesign: a torus keeps a real hole whatever tube it asked for (never a pinched ring)", () => {
    // [100,100,50] is the classic "donut": a tube of exactly half the outer diameter closes the hole on the axis
    for (const size of [[100, 100, 50], [40, 40, 40], [100, 40, 90], [8, 8, 5], [5, 5, 5], [1000, 1000, 1000], [200, 200, 5], [30, 30, 12]]) {
        const { design } = repairDesign({ parts: [part("ring", "torus", size, [0, 0, 300])] });
        const [torus] = design.parts;
        assert.ok(torus.size[2] <= 0.4 * torus.size[0] + 1e-9, `${size}: tube ${torus.size[2]} of ${torus.size[0]}`);
        assert.ok(torus.size[2] > 0);
        const mesh = buildPartMesh("torus", torus.size);
        let nearest = Infinity; // distance of the inner equator from the axis = the hole's radius (mm)
        for (let i = 0; i < mesh.positions.length; i += 3) nearest = Math.min(nearest, Math.hypot(mesh.positions[i], mesh.positions[i + 2]) * 1000);
        assert.ok(nearest >= 0.1 * torus.size[0] - 0.01, `${size}: hole radius ${nearest} of an outer diameter of ${torus.size[0]}`);
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const P = (i) => [mesh.positions[mesh.indices[i] * 3], mesh.positions[mesh.indices[i] * 3 + 1], mesh.positions[mesh.indices[i] * 3 + 2]];
            const [a, b, c] = [P(t), P(t + 1), P(t + 2)];
            const e1 = b.map((v, i) => v - a[i]);
            const e2 = c.map((v, i) => v - a[i]);
            const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
            assert.ok(area > 1e-14, `${size}: triangle ${t / 3} has no area`);
        }
    }
});

test("repairDesign: shrinking a 5 m assembly cannot turn a tiny ring inside out", () => {
    const { design, info } = repairDesign({
        parts: [part("far left", "box", [1000, 1000, 100], [-2000, 0, 50]), part("far right", "box", [1000, 1000, 100], [2000, 0, 50]), part("tiny ring", "torus", [5, 5, 5], [0, 0, 200])],
    });
    assert.ok(info.scale < 0.25);
    const ring = design.parts.find((p) => p.shape === "torus");
    assert.ok(ring.size[0] >= 1 && ring.size[2] > 0 && ring.size[2] <= 0.4 * ring.size[0] + 1e-9, String(ring.size));
    assert.ok(ring.size[0] / 2 - ring.size[2] > 0, "hole radius is positive");
});

test("repairDesign: a shape named like an Object property is dropped (constructor, __proto__, toString ...), not crashed on", () => {
    for (const shape of ["constructor", "__proto__", "Constructor", " __PROTO__ ", "toString", "hasOwnProperty", "valueOf", "__defineGetter__", "isPrototypeOf"]) {
        for (const name of ["", "named"]) {
            const result = repairDesign({ name: "x", parts: [part(name, shape, [100, 100, 100], [0, 0, 50]), part("ok", "box", [50, 50, 50], [0, 0, 25])] });
            assert.deepEqual(result.design.parts.map((p) => p.name), ["ok"], `${shape} / "${name}"`);
            assert.equal(result.dropped, 1);
            for (const p of result.design.parts) for (const n of [...p.size, ...p.position]) assert.ok(Number.isFinite(n));
        }
    }
    assert.equal(repairDesign({ parts: [part("", "constructor", [1, 1, 1], ORIGIN)] }).design, null);
    // and the real aliases still work
    const aliased = repairDesign({ parts: ["cube", "Cuboid", "ball", "ring", "DONUT"].map((shape, i) => part(`a${i}`, shape, [40, 40, 40], [i * 50, 0, 20])) });
    assert.deepEqual(aliased.design.parts.map((p) => p.shape), ["box", "box", "sphere", "torus", "torus"]);
});

test("repairDesign: an assembly over 1000 mm is scaled down uniformly to fit the cube", () => {
    const raw = { parts: [part("a", "box", [1000, 400, 200], [-1000, 0, 100]), part("b", "box", [1000, 400, 200], [1000, 0, 100])] };
    const { design, info, notes } = repairDesign(raw);
    const box = boundsOfParts(design.parts);
    const extent = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    assert.ok(extent <= 1000.05, `extent ${extent}`);
    assert.ok(extent >= 999.9);
    assert.ok(Math.abs(info.scale - 1 / 3) < 0.001, String(info.scale)); // 3000 mm across -> 1000
    // uniform: aspect ratios of the parts are untouched
    assert.ok(Math.abs(design.parts[0].size[0] / design.parts[0].size[1] - 2.5) < 0.01);
    assert.ok(notes.some((n) => /scaled to \d+%/.test(n)));
});

test("repairDesign: a small assembly is not scaled up", () => {
    const { design, info } = repairDesign({ parts: [part("a", "box", [40, 40, 40], [5, 5, 5])] });
    assert.equal(info.scale, 1);
    assert.deepEqual(design.parts[0].size, [40, 40, 40]);
});

test("repairDesign: centred on X/Y and resting on the ground, whether it floated or sank", () => {
    for (const lift of [900, 0, -300, 120.5]) {
        const raw = { parts: [part("a", "box", [100, 100, 100], [500, -250, lift + 50]), part("b", "sphere", [60, 60, 60], [560, -250, lift + 130])] };
        const { design, notes } = repairDesign(raw);
        const box = boundsOfParts(design.parts);
        assert.ok(Math.abs(box.min[2]) < 0.02, `lift ${lift}: lowest point ${box.min[2]}`);
        assert.ok(Math.abs((box.min[0] + box.max[0]) / 2) < 0.02, "centred in X");
        assert.ok(Math.abs((box.min[1] + box.max[1]) / 2) < 0.02, "centred in Y");
        if (Math.abs(lift) >= 1) assert.ok(notes.some((n) => /onto the ground/.test(n)), notes.join("|"));
    }
});

test("repairDesign: the lowest point counts the true shape (a cone point-down, a sphere, a tilted box)", () => {
    const raw = {
        parts: [
            part("cone", "cone", [100, 100, 200], [0, 0, 500], [180, 0, 0]), // point down
            part("tilted", "box", [200, 200, 200], [400, 0, 500], [0, 45, 0]),
        ],
    };
    const { design } = repairDesign(raw);
    const box = boundsOfParts(design.parts);
    assert.ok(Math.abs(box.min[2]) < 0.02);
    const cone = design.parts[0];
    // the cone's apex is the lowest point: its centre sits half its height above z = 0
    assert.ok(Math.abs(cone.position[2] - cone.size[2] / 2) < 0.1 || boundsOfParts([cone]).min[2] >= -0.01);
});

test("repairDesign: nothing usable gives no design", () => {
    for (const raw of [null, undefined, "text", 5, [], {}, { parts: [] }, { parts: "none" }, { parts: [null, "x", { shape: "box" }] }, { parts: [part("bad", "box", [Number.NaN, 1, 1], ORIGIN)] }]) {
        const result = repairDesign(raw);
        assert.equal(result.design, null, JSON.stringify(raw));
    }
});

test("repairDesign: at most 60 parts, in order", () => {
    const parts = Array.from({ length: 80 }, (_, i) => part(`P${i}`, "box", [30, 30, 30], [i * 10, 0, 15]));
    const { design, dropped, notes } = repairDesign({ parts });
    assert.equal(design.parts.length, MAX_PARTS);
    assert.equal(design.parts[0].name, "P0");
    assert.equal(design.parts.at(-1).name, "P59");
    assert.equal(dropped, 20);
    assert.ok(notes.some((n) => /first 60/.test(n)));
    // a runaway answer is bounded before it is cleaned
    const huge = Array.from({ length: 5000 }, (_, i) => part(`H${i}`, "box", [10, 10, 10], [i, 0, 5]));
    assert.equal(repairDesign({ parts: huge }).design.parts.length, MAX_PARTS);
});

test("repairDesign: colours are valid #rrggbb or a fallback; names are clean and unique", () => {
    assert.equal(cleanColor("#ABCDEF", 0), "#abcdef");
    assert.equal(cleanColor("abcdef", 0), "#abcdef");
    assert.equal(cleanColor("#F80", 0), "#ff8800");
    assert.equal(cleanColor("#11223344", 0), "#112233");
    for (const bad of ["red", "", "#12", "#12345g", null, 12, {}]) assert.equal(cleanColor(bad, 3), FALLBACK_COLORS[3], String(bad));
    assert.equal(cleanColor("nope", FALLBACK_COLORS.length + 1), FALLBACK_COLORS[1]);

    const { design } = repairDesign({
        parts: [
            part("Leg", "box", [10, 10, 10], [0, 0, 5], ORIGIN, "blue"),
            part("leg", "box", [10, 10, 10], [20, 0, 5]),
            part("  Leg\n\t ", "box", [10, 10, 10], [40, 0, 5]),
            part("", "sphere", [10, 10, 10], [60, 0, 5]),
            part(`${"x".repeat(100)}`, "box", [10, 10, 10], [80, 0, 5]),
            part("Bell\u0007<b>x</b>", "box", [10, 10, 10], [100, 0, 5]),
        ],
    });
    assert.deepEqual(design.parts.map((p) => p.name).slice(0, 4), ["Leg", "leg 2", "Leg 3", "Sphere 4"]);
    assert.ok(design.parts[4].name.length <= 60);
    assert.ok(!/[\u0000-\u001f]/.test(design.parts[5].name));
    for (const p of design.parts) assert.match(p.color, /^#[0-9a-f]{6}$/);
    assert.equal(design.parts[0].color, FALLBACK_COLORS[0]);
    assert.deepEqual(uniqueNames(["a", "A", "a 2", "a"]), ["a", "A 2", "a 2 2", "a 3"]);
});

test("the request: strict json_schema with the six shapes, and a prompt that states the conventions", () => {
    assert.equal(MUSE_SCHEMA.strict, true);
    assert.deepEqual(MUSE_SCHEMA.schema.properties.parts.items.properties.shape.enum, ["box", "cylinder", "sphere", "cone", "capsule", "torus"]);
    assert.deepEqual(MUSE_SCHEMA.schema.required, ["name", "parts"]);
    for (const word of ["millimetres", "Z is up", "z = 0", "1000 mm", "rotation", "touch"]) assert.ok(MUSE_SYSTEM_PROMPT.includes(word), word);
});

// ---------- the GLB ----------

const SHAPE_TRIANGLES = { box: 12, cylinder: 96, cone: 48, sphere: 528, capsule: 576, torus: 576 };

/** World-space vertices of every node (glTF Y-up, metres) from a parsed document. */
function worldVertices(doc) {
    const out = [];
    for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        const m = node.getWorldMatrix();
        for (const primitive of mesh.listPrimitives()) {
            const p = primitive.getAttribute("POSITION").getArray();
            for (let i = 0; i < p.length; i += 3) {
                out.push([
                    m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12],
                    m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13],
                    m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14],
                ]);
            }
        }
    }
    return out;
}
const extentOf = (vertices) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const v of vertices) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], v[a]);
        max[a] = Math.max(max[a], v[a]);
    }
    return { min, max };
};

test("GLB: every shape has the right triangle count, unit normals, correct winding and an exact bounding box", () => {
    const sizes = { box: [100, 60, 40], cylinder: [80, 50, 120], cone: [80, 60, 120], sphere: [80, 60, 100], capsule: [40, 40, 150], torus: [120, 120, 30] };
    for (const [shape, size] of Object.entries(sizes)) {
        const mesh = buildPartMesh(shape, size);
        const vertices = mesh.positions.length / 3;
        const triangles = mesh.indices.length / 3;
        assert.equal(triangles, SHAPE_TRIANGLES[shape], shape);
        assert.ok(vertices < 65536);
        for (let t = 0; t < triangles; t++) {
            const [a, b, c] = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
            assert.ok(a < vertices && b < vertices && c < vertices, `${shape} index out of range`);
            const P = (i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
            const N = (i) => [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
            const [pa, pb, pc] = [P(a), P(b), P(c)];
            const e1 = pb.map((v, i) => v - pa[i]);
            const e2 = pc.map((v, i) => v - pa[i]);
            const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            assert.ok(Math.hypot(...g) > 1e-12, `${shape} triangle ${t} has no area`);
            const n = [0, 1, 2].map((i) => N(a)[i] + N(b)[i] + N(c)[i]);
            assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, `${shape} triangle ${t} faces inwards`);
        }
        for (let i = 0; i < vertices; i++) {
            const length = Math.hypot(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]);
            assert.ok(Math.abs(length - 1) < 1e-5, `${shape} normal ${i} has length ${length}`);
        }
        // glTF frame (x, z, -y) of the Z-up size: the mesh spans exactly the part's size
        const box = extentOf(Array.from({ length: vertices }, (_, i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]));
        const span = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) * 1000);
        for (const [got, want] of [[span[0], size[0]], [span[1], size[2]], [span[2], size[1]]]) {
            assert.ok(Math.abs(got - want) < 0.01, `${shape} spans ${got}, want ${want}`);
        }
    }
});

test("GLB: bytes are deterministic and the container is well formed", () => {
    const { design } = repairDesign(STOOL);
    const a = buildPartsGlb(design);
    const b = buildPartsGlb(JSON.parse(JSON.stringify(design)));
    assert.equal(createHash("sha256").update(a).digest("hex"), createHash("sha256").update(b).digest("hex"));
    const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(4, true), 2);
    assert.equal(view.getUint32(8, true), a.byteLength);
    const jsonLength = view.getUint32(12, true);
    assert.equal(view.getUint32(16, true), 0x4e4f534a);
    assert.equal(jsonLength % 4, 0);
    const json = JSON.parse(new TextDecoder().decode(a.subarray(20, 20 + jsonLength)));
    assert.equal(json.asset.version, "2.0");
    const binAt = 20 + jsonLength;
    assert.equal(view.getUint32(binAt + 4, true), 0x004e4942);
    assert.equal(view.getUint32(binAt, true) % 4, 0);
    assert.equal(binAt + 8 + view.getUint32(binAt, true), a.byteLength);
    assert.equal(json.buffers[0].byteLength, view.getUint32(binAt, true));
});

test("GLB: one named node, mesh and material per part; shared unit meshes; colours as linear PBR", async () => {
    const { design } = repairDesign(STOOL);
    const doc = await parse(buildPartsGlb(design));
    const root = doc.getRoot();
    const nodes = root.listNodes();
    assert.deepEqual(nodes.map((n) => n.getName()), ["Seat", "Leg", "Leg 2", "Leg 3", "Leg 4", "Ring brace"]);
    assert.ok(nodes.every((n) => n.getMesh() && n.getMesh().listPrimitives().length === 1));
    assert.equal(root.listMeshes().length, 6);
    assert.equal(root.listMaterials().length, 6);
    assert.deepEqual(root.listMeshes().map((m) => m.getName()), nodes.map((n) => n.getName()));
    assert.equal(root.listScenes()[0].listChildren().length, 6);
    assert.equal(root.listScenes()[0].getName(), "Wooden stool");
    // the four legs and the seat share one cylinder mesh; the ring has its own
    const accessorOf = (n) => n.getMesh().listPrimitives()[0].getAttribute("POSITION");
    assert.equal(accessorOf(nodes[1]), accessorOf(nodes[2]));
    assert.equal(accessorOf(nodes[0]), accessorOf(nodes[1]));
    assert.notEqual(accessorOf(nodes[5]), accessorOf(nodes[1]));
    assert.equal(root.listAccessors().length, 6, "two meshes (cylinder, torus) x position, normal, indices");
    // material: #a1887f in linear space, metallic 0, rough 0.75
    const seat = nodes[0].getMesh().listPrimitives()[0].getMaterial();
    const lin = (hex) => { const c = hex / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const factor = seat.getBaseColorFactor();
    for (const [i, hex] of [0xa1, 0x88, 0x7f].entries()) assert.ok(Math.abs(factor[i] - lin(hex)) < 1e-5, `channel ${i}`);
    assert.equal(seat.getMetallicFactor(), 0);
    assert.equal(seat.getRoughnessFactor(), 0.75);
    assert.deepEqual(nodes[0].getExtras()["nevo:part"].shape, "cylinder");
});

test("GLB: triangle counts per shape in a parsed file", async () => {
    const parts = Object.keys(SHAPE_TRIANGLES).map((shape, i) => part(shape, shape, shape === "capsule" ? [40, 40, 150] : shape === "torus" ? [120, 120, 30] : [80, 60, 100], [i * 130, 0, 60]));
    const doc = await parse(buildPartsGlb(repairDesign({ parts }).design));
    for (const node of doc.getRoot().listNodes()) {
        const triangles = node.getMesh().listPrimitives()[0].getIndices().getCount() / 3;
        assert.equal(triangles, SHAPE_TRIANGLES[node.getName().toLowerCase()], node.getName());
    }
});

test("GLB: Y-up, in metres, standing on the ground: its box matches the design's analytic bounds", async () => {
    const parts = [
        part("Slab", "box", [400, 300, 40], [0, 0, 20], [0, 0, 30]),
        part("Post", "cylinder", [60, 60, 500], [100, 50, 290], [10, 15, 0]),
        part("Ball", "sphere", [120, 80, 100], [-100, 40, 90], [0, 0, 45]),
        part("Spire", "cone", [90, 90, 250], [100, 50, 665], [0, 0, 0]),
        part("Rail", "capsule", [30, 30, 260], [-60, -100, 350], [0, 90, 0]),
        part("Ring", "torus", [150, 150, 30], [-100, 40, 180], [20, 0, 0]),
    ];
    const { design } = repairDesign({ parts });
    const analytic = boundsOfParts(design.parts); // Z-up, mm
    const doc = await parse(buildPartsGlb(design));
    const box = extentOf(worldVertices(doc));
    // Z-up (x, y, z) -> glTF (x, z, -y)
    const want = { min: [analytic.min[0], analytic.min[2], -analytic.max[1]], max: [analytic.max[0], analytic.max[2], -analytic.min[1]] };
    for (let a = 0; a < 3; a++) {
        const tolerance = Math.max(1.5, (want.max[a] - want.min[a]) * 0.01); // the meshes are inscribed in the true shapes
        assert.ok(box.min[a] * 1000 >= want.min[a] - 0.01 && box.min[a] * 1000 - want.min[a] <= tolerance, `min axis ${a}: ${box.min[a] * 1000} vs ${want.min[a]}`);
        assert.ok(box.max[a] * 1000 <= want.max[a] + 0.01 && want.max[a] - box.max[a] * 1000 <= tolerance, `max axis ${a}: ${box.max[a] * 1000} vs ${want.max[a]}`);
    }
    assert.ok(Math.abs(box.min[1]) * 1000 < 1.5, "the lowest point is on the ground (Y = 0)");
    for (let a = 0; a < 3; a++) assert.ok((box.max[a] - box.min[a]) <= 1.0001, "fits a 1 m cube");
});

test("GLB: rotation is degrees about X, then Y, then Z (a cylinder is laid along X with [0, 90, 0], along Y with [90, 0, 0])", async () => {
    const along = async (rotation) => {
        const doc = await parse(buildPartsGlb({ name: "r", parts: [part("c", "cylinder", [40, 40, 400], [0, 0, 0], rotation)] }));
        const box = extentOf(worldVertices(doc));
        return [0, 1, 2].map((a) => Math.round((box.max[a] - box.min[a]) * 1000));
    };
    assert.deepEqual(await along([0, 0, 0]), [40, 400, 40]); // glTF (x, up, depth)
    assert.deepEqual(await along([0, 90, 0]), [400, 40, 40]); // along X
    assert.deepEqual(await along([90, 0, 0]), [40, 40, 400]); // along Y (depth)
    // X first, then Z (extrinsic): lay along Y, then turn about the vertical to X
    assert.deepEqual(await along([90, 0, 90]), [400, 40, 40]);
    // Z first would leave it along Y: [0, 0, 90] on an upright cylinder keeps it upright
    assert.deepEqual(await along([0, 0, 90]), [40, 400, 40]);
});

test("GLB: refuses what it cannot write", () => {
    assert.throws(() => buildPartsGlb({ name: "x", parts: [] }), /at least one part/);
    assert.throws(() => buildPartsGlb({ name: "x", parts: [part("bad", "box", [Number.NaN, 1, 1], ORIGIN)] }), /not finite/);
    assert.throws(() => buildPartsGlb({ name: "x", parts: Array.from({ length: 201 }, (_, i) => part(`p${i}`, "box", [1, 1, 1], ORIGIN)) }), /limited/);
});

test("GLB: capsules and tori of any size share their normals and triangles; their stated bounds are their vertices' extremes", () => {
    const sizes = [[5, 5, 5], [40, 40, 150], [70, 70, 70], [33.33, 33.33, 91.7], [1000, 1000, 1000]];
    const rings = [[120, 120, 30], [300, 300, 120], [8, 8, 3.2], [999.99, 999.99, 400], [5, 5, 2]];
    const built = [
        ...sizes.map((size) => ["capsule", size, partPrimitive("capsule", size).mesh]),
        ...rings.map((size) => ["torus", size, partPrimitive("torus", size).mesh]),
    ];
    for (const [shape, size, mesh] of built) {
        const want = extentOf(Array.from({ length: mesh.positions.length / 3 }, (_, i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]));
        assert.deepEqual([...mesh.bounds.min], want.min, `${shape} ${size} min`);
        assert.deepEqual([...mesh.bounds.max], want.max, `${shape} ${size} max`);
    }
    const kind = (shape) => built.filter(([s]) => s === shape).map(([, , mesh]) => mesh);
    for (const shape of ["capsule", "torus"]) {
        const [first, ...rest] = kind(shape);
        for (const mesh of rest) {
            assert.equal(mesh.normals, first.normals, `${shape} normals are one shared array`);
            assert.equal(mesh.indices, first.indices, `${shape} triangles are one shared array`);
            assert.notEqual(mesh.positions, first.positions);
        }
    }
    assert.notEqual(kind("capsule")[0].normals, kind("torus")[0].normals);
});

test("GLB: sixty different capsules and tori make a valid file whose stated accessor bounds are right", async () => {
    const parts = Array.from({ length: 60 }, (_, i) => {
        const w = 20 + i * 3;
        return i % 2 ? part(`Rod ${i}`, "capsule", [w, w, w * 2 + i], [i * 15 - 450, (i % 5) * 40, 100 + i], [i * 7, i * 11, i * 13]) : part(`Ring ${i}`, "torus", [w * 2, w * 2, w / 2], [i * 15 - 450, (i % 5) * 40, 100 + i], [i * 5, 0, i * 3]);
    });
    const { design } = repairDesign({ name: "many round parts", parts });
    assert.equal(design.parts.length, 60);
    const bytes = buildPartsGlb(design);
    assert.equal((await parse(bytes)).getRoot().listNodes().length, 60, "gltf-transform reads it");
    // the min/max the file states for each position accessor (read from the JSON, not recomputed) against the floats in the BIN chunk
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    const bin = bytes.subarray(20 + jsonLength + 8);
    const withBounds = json.accessors.filter((a) => a.min);
    assert.equal(withBounds.length, 60, "one position accessor per distinct mesh");
    for (const accessor of withBounds) {
        const bufferView = json.bufferViews[accessor.bufferView];
        const floats = new Float32Array(bin.buffer.slice(bin.byteOffset + bufferView.byteOffset, bin.byteOffset + bufferView.byteOffset + bufferView.byteLength));
        const want = extentOf(Array.from({ length: floats.length / 3 }, (_, i) => [floats[i * 3], floats[i * 3 + 1], floats[i * 3 + 2]]));
        for (let k = 0; k < 3; k++) {
            assert.ok(Math.abs(accessor.min[k] - want.min[k]) <= 5e-7 && Math.abs(accessor.max[k] - want.max[k]) <= 5e-7, `accessor bounds on axis ${k}: ${accessor.min[k]}..${accessor.max[k]} vs ${want.min[k]}..${want.max[k]}`);
        }
    }
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(buildPartsGlb(JSON.parse(JSON.stringify(design)))).digest("hex"));
});

test("GLB: 60 parts are small and fast (CPU measured in this process, warm)", () => {
    const shapes = ["box", "cylinder", "sphere", "cone", "capsule", "torus"];
    const parts = Array.from({ length: 60 }, (_, i) =>
        part(`Part ${i}`, shapes[i % 6], [60 + (i % 5) * 20, 60 + (i % 3) * 30, 80 + (i % 7) * 25], [(i % 8) * 70 - 250, Math.floor(i / 8) * 60 - 200, 40 + (i % 4) * 50], [(i * 7) % 90, (i * 13) % 90, (i * 29) % 180]),
    );
    let design;
    let bytes;
    const runs = 30;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
        design = repairDesign({ name: "stress", parts }).design;
        bytes = buildPartsGlb(design);
    }
    const perRun = (performance.now() - t0) / runs;
    realLog(`      60 mixed parts: ${bytes.byteLength} bytes, ${perRun.toFixed(2)} ms per repair + build (warm average of ${runs})`);
    assert.equal(design.parts.length, 60);
    assert.ok(bytes.byteLength < 600 * 1024, `${bytes.byteLength} bytes`);
    assert.ok(perRun < 25, `${perRun} ms`);
});

// ---------- registry ----------

test("registry: muse comes after hunyuan, needs only OPENROUTER_API_KEY and is served through openrouter", () => {
    const ids = PROVIDER_SPECS.map((s) => s.id);
    assert.ok(ids.indexOf("muse") > ids.indexOf("hunyuan"));
    assert.equal(ids.at(-1), "mock");
    const spec = PROVIDER_SPECS.find((s) => s.id === "muse");
    assert.deepEqual(spec.info, {
        label: "Muse Spark 1.3",
        vendor: "Meta via OpenRouter",
        description: "An AI model designs the object as named parts; the app builds them into a multi-part assembly",
        parts: true,
        textured: false,
        approx_seconds: 35,
    });
    assert.equal(spec.routes.length, 1);
    assert.equal(spec.routes[0].via, "openrouter");
    assert.equal(spec.routes[0].adapter.via, "openrouter");
    assert.equal(resolveProvider({}, "muse"), null);
    assert.equal(resolveProvider({ OPENROUTER_API_KEY: "  " }, "muse"), null);
    const route = resolveProvider({ OPENROUTER_API_KEY: "k" }, "muse");
    assert.equal(route.via, "openrouter");
    assert.equal(route.adapter, openRouterDesigner);
    const listed = listProviders({ OPENROUTER_API_KEY: "k" }).filter((p) => p.available);
    assert.deepEqual(listed.map((p) => [p.id, p.via]), [["muse", "openrouter"]]);
    assert.equal(listProviders({}).find((p) => p.id === "muse").available, false);
});

test("modelOf: the Muse model unless OPENROUTER_MODEL names another", () => {
    assert.equal(modelOf({}), "meta/muse-spark-1.3-contributor");
    assert.equal(modelOf({ OPENROUTER_MODEL: "" }), "meta/muse-spark-1.3-contributor");
    assert.equal(modelOf({ OPENROUTER_MODEL: " openai/gpt-5 " }), "openai/gpt-5");
    assert.equal(modelOf({ OPENROUTER_MODEL: "bad model; drop" }), "meta/muse-spark-1.3-contributor");
});

// ---------- the adapter ----------

async function thrown(fn) {
    try {
        await fn();
    } catch (err) {
        assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${err}`);
        assert.ok(!err.message.includes(KEY));
        return err;
    }
    assert.fail("expected a ProviderError");
}

test("submit: enqueues {taskId, prompt, model} (no key), returns the task id and a start time", async () => {
    const env = makeEnv();
    const before = Date.now();
    const result = await openRouterDesigner.submit(env, "  A wooden rocking chair ");
    assert.match(result.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(env.LLM_QUEUE.sent, [{ taskId: result.taskId, prompt: "A wooden rocking chair", model: "meta/muse-spark-1.3-contributor" }]);
    assert.ok(result.state.queued_at >= before && result.state.queued_at <= Date.now());
    assert.equal(result.state.model, "meta/muse-spark-1.3-contributor");
    assert.ok(!JSON.stringify(env.LLM_QUEUE.sent).includes(KEY));
    const other = await openRouterDesigner.submit(makeEnv({ OPENROUTER_MODEL: "openai/gpt-5" }), "x");
    assert.equal(other.state.model, "openai/gpt-5");
    assert.notEqual((await openRouterDesigner.submit(env, "again")).taskId, result.taskId);
});

test("submit: a missing key, a missing queue, an empty prompt and a failing queue are readable errors", async () => {
    assert.equal((await thrown(() => openRouterDesigner.submit(makeEnv({ OPENROUTER_API_KEY: "  " }), "x"))).status, 503);
    assert.match((await thrown(() => openRouterDesigner.submit(makeEnv({ LLM_QUEUE: undefined }), "x"))).message, /queue/i);
    assert.equal((await thrown(() => openRouterDesigner.submit(makeEnv(), "   "))).status, 422);
    const env = makeEnv();
    env.LLM_QUEUE.failNext = true;
    const err = await thrown(() => openRouterDesigner.submit(env, "x"));
    assert.equal(err.retryable, false, "not queued: the daily slot is handed back");
    const long = await openRouterDesigner.submit(makeEnv(), "word ".repeat(400));
    assert.equal(long.state.prompt_trimmed_to, 1000);
});

test("poll: no record yet and a designing record read as running 'Designing the parts…'", async () => {
    const env = makeEnv();
    const state = { queued_at: Date.now() - 5000 };
    assert.deepEqual(await openRouterDesigner.poll(env, TASK, state), { status: "running", stage: "Designing the parts…" });
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "designing", attempt: 1 }));
    assert.deepEqual(await openRouterDesigner.poll(env, TASK, state), { status: "running", stage: "Designing the parts…" });
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "building" }));
    assert.deepEqual(await openRouterDesigner.poll(env, TASK, state), { status: "running", stage: "Building the 3D model" });
});

test("poll: done -> succeeded with an r2: GLB url; failed -> the consumer's message", async () => {
    const env = makeEnv();
    const state = { queued_at: Date.now() };
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "done", design: STOOL }));
    assert.deepEqual(await openRouterDesigner.poll(env, TASK, state), { status: "succeeded", glbUrl: `r2:llm/${TASK}.glb`, thumbnailUrl: null });
    await env.FILES.put(llmKey(TASK2, "json"), JSON.stringify({ status: "failed", error: "Out of credits on OpenRouter — top up at openrouter.ai/settings/credits" }));
    assert.deepEqual(await openRouterDesigner.poll(env, TASK2, state), { status: "failed", error: "Out of credits on OpenRouter — top up at openrouter.ai/settings/credits" });
    await env.FILES.put(llmKey(TASK2, "json"), JSON.stringify({ status: "failed" }));
    assert.match((await openRouterDesigner.poll(env, TASK2, state)).error, /could not make this model/);
});

test("poll: a garbled record is ignored; an R2 hiccup keeps the job running and is counted; five minutes end it", async () => {
    const env = makeEnv();
    const state = { queued_at: Date.now() - 1000 };
    await env.FILES.put(llmKey(TASK, "json"), "{not json");
    assert.equal((await openRouterDesigner.poll(env, TASK, state)).status, "running");
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "exploded" }));
    assert.equal((await openRouterDesigner.poll(env, TASK, state)).status, "running");

    env.FILES.fail.get = true;
    const hiccup = await openRouterDesigner.poll(env, TASK, state);
    assert.equal(hiccup.status, "running");
    assert.equal(hiccup.state.transient_errors, 1);
    env.FILES.fail.get = false;

    const old = { queued_at: Date.now() - DESIGN_TIMEOUT_MS - 1000 };
    const late = await openRouterDesigner.poll(env, TASK2, old);
    assert.equal(late.status, "failed");
    assert.match(late.error, /took too long/);
    assert.ok(env.FILES.has(llmKey(TASK2, "cancel")), "the consumer is told to skip it");
    // ...but a finished result that arrives late is still taken
    await env.FILES.put(llmKey(TASK2, "json"), JSON.stringify({ status: "done" }));
    assert.equal((await openRouterDesigner.poll(env, TASK2, old)).status, "succeeded");
});

test("poll: ten minutes from queueing (the longest consumer path is ~6 minutes plus the wait in the queue)", async () => {
    assert.equal(DESIGN_TIMEOUT_MS, 10 * 60 * 1000);
    const env = makeEnv();
    assert.equal((await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() - 9 * 60 * 1000 })).status, "running");
    assert.ok(!env.FILES.has(llmKey(TASK, "cancel")));
    const late = await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() - 10 * 60 * 1000 - 1000 });
    assert.equal(late.status, "failed");
    assert.match(late.error, /over 10 minutes/);
    assert.ok(env.FILES.has(llmKey(TASK, "cancel")));
});

test("poll: the time-out looks at the record once more before it stops the consumer", async () => {
    const env = makeEnv();
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "building" }));
    // the consumer finishes between the poll's first read and its decision to give up
    const real = env.FILES.get.bind(env.FILES);
    let reads = 0;
    env.FILES.get = async (key, options) => {
        const out = await real(key, options);
        if (key === llmKey(TASK, "json") && ++reads === 1) env.FILES.store.set(key, { bytes: new TextEncoder().encode(JSON.stringify({ status: "done" })), contentType: null });
        return out;
    };
    const result = await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() - DESIGN_TIMEOUT_MS - 1000 });
    assert.equal(result.status, "succeeded", "the finished design is taken");
    assert.ok(!env.FILES.has(llmKey(TASK, "cancel")), "no marker is left next to a finished task");
    assert.equal(reads, 2);
});

test("cancel: leaves a marker while the designer works; drops the files when it is over; never throws", async () => {
    const env = makeEnv();
    await openRouterDesigner.cancel(env, TASK, null);
    assert.ok(env.FILES.has(llmKey(TASK, "cancel")));
    await env.FILES.put(llmKey(TASK2, "json"), JSON.stringify({ status: "done" }));
    await env.FILES.put(llmKey(TASK2, "glb"), new Uint8Array(4));
    await openRouterDesigner.cancel(env, TASK2, null);
    assert.ok(!env.FILES.has(llmKey(TASK2, "json")) && !env.FILES.has(llmKey(TASK2, "glb")));
    assert.ok(!env.FILES.has(llmKey(TASK2, "cancel")), "nothing is running, so no marker is left behind");
    env.FILES.fail.put = true;
    env.FILES.fail.get = true;
    await openRouterDesigner.cancel(env, TASK, null); // resolves
});

test("cleanup: removes the staged record and file; the cancel marker only once the consumer is finished with the message", async () => {
    // no record, designing or building: the consumer may still come for the message, and the marker is what stops its paid call
    for (const record of [null, { status: "designing" }, { status: "building" }]) {
        const env = makeEnv();
        for (const file of ["json", "glb", "cancel"]) await env.FILES.put(llmKey(TASK, file), "x");
        if (record) await env.FILES.put(llmKey(TASK, "json"), JSON.stringify(record));
        await openRouterDesigner.cleanup(env, TASK, null);
        assert.deepEqual([...env.FILES.store.keys()], [llmKey(TASK, "cancel")], JSON.stringify(record));
    }
    // done or failed: nothing is left to stop, so nothing is left behind
    for (const status of ["done", "failed"]) {
        const env = makeEnv();
        for (const file of ["json", "glb", "cancel"]) await env.FILES.put(llmKey(TASK, file), "x");
        await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status }));
        await openRouterDesigner.cleanup(env, TASK, null);
        assert.deepEqual([...env.FILES.store.keys()], [], status);
    }
    const env = makeEnv();
    for (const file of ["json", "glb", "cancel"]) await env.FILES.put(llmKey(TASK, file), "x");
    env.FILES.delete = async () => {
        throw new Error("nope");
    };
    await openRouterDesigner.cleanup(env, TASK, null);
    assert.throws(() => llmKey("../../models/x", "json"));
    assert.deepEqual(stagingKeys(TASK), [`llm/${TASK}.json`, `llm/${TASK}.glb`, `llm/${TASK}.cancel`, `llm/${TASK}.in.json`]);
    assert.deepEqual(stagingKeys("../../models/x"), [], "only task ids name staging files");
});

// ---------- the consumer ----------

async function consume(env, body, attempts = 1) {
    const message = makeMessage(body, attempts);
    await handleLlmBatch({ messages: [message] }, env);
    return message;
}
const job = (extra = {}) => ({ taskId: TASK, prompt: "a stool", model: "meta/muse-spark-1.3-contributor", ...extra });

test("consumer: asks OpenRouter exactly like the measured request, then stores the GLB and a done record", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL)]);
    const message = await consume(env, job({ prompt: "a wooden stool" }));
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, OPENROUTER_URL);
    assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers["http-referer"], "https://nevomirzai.com/assignment_alex");
    assert.equal(call.headers["x-title"], "Assembly Studio");
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.body.model, "meta/muse-spark-1.3-contributor");
    assert.deepEqual(call.body.messages, [{ role: "system", content: MUSE_SYSTEM_PROMPT }, { role: "user", content: "a wooden stool" }]);
    assert.deepEqual(call.body.response_format, { type: "json_schema", json_schema: MUSE_SCHEMA });
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.deepEqual(call.body.reasoning, { effort: "low" });
    assert.equal(call.body.max_tokens, 16000);

    assert.equal(message.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.design.name, "Wooden stool");
    assert.equal(record.design.parts.length, 6);
    assert.deepEqual(record.usage, { prompt_tokens: 330, completion_tokens: 2100, reasoning_tokens: 800, cost_usd: 0.0008 });
    assert.equal(record.cost_usd, 0.0008);
    assert.equal(record.size_bytes, env.FILES.store.get(llmKey(TASK, "glb")).bytes.byteLength);
    assert.equal(env.FILES.store.get(llmKey(TASK, "glb")).contentType, "model/gltf-binary");
    const doc = await parse(env.FILES.store.get(llmKey(TASK, "glb")).bytes);
    assert.deepEqual(doc.getRoot().listNodes().map((n) => n.getName()), ["Seat", "Leg", "Leg 2", "Leg 3", "Leg 4", "Ring brace"]);
    // and the adapter now reports it
    assert.equal((await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() })).status, "succeeded");
});

test("consumer: an answer that needs repair still ends in a valid, grounded, centred GLB", async () => {
    const env = makeEnv();
    stubFetch([
        modelReply({
            name: "Messy table",
            parts: [
                part("Top", "box", [1800, 900, 40], [1300, 900, 1200], [0, 0, 0], "wood"),
                part("Leg A", "cylinder", [60, 60, -700], [700, 600, 800], [0, 0, 0], "#654321"),
                part("Leg B", "cylinder", [60, 60, 700], [1900, 1200, 800], ["x", 0, 0], "#654321"),
                part("Broken", "box", [Number.NaN, 5, 5], ORIGIN),
                part("Ghost", "hologram", [5, 5, 5], ORIGIN),
            ],
        }),
    ]);
    const message = await consume(env, job());
    assert.equal(message.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.dropped, 2);
    assert.ok(record.notes.some((n) => /dropped 2 parts/.test(n)));
    assert.ok(record.notes.some((n) => /scaled to/.test(n)));
    const doc = await parse(env.FILES.store.get(llmKey(TASK, "glb")).bytes);
    const box = extentOf(worldVertices(doc));
    assert.ok(Math.abs(box.min[1]) * 1000 < 1.5, "on the ground");
    assert.ok(Math.abs((box.min[0] + box.max[0]) / 2) * 1000 < 1.5 && Math.abs((box.min[2] + box.max[2]) / 2) * 1000 < 1.5, "centred");
    for (let a = 0; a < 3; a++) assert.ok(box.max[a] - box.min[a] <= 1.0001);
    assert.deepEqual(doc.getRoot().listNodes().map((n) => n.getName()), ["Top", "Leg A", "Leg B"]);
});

test("extractJson: a fence followed by a long run of blanks is a linear scan, not a quadratic one", () => {
    for (const filler of [" ", "\n", "\t ", "\r\n"]) {
        const t0 = performance.now();
        assert.equal(extractJson("```json" + filler.repeat(150_000)), undefined);
        assert.equal(extractJson("```" + filler.repeat(150_000) + "{"), undefined);
        assert.deepEqual(extractJson("```json" + filler.repeat(20_000) + '{"a":1}' + filler.repeat(20_000) + "```"), { a: 1 });
        const ms = performance.now() - t0;
        assert.ok(ms < 150, `${JSON.stringify(filler)}: ${ms.toFixed(0)} ms (the old pattern took seconds)`);
    }
    // the whole text is tried first; the fence and the braces only when it is not JSON; a huge answer is not scanned for them
    assert.deepEqual(extractJson(' \n{"a":1}\n '), { a: 1 });
    assert.deepEqual(extractJson('```\n{"a":[1,2]}\n```'), { a: [1, 2] });
    assert.deepEqual(extractJson('```json\nnot json\n``` but {"a":3} is'), { a: 3 });
    assert.equal(extractJson('Here it is: {"a":1}' + " ".repeat(300_000)), undefined);
    assert.deepEqual(extractJson('{"a":1}' + " ".repeat(300_000)), { a: 1 }, "a plain answer is parsed however long");
});

test("consumer: JSON in a code fence, or with chatter around it, is accepted", async () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} enjoy'), { a: { b: 2 } });
    assert.equal(extractJson("no json at all"), undefined);
    const env = makeEnv();
    stubFetch([textReply("```json\n" + JSON.stringify(STOOL) + "\n```")]);
    await consume(env, job());
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "done");
});

test("consumer: no usable parts is tried once more, then failed with a clear message", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply({ name: "empty", parts: [] }), modelReply({ name: "empty", parts: [part("x", "pyramid", [1, 1, 1], ORIGIN)] })]);
    const first = await consume(env, job(), 1);
    assert.deepEqual(first.retried, { delaySeconds: 2 });
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "designing", "still running for the poller");
    const second = await consume(env, job(), 2);
    assert.equal(second.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.match(record.error, /returned no usable parts/);
    assert.equal(calls.length, 2);
    assert.equal(record.cost_usd, 0.0016, "both attempts are counted");
    assert.ok(!env.FILES.has(llmKey(TASK, "glb")));
    assert.deepEqual(await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() }), { status: "failed", error: record.error });
});

const cutOff = (cost = 0.01) => ({ json: { choices: [{ finish_reason: "length", message: { content: '{"name":"x","parts":[{"na' } }], usage: { cost } } });

test("consumer: unreadable text and an empty answer are retried once, then failed with a message that fits", async () => {
    for (const [bad, pattern] of [
        [textReply("I cannot draw that."), /could not read/],
        [textReply(""), /returned an empty answer/],
        [{ json: { choices: [] } }, /returned an empty answer/],
        [{ json: { choices: [{ finish_reason: "stop", message: { content: "   " } }] } }, /returned an empty answer/],
        [{ json: { choices: [{ finish_reason: "error", message: { content: "" } }], usage: { cost: 0.001 } } }, /provider reported an error/],
    ]) {
        const env = makeEnv();
        const calls = stubFetch([bad, bad]);
        const first = await consume(env, job(), 1);
        assert.ok(first.retried, String(pattern));
        const last = await consume(env, job(), 2);
        assert.equal(last.acked, true);
        assert.match(env.FILES.json(llmKey(TASK, "json")).error, pattern);
        assert.deepEqual(calls[1].body, calls[0].body, "an empty or unreadable answer is asked again the same way");
        assert.ok(!/ran out of room/.test(env.FILES.json(llmKey(TASK, "json")).error));
    }
    // a provider error is plain bad luck: it waits a little longer than a re-ask
    stubFetch([{ json: { choices: [{ finish_reason: "error", message: { content: "" } }] } }]);
    assert.deepEqual((await consume(makeEnv(), job(), 1)).retried, { delaySeconds: 5 });
});

test("consumer: an answer cut off at max_tokens is asked again for a smaller design, not for the same one", async () => {
    const env = makeEnv();
    const calls = stubFetch([cutOff(0.01), cutOff(0.01)]);
    const first = await consume(env, job({ prompt: "a city with 500 buildings" }), 1);
    assert.deepEqual(first.retried, { delaySeconds: 2 });
    assert.equal(env.FILES.json(llmKey(TASK, "json")).simplify, true, "the next try knows to ask for less");
    const second = await consume(env, job({ prompt: "a city with 500 buildings" }), 2);
    assert.equal(second.acked, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.messages[0].content, MUSE_SYSTEM_PROMPT, "the first request is the measured one");
    assert.ok(calls[1].body.messages[0].content.startsWith(MUSE_SYSTEM_PROMPT));
    assert.match(calls[1].body.messages[0].content, /too long to finish.*at most 16 parts/);
    assert.notDeepEqual(calls[1].body, calls[0].body);
    assert.deepEqual(calls[1].body.messages[1], calls[0].body.messages[1], "the user's prompt is untouched");
    assert.equal(calls[1].body.max_tokens, 16000);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.match(record.error, /ran out of room.*simpler prompt/);
    assert.equal(record.cost_usd, 0.02, "both attempts are counted");
});

test("consumer: the smaller request after a cut-off can succeed, and the cost of both calls is kept", async () => {
    const env = makeEnv();
    const calls = stubFetch([cutOff(0.006), modelReply(STOOL)]);
    await consume(env, job(), 1);
    const second = await consume(env, job(), 2);
    assert.equal(second.acked, true);
    assert.match(calls[1].body.messages[0].content, /at most 16 parts/);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.cost_usd, 0.0068);
    assert.equal(record.simplify, undefined, "the flag is not left on a finished record");
});

test("consumer: a cut-off that follows a 429 still gets its try with the smaller request", async () => {
    const env = makeEnv();
    const calls = stubFetch([errorReply(429, "slow down"), cutOff(), modelReply(STOOL)]);
    assert.ok((await consume(env, job(), 1)).retried);
    const second = await consume(env, job(), 2);
    assert.deepEqual(second.retried, { delaySeconds: 2 }, "the third delivery is for the smaller request");
    assert.equal(env.FILES.json(llmKey(TASK, "json")).simplify, true);
    assert.equal((await consume(env, job(), 3)).acked, true);
    assert.match(calls[2].body.messages[0].content, /at most 16 parts/);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "done");
    // ...but only one such try: a second cut-off ends the task
    const env2 = makeEnv();
    stubFetch([errorReply(429, "slow down"), cutOff(), cutOff()]);
    await consume(env2, job(), 1);
    await consume(env2, job(), 2);
    assert.equal((await consume(env2, job(), 3)).acked, true);
    assert.match(env2.FILES.json(llmKey(TASK, "json")).error, /ran out of room/);
});

test("consumer: a 429 after a cut-off keeps asking for the smaller design", async () => {
    const env = makeEnv();
    const calls = stubFetch([cutOff(), errorReply(429, "slow down"), modelReply(STOOL)]);
    await consume(env, job(), 1);
    await consume(env, job(), 2);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).simplify, true);
    await consume(env, job(), 3);
    assert.match(calls[2].body.messages[0].content, /at most 16 parts/);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "done");
});

test("consumer: a retry that works is a normal success, with the cost of both calls", async () => {
    const env = makeEnv();
    stubFetch([textReply("not json", { usage: { cost: 0.0005 } }), modelReply(STOOL)]);
    await consume(env, job(), 1);
    const second = await consume(env, job(), 2);
    assert.equal(second.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.cost_usd, 0.0013);
    assert.equal(record.usage.cost_usd, 0.0008, "usage is the successful call's");
});

test("consumer: error mapping — key rejected, out of credits, moderation, bad request fail at once", async () => {
    const cases = [
        [errorReply(401, "No auth credentials found"), /OpenRouter API key was rejected \(401\)/],
        [errorReply(402, "Insufficient credits"), /Out of credits on OpenRouter — top up at openrouter\.ai\/settings\/credits/],
        [errorReply(403, "Your chosen model requires moderation and your input was flagged", { metadata: { reasons: ["violence"] } }), /rejected the prompt \(content policy\)/],
        [errorReply(403, "Key limit exceeded"), /Out of credits on OpenRouter, or the key lacks access \(403\)/],
        [errorReply(400, `Provider returned error for ${KEY}`), /rejected the request \(400\): Provider returned error for \*\*\*/],
        [errorReply(404, "No endpoints found for meta/nope"), /rejected the request \(404\): No endpoints found/],
    ];
    for (const [reply, pattern] of cases) {
        const env = makeEnv();
        const calls = stubFetch([reply]);
        const message = await consume(env, job(), 1);
        assert.equal(message.acked, true, "no retry for a definite answer");
        assert.equal(message.retried, null);
        assert.equal(calls.length, 1);
        const record = env.FILES.json(llmKey(TASK, "json"));
        assert.equal(record.status, "failed");
        assert.match(record.error, pattern);
        assert.ok(!JSON.stringify(record).includes(KEY), "the key never lands in R2");
    }
});

test("consumer: 429 is retried with a delay through the queue's retries, then reported", async () => {
    const env = makeEnv();
    stubFetch([errorReply(429, "slow down"), { ...errorReply(429, "slow down"), headers: { "retry-after": "17" } }, errorReply(429, "slow down")]);
    const first = await consume(env, job(), 1);
    assert.deepEqual(first.retried, { delaySeconds: 15 });
    const second = await consume(env, job(), 2);
    assert.deepEqual(second.retried, { delaySeconds: 17 }, "Retry-After is honoured");
    const third = await consume(env, job(), 3);
    assert.equal(third.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.match(record.error, /Rate limited by OpenRouter/);
});

test("consumer: 5xx, a dropped connection and a timeout are retried once, then reported", async () => {
    for (const [first, pattern] of [
        [errorReply(502, "upstream"), /server error \(502\)/],
        [errorReply(503, "no provider"), /server error \(503\)/],
        [{ status: 408, text: "timeout" }, /server error \(408\)|rejected the request \(408\)/],
        [new TypeError("fetch failed"), /Could not reach OpenRouter/],
        [timeoutError(), /did not answer in time/],
        [{ status: 200, json: { error: { code: 502, message: "Provider returned error" } } }, /server error \(502\)/],
    ]) {
        const env = makeEnv();
        stubFetch([first, first]);
        const one = await consume(env, job(), 1);
        assert.equal(one.retried?.delaySeconds, 5, String(first));
        const two = await consume(env, job(), 2);
        assert.equal(two.acked, true);
        assert.match(env.FILES.json(llmKey(TASK, "json")).error, pattern);
    }
});

test("consumer: a refusal or the safety filter fails the task with the model's reason", async () => {
    const env = makeEnv();
    stubFetch([{ json: { choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help with weapons designs." } }], usage: { cost: 0.0003 } } }]);
    const message = await consume(env, job(), 1);
    assert.equal(message.acked, true);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.error, "The model declined this request: I can't help with weapons designs.");
    assert.equal(record.cost_usd, 0.0003);

    const env2 = makeEnv();
    stubFetch([{ json: { choices: [{ finish_reason: "content_filter", message: { content: "" } }] } }]);
    await consume(env2, job(), 1);
    assert.match(env2.FILES.json(llmKey(TASK, "json")).error, /safety filter/);
});

test("consumer: a canceled task is skipped without a call; cancel during the call discards the result", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL)]);
    await env.FILES.put(llmKey(TASK, "cancel"), "canceled");
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "designing" }));
    const skipped = await consume(env, job());
    assert.equal(skipped.acked, true);
    assert.equal(calls.length, 0);
    assert.deepEqual([...env.FILES.store.keys()], [], "staging and marker are gone");

    const env2 = makeEnv();
    stubFetch(cancelDuringCall(env2));
    const midway = await consume(env2, job());
    assert.equal(midway.acked, true);
    assert.deepEqual([...env2.FILES.store.keys()], [], "nothing stored for a task nobody wants");
});
function cancelDuringCall(env) {
    return () => {
        // the user presses Stop while OpenRouter is still thinking
        env.FILES.store.set(llmKey(TASK, "cancel"), { bytes: new Uint8Array([1]), contentType: null });
        return modelReply(STOOL);
    };
}

test("consumer: a task delivered again after it finished is not designed (or paid for) twice", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL)]);
    for (const status of ["done", "failed"]) {
        await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status }));
        assert.equal((await consume(env, job(), 2)).acked, true);
    }
    assert.equal(calls.length, 0);
});

test("consumer: a missing key, a malformed message and a bucket error are all answered", async () => {
    const noKey = makeEnv({ OPENROUTER_API_KEY: undefined });
    const calls = stubFetch([]);
    assert.equal((await consume(noKey, job())).acked, true);
    assert.match(noKey.FILES.json(llmKey(TASK, "json")).error, /not configured/);

    const env = makeEnv();
    for (const body of [null, "x", {}, { taskId: "../../models/x", prompt: "a", model: "m" }, { taskId: TASK, prompt: "  ", model: "m" }, { taskId: TASK, prompt: "a" }]) {
        const message = await consume(env, body);
        assert.equal(message.acked, true, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
    assert.equal(env.FILES.store.size, 0);

    // R2 refuses the first write: another delivery; at the last one the failure is reported (if the bucket allows it)
    const broken = makeEnv();
    stubFetch([modelReply(STOOL)]);
    broken.FILES.fail.put = true;
    assert.deepEqual((await consume(broken, job(), 1)).retried, { delaySeconds: 5 });
    const last = await consume(broken, job(), 2);
    assert.equal(last.acked, true);
});

test("consumer: one junk part in the answer is dropped; the task is neither retried nor paid twice", async () => {
    const env = makeEnv();
    const calls = stubFetch(() => modelReply({ name: "t", parts: [part("", "constructor", [100, 100, 100], [0, 0, 50]), part("", "__proto__", [10, 10, 10], ORIGIN), part("ok", "box", [10, 10, 10], [0, 0, 5])] }));
    const message = await consume(env, job(), 1);
    assert.equal(message.acked, true);
    assert.equal(message.retried, null);
    assert.equal(calls.length, 1, "one paid call");
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.dropped, 2);
    assert.deepEqual(record.design.parts.map((p) => p.name), ["ok"]);
    assert.equal(record.cost_usd, 0.0008);
});

test("consumer: a surprise inside the repair fails the task at once, without a second paid call", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply({ name: "boom", parts: [part("boom", "box", [10, 10, 10], ORIGIN)] })]);
    const realForEach = Array.prototype.forEach;
    Array.prototype.forEach = function (...args) {
        if (this.length === 1 && this[0]?.name === "boom") throw new Error("unforeseen");
        return realForEach.apply(this, args);
    };
    let message;
    try {
        message = await consume(env, job(), 1);
    } finally {
        Array.prototype.forEach = realForEach;
    }
    assert.equal(message.acked, true);
    assert.equal(message.retried, null, "a deterministic failure is not retried");
    assert.equal(calls.length, 1);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.match(record.error, /could not process/);
    assert.equal(record.cost_usd, 0.0008);
    assert.ok(logged.some((line) => /repair failed: .*unforeseen/.test(line)));
});

test("consumer: the paid answer is saved first, so an R2 hiccup afterwards costs a rebuild, not a second call", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL)]);
    env.FILES.fail.putWhen = (key) => key.endsWith(".glb");
    const first = await consume(env, job(), 1);
    assert.deepEqual(first.retried, { delaySeconds: 5 });
    const saved = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(saved.status, "building");
    assert.equal(saved.design.parts.length, 6, "the repaired design is in the record");
    assert.equal(saved.cost_usd, 0.0008);
    assert.deepEqual(saved.usage, { prompt_tokens: 330, completion_tokens: 2100, reasoning_tokens: 800, cost_usd: 0.0008 });

    env.FILES.fail.putWhen = null;
    const second = await consume(env, job(), 2);
    assert.equal(second.acked, true);
    assert.equal(calls.length, 1, "the second delivery did not call OpenRouter");
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.cost_usd, 0.0008, "one call, paid once");
    assert.equal(record.usage.cost_usd, 0.0008);
    assert.equal(record.design.name, "Wooden stool");
    assert.deepEqual((await parse(env.FILES.store.get(llmKey(TASK, "glb")).bytes)).getRoot().listNodes().map((n) => n.getName()), ["Seat", "Leg", "Leg 2", "Leg 3", "Leg 4", "Ring brace"]);
    assert.ok(logged.some((line) => /attempt=2 resumed/.test(line)));
});

test("consumer: a build that keeps failing uses every delivery, pays once and reports what it cost", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL)]);
    env.FILES.fail.putWhen = (key) => key.endsWith(".glb");
    assert.deepEqual((await consume(env, job(), 1)).retried, { delaySeconds: 5 });
    assert.deepEqual((await consume(env, job(), 2)).retried, { delaySeconds: 5 }, "a saved answer makes another delivery cheap, so all three are used");
    const last = await consume(env, job(), 3);
    assert.equal(last.acked, true);
    assert.equal(calls.length, 1);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.match(record.error, /Something went wrong/);
    assert.equal(record.cost_usd, 0.0008, "the failure keeps the cost");
});

test("consumer: when the answer could not be saved, the next delivery asks again, and a final failure still reports the cost it knows", async () => {
    const env = makeEnv();
    const calls = stubFetch([modelReply(STOOL), modelReply(STOOL)]);
    env.FILES.fail.putWhen = (key, value) => typeof value === "string" && value.includes('"status":"building"');
    assert.deepEqual((await consume(env, job(), 1)).retried, { delaySeconds: 5 });
    const last = await consume(env, job(), 2);
    assert.equal(last.acked, true, "no saved answer: two deliveries, as before");
    assert.equal(calls.length, 2);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "failed");
    assert.equal(record.cost_usd, 0.0008);
});

test("consumer: the API key never reaches the log or R2", async () => {
    const env = makeEnv();
    stubFetch([modelReply(STOOL)]);
    await consume(env, job());
    for (const line of logged) assert.ok(!line.includes(KEY), "console output leaks the key");
    for (const [key, entry] of env.FILES.store) {
        assert.ok(!new TextDecoder().decode(entry.bytes).includes(KEY), `${key} leaks the key`);
    }
    assert.ok(logged.some((line) => /muse 764cabcf attempt=1 done parts=6/.test(line)), "one summary line per attempt");
});

// ---------- the r2: source of the job engine ----------

async function putStagedGlb(env, taskId = TASK) {
    stubFetch([modelReply(STOOL)]);
    await consume(env, job({ taskId }));
    return env.FILES.store.get(llmKey(taskId, "glb")).bytes;
}

test("glb.ts: storeGlb copies an r2:llm/<id>.glb into models/ and counts its parts", async () => {
    const env = makeEnv();
    const bytes = await putStagedGlb(env);
    const stored = await storeGlb(env, `r2:${llmKey(TASK, "glb")}`, "models/abc.glb");
    assert.equal(stored.size, bytes.byteLength);
    assert.equal(stored.partCount, 6);
    assert.deepEqual(new Uint8Array(env.FILES.store.get("models/abc.glb").bytes), new Uint8Array(bytes));
    assert.equal(env.FILES.store.get("models/abc.glb").contentType, "model/gltf-binary");
});

test("glb.ts: an r2: source may only name a staged designer file; a missing or oversized one is a clean error", async () => {
    const env = makeEnv();
    await env.FILES.put("models/secret.glb", new Uint8Array(40));
    for (const source of ["r2:models/secret.glb", "r2:llm/../models/secret.glb", `r2:llm/${TASK}.json`, "r2:", "r2:llm/x.glb"]) {
        await assert.rejects(storeGlb(env, source, "models/out.glb"), (err) => err instanceof ModelFileError && !err.retryable, source);
    }
    assert.ok(!env.FILES.has("models/out.glb"));
    await assert.rejects(storeGlb(env, `r2:${llmKey(TASK, "glb")}`, "models/out.glb"), (err) => err instanceof ModelFileError && !err.retryable && /no longer available/.test(err.message));
    // declared size over the limit: refused before a byte is copied
    env.FILES.store.set(llmKey(TASK, "glb"), { bytes: new Uint8Array(8), contentType: null });
    const original = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (key, options) => {
        const object = await original(key, options);
        return object && key === llmKey(TASK, "glb") ? { ...object, size: MAX_GLB_BYTES + 1 } : object;
    };
    await assert.rejects(storeGlb(env, `r2:${llmKey(TASK, "glb")}`, "models/out.glb"), /larger than the 150 MB limit/);
    // a bucket error while opening is worth another try; garbage is not a GLB
    env.FILES.get = async () => {
        throw new Error("R2 is down");
    };
    await assert.rejects(storeGlb(env, `r2:${llmKey(TASK, "glb")}`, "models/out.glb"), (err) => err instanceof ModelFileError && err.retryable === true);
});

test("glb.ts: a staged file that is not a GLB is refused and not kept", async () => {
    const env = makeEnv();
    await env.FILES.put(llmKey(TASK, "glb"), new Uint8Array(64).fill(7));
    await assert.rejects(storeGlb(env, `r2:${llmKey(TASK, "glb")}`, "models/out.glb"), /not a GLB/);
    assert.ok(!env.FILES.has("models/out.glb"));
});

test("end to end: submit -> consume -> poll -> storeGlb -> cleanup leaves nothing staged", async () => {
    const env = makeEnv();
    stubFetch([modelReply(STOOL)]);
    const { taskId, state } = await openRouterDesigner.submit(env, "a wooden stool");
    assert.equal((await openRouterDesigner.poll(env, taskId, state)).stage, "Designing the parts…");
    const [queued] = env.LLM_QUEUE.sent;
    assert.equal((await consume(env, queued)).acked, true);
    const polled = await openRouterDesigner.poll(env, taskId, state);
    assert.equal(polled.status, "succeeded");
    const stored = await storeGlb(env, polled.glbUrl, "models/final.glb");
    assert.equal(stored.partCount, 6);
    await openRouterDesigner.cleanup(env, taskId, state);
    assert.deepEqual([...env.FILES.store.keys()], ["models/final.glb"]);
});

// ---------- edits: the design edit and the mesh plan on the same queue ----------

/** A D1 stand-in for the tests that only need to see the day's AI-call slot handed back (the real D1 is used by the engine group below). */
function fakeDb() {
    const statements = [];
    return {
        statements,
        prepare(sql) {
            return {
                bind(...args) {
                    statements.push({ sql, args });
                    return { run: async () => ({ meta: { changes: 1 } }), first: async () => null };
                },
            };
        },
    };
}
const slotsHandedBack = (env) => env.DB.statements.filter((s) => /UPDATE usage SET llm = MAX/.test(s.sql)).length;

const SOURCE_ID = "5a4c4a6e-0000-4000-8000-000000000001";
const SOURCE_KEY = `models/${SOURCE_ID}.glb`;
const SOURCE = repairDesign(STOOL).design;
const DESIGN_EDIT = { target: "design", source_glb_key: SOURCE_KEY };
const editJob = (extra = {}) => job({ prompt: "make the seat red", edit: DESIGN_EDIT, ...extra });

/** An env for an edit: the source model is in the bucket, a stand-in D1 counts slots handed back. */
async function editEnv(extra = {}) {
    const env = makeEnv({ DB: fakeDb(), ...extra });
    await env.FILES.put(SOURCE_KEY, buildPartsGlb(SOURCE), { httpMetadata: { contentType: "model/gltf-binary" } });
    return env;
}
const patch = (extra = {}) => ({ summary: "Painted the seat red.", applied: true, remove: [], recolor: [], parts: [], ...extra });
const seatRed = () => patch({ parts: [{ ...SOURCE.parts[0], color: "#cc0000" }] });

test("design edit: the request has the edit prompt, the schema, the design and the instruction as a JSON string", async () => {
    const env = await editEnv();
    const calls = stubFetch([modelReply(seatRed())]);
    const message = await consume(env, editJob({ edit: { ...DESIGN_EDIT, original_prompt: "a wooden stool" } }));
    assert.equal(message.acked, true);
    assert.equal(calls.length, 1);
    const { body } = calls[0];
    assert.equal(body.model, "meta/muse-spark-1.3-contributor");
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[0], { role: "system", content: EDIT_SYSTEM_PROMPT });
    assert.equal(body.messages[1].role, "user");
    const text = body.messages[1].content;
    assert.match(text, /^Original description: "a wooden stool"\nDesign "Wooden stool" \(6 parts\), bounding box mm: /);
    assert.ok(text.includes(JSON.stringify(SOURCE.parts[0])), "the design as JSON lines");
    assert.ok(text.endsWith('\n\nEdit instruction: "make the seat red"'));
    assert.deepEqual(body.response_format, { type: "json_schema", json_schema: EDIT_PATCH_SCHEMA });
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.max_tokens, 8000);
});

test("design edit: the patch is applied, the new GLB embeds the new design and the record says what changed", async () => {
    const env = await editEnv();
    stubFetch([modelReply(seatRed(), { cost: 0.0004 })]);
    await consume(env, editJob());
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.cost_usd, 0.0004);
    assert.equal(record.plan, undefined);
    assert.equal(record.edit.summary, "Painted the seat red.");
    assert.deepEqual(record.edit.changes, { added: [], changed: ["Seat"], removed: [] });
    assert.match(record.edit.hash, /^[0-9a-f]{64}$/);
    assert.equal(record.edit.hash, await designHash(record.design));
    const glb = env.FILES.store.get(llmKey(TASK, "glb")).bytes;
    assert.deepEqual(designFromGlb(glb), record.design, "the file carries the design it was built from");
    assert.equal(record.design.parts.find((p) => p.name === "Seat").color, "#cc0000");
    assert.deepEqual(record.design.parts.find((p) => p.name === "Ring brace"), SOURCE.parts.find((p) => p.name === "Ring brace"), "a part the patch did not name is untouched");
    assert.equal(record.size_bytes, glb.byteLength);
    assert.equal(slotsHandedBack(env), 0, "the model was paid: the slot stays used");
    // what the job engine sees
    const state = { queued_at: Date.now(), edit: "design" };
    const verdict = await openRouterDesigner.poll(env, TASK, state);
    assert.equal(verdict.status, "succeeded");
    assert.equal(verdict.glbUrl, `r2:${llmKey(TASK, "glb")}`);
    assert.deepEqual(verdict.edit, { summary: "Painted the seat red.", changes: record.edit.changes, notes: [], hash: record.edit.hash, engine: "meta/muse-spark-1.3-contributor" });
    const parsed = await parse(glb);
    assert.equal(parsed.getRoot().listNodes().length, 6);
});

test("design edit: the answer is saved first; a delivery that finds it builds without asking again", async () => {
    const env = await editEnv();
    const calls = stubFetch([modelReply(seatRed())]);
    env.FILES.put = ((real) => async (key, value, options) => {
        if (key === llmKey(TASK, "glb") && !env.FILES.failedOnce) {
            env.FILES.failedOnce = true;
            throw new Error("R2 is down");
        }
        return real(key, value, options);
    })(env.FILES.put.bind(env.FILES));
    const first = await consume(env, editJob(), 1);
    assert.equal(first.retried?.delaySeconds, 5, "the build failed: another delivery");
    const building = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(building.status, "building");
    assert.equal(building.edit.summary, "Painted the seat red.");
    const second = await consume(env, editJob(), 2);
    assert.equal(second.acked, true);
    assert.equal(calls.length, 1, "OpenRouter was asked once");
    const done = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(done.status, "done");
    assert.equal(done.edit.summary, "Painted the seat red.");
    assert.ok(env.FILES.has(llmKey(TASK, "glb")));
});

test("design edit: 'cannot be done' and 'nothing changed' end as a result without a file", async () => {
    for (const [answer, applied, summary] of [
        [patch({ applied: false, summary: "That is not about this object." }), false, /not about this object/],
        [patch({ parts: [SOURCE.parts[0]], summary: "Left it as it is." }), false, /Nothing changed/],
        [patch({ remove: SOURCE.parts.map((p) => p.name), summary: "Removed everything." }), false, /remove every part/],
    ]) {
        const env = await editEnv();
        stubFetch([modelReply(answer)]);
        const message = await consume(env, editJob());
        assert.equal(message.acked, true);
        const record = env.FILES.json(llmKey(TASK, "json"));
        assert.equal(record.status, "done");
        assert.equal(record.plan.target, "design");
        assert.equal(record.plan.applied, applied);
        assert.match(record.plan.summary, summary);
        assert.deepEqual(record.plan.changes, { added: [], changed: [], removed: [] });
        assert.ok(!env.FILES.has(llmKey(TASK, "glb")), "no file");
        const verdict = await openRouterDesigner.poll(env, TASK, { queued_at: Date.now() });
        assert.equal(verdict.status, "succeeded");
        assert.equal(verdict.glbUrl, undefined);
        assert.deepEqual(verdict.plan, record.plan);
    }
});

test("design edit: a 429 is retried with the vendor's delay, a cut-off answer asks for less, an unreadable answer is tried once more", async () => {
    let env = await editEnv();
    stubFetch([{ ...errorReply(429, "slow down"), headers: { "retry-after": "17" } }]);
    let message = await consume(env, editJob(), 1);
    assert.equal(message.retried?.delaySeconds, 17);
    assert.equal(slotsHandedBack(env), 0, "still going: the slot is kept");
    stubFetch([modelReply(seatRed())]);
    message = await consume(env, editJob(), 2);
    assert.equal(message.acked, true);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "done");

    env = await editEnv();
    stubFetch([{ json: { choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"summary":"x","ap' } }], usage: { cost: 0.001, completion_tokens: 8000 } } }]);
    message = await consume(env, editJob(), 1);
    assert.ok(message.retried);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).simplify, true);
    const again = stubFetch([modelReply(seatRed())]);
    await consume(env, editJob(), 2);
    assert.match(again[0].body.messages[0].content, /change as few parts as you can/, "the second try asks for less");
    assert.ok(again[0].body.messages[0].content.startsWith(EDIT_SYSTEM_PROMPT));

    env = await editEnv();
    stubFetch([textReply("I would love to help but here is prose, no JSON."), textReply("still prose")]);
    message = await consume(env, editJob(), 1);
    assert.ok(message.retried);
    message = await consume(env, editJob(), 2);
    assert.equal(message.acked, true);
    const failed = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /edit the app could not read/);
    assert.equal(slotsHandedBack(env), 0, "the model answered (and billed): the slot is spent");
});

test("design edit: a refused call gives the day's slot back; a refused call that was billed does not", async () => {
    let env = await editEnv();
    stubFetch([errorReply(403, "flagged by moderation", { metadata: { reasons: ["violence"] } })]);
    let message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /content policy/);
    assert.equal(slotsHandedBack(env), 1);

    env = await editEnv();
    stubFetch([errorReply(401, "bad key")]);
    await consume(env, editJob());
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /key was rejected/);
    assert.equal(slotsHandedBack(env), 1);

    env = await editEnv();
    stubFetch([{ json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", refusal: "I can't help with that." } }], usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.0002 } } }]);
    message = await consume(env, editJob());
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /declined/);
    assert.equal(slotsHandedBack(env), 0, "the call was billed");

    // gave up after 429s: nothing was billed
    env = await editEnv();
    stubFetch([errorReply(429, "slow")]);
    message = await consume(env, editJob(), 3);
    assert.equal(message.acked, true);
    assert.equal(slotsHandedBack(env), 1);

    // the connection dropped: it may have been billed, so the slot is kept
    env = await editEnv();
    stubFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await consume(env, editJob(), 1);
    await consume(env, editJob(), 2);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).status, "failed");
    assert.equal(slotsHandedBack(env), 0);
});

test("design edit: a source that is gone or is not a parts design fails the task without calling the model, and gives the slot back", async () => {
    let env = makeEnv({ DB: fakeDb() });
    let calls = stubFetch([]);
    let message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /no longer available/);
    assert.equal(calls.length, 0);
    assert.equal(slotsHandedBack(env), 1);

    env = makeEnv({ DB: fakeDb() });
    await env.FILES.put(SOURCE_KEY, readFile(new URL("../../public/assignment_alex/fixtures/demo-assembly.glb", import.meta.url)));
    calls = stubFetch([]);
    await consume(env, editJob());
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /parts can't be read/);
    assert.equal(calls.length, 0);
    assert.equal(slotsHandedBack(env), 1);
});

test("design edit: no key is a clear failure that gives the slot back; Stop before the call does too and removes every staging file", async () => {
    let env = await editEnv({ OPENROUTER_API_KEY: undefined });
    let calls = stubFetch([]);
    let message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /AI editor is not configured/);
    assert.equal(calls.length, 0);
    assert.equal(slotsHandedBack(env), 1);

    env = await editEnv();
    await env.FILES.put(llmKey(TASK, "in"), "{}");
    await env.FILES.put(llmKey(TASK, "cancel"), "canceled");
    calls = stubFetch([]);
    message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.equal(calls.length, 0);
    assert.equal(slotsHandedBack(env), 1);
    assert.deepEqual(stagingKeys(TASK).filter((k) => env.FILES.has(k)), [], "record, file, marker and pictures are all gone");

    // Stop after the model answered: the money is spent, the slot is not handed back
    env = await editEnv();
    stubFetch(() => {
        env.FILES.store.set(llmKey(TASK, "cancel"), { bytes: new Uint8Array([1]), contentType: null });
        return modelReply(seatRed());
    });
    message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.equal(slotsHandedBack(env), 0);
    assert.ok(!env.FILES.has(llmKey(TASK, "glb")));
});

test("design edit: with MOCK_PROVIDER=1 the answer is canned, nothing is sent and no key is needed; MOCK_LLM=0 turns that off", async () => {
    let env = await editEnv({ MOCK_PROVIDER: "1", OPENROUTER_API_KEY: undefined });
    const calls = stubFetch([]);
    let message = await consume(env, editJob());
    assert.equal(message.acked, true);
    assert.equal(calls.length, 0, "no network");
    let record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.cost_usd, 0);
    assert.ok(record.design.parts.every((p) => p.color === "#d9534f"), "every part repainted");
    assert.equal(record.edit.changes.changed.length, 6);
    // a second edit of the repainted model gives the other colour: two edits in a row differ
    env.FILES.store.set(SOURCE_KEY, { bytes: env.FILES.store.get(llmKey(TASK, "glb")).bytes, contentType: null });
    await env.FILES.delete([llmKey(TASK, "json"), llmKey(TASK, "glb")]);
    await consume(env, editJob());
    record = env.FILES.json(llmKey(TASK, "json"));
    assert.ok(record.design.parts.every((p) => p.color === "#5cb85c"));

    env = await editEnv({ MOCK_PROVIDER: "1", MOCK_LLM: "0" });
    const live = stubFetch([modelReply(seatRed())]);
    await consume(env, editJob());
    assert.equal(live.length, 1, "MOCK_LLM=0 asks the real model");
});

test("edit messages that name anything but the task's own files are dropped, and a generation is not affected by the edit code", async () => {
    for (const edit of [
        { target: "design", source_glb_key: "../../models/x.glb" },
        { target: "design", source_glb_key: "llm/764cabcf-b745-4b3e-ae38-1200304cf45b.json" },
        { target: "design", source_glb_key: "static:/assignment_alex/examples/x/original.glb" },
        { target: "design" },
        { target: "mesh", package_key: `llm/${TASK2}.in.json` },
        { target: "mesh", package_key: "models/x.glb" },
        { target: "voxel", source_glb_key: SOURCE_KEY },
        "design",
        7,
    ]) {
        const env = await editEnv();
        const calls = stubFetch([]);
        const message = await consume(env, editJob({ edit }));
        assert.equal(message.acked, true, JSON.stringify(edit));
        assert.equal(calls.length, 0);
        assert.ok(!env.FILES.has(llmKey(TASK, "json")), "nothing written for a message the consumer does not know");
        assert.equal(slotsHandedBack(env), 0);
    }
    const env = makeEnv();
    stubFetch([modelReply(STOOL)]);
    await consume(env, job());
    assert.equal(env.FILES.json(llmKey(TASK, "json")).edit, undefined);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).charged, undefined, "a generation record is what it was before edits existed");
});

test("adapter: an edit job puts the source key on the queue; a mesh job stores its pictures first and names them", async () => {
    const env = await editEnv();
    const submitted = await openRouterDesigner.submit(env, "make the seat red", {
        edit: { target: "design", sourceGlbKey: SOURCE_KEY, originalPrompt: "a wooden stool" },
        model: "meta/muse-spark-1.3-contributor",
    });
    const [message] = env.LLM_QUEUE.sent;
    assert.deepEqual(message, { taskId: submitted.taskId, prompt: "make the seat red", model: "meta/muse-spark-1.3-contributor", edit: { target: "design", source_glb_key: SOURCE_KEY, original_prompt: "a wooden stool" } });
    assert.equal(submitted.state.edit, "design");
    assert.equal((await openRouterDesigner.poll(env, submitted.taskId, submitted.state)).stage, "Designing the change");

    const pictures = JSON.stringify({ package: { facts: "x", views: [] }, refine: null });
    const mesh = await openRouterDesigner.submit(env, "make the back taller", { edit: { target: "mesh", request: pictures, refine: false } });
    const sent = env.LLM_QUEUE.sent[1];
    assert.deepEqual(sent.edit, { target: "mesh", package_key: llmKey(mesh.taskId, "in") });
    assert.equal(env.FILES.text(llmKey(mesh.taskId, "in")), pictures);
    assert.equal(env.FILES.store.get(llmKey(mesh.taskId, "in")).contentType, "application/json");
    assert.equal(llmKey(mesh.taskId, "in"), `llm/${mesh.taskId}.in.json`);
    assert.equal((await openRouterDesigner.poll(env, mesh.taskId, mesh.state)).stage, "Planning the edit");
    assert.equal(sent.prompt.length < 1000 && JSON.stringify(sent).length < 600, true, "the message stays small: the pictures are in the bucket");

    // the queue refuses: nothing stays behind and the slot can go back (a non-retryable error)
    env.LLM_QUEUE.failNext = true;
    await assert.rejects(() => openRouterDesigner.submit(env, "again", { edit: { target: "mesh", request: pictures, refine: false } }), (err) => err instanceof ProviderError && !err.retryable);
    assert.equal([...env.FILES.store.keys()].filter((k) => k.endsWith(".in.json")).length, 1, "only the first job's pictures remain");
    env.LLM_QUEUE.failNext = false;

    // no key: refused, except in the offline demo
    await assert.rejects(() => openRouterDesigner.submit({ ...env, OPENROUTER_API_KEY: undefined }, "x", { edit: { target: "design", sourceGlbKey: SOURCE_KEY, originalPrompt: null } }), /OPENROUTER_API_KEY/);
    const demo = await openRouterDesigner.submit({ ...env, OPENROUTER_API_KEY: undefined, MOCK_PROVIDER: "1" }, "x", { edit: { target: "design", sourceGlbKey: SOURCE_KEY, originalPrompt: null } });
    assert.ok(demo.taskId);
    await assert.rejects(() => openRouterDesigner.submit({ ...env, OPENROUTER_API_KEY: undefined, MOCK_PROVIDER: "1" }, "plain generation"), /OPENROUTER_API_KEY/, "the demo never stands in for a generation");
});

test("adapter: Stop and clean-up remove the pictures of a mesh job too", async () => {
    const env = await editEnv();
    for (const file of ["json", "glb", "in"]) await env.FILES.put(llmKey(TASK, file), "x");
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "done", plan: { target: "mesh", applied: true, summary: "s", notes: [] } }));
    await openRouterDesigner.cancel(env, TASK, null);
    assert.deepEqual(stagingKeys(TASK).filter((k) => env.FILES.has(k)), [], "a finished task: everything goes");
    for (const file of ["json", "glb", "in", "cancel"]) await env.FILES.put(llmKey(TASK, file), "x");
    await env.FILES.put(llmKey(TASK, "json"), JSON.stringify({ status: "designing" }));
    await openRouterDesigner.cleanup(env, TASK, null);
    assert.deepEqual(stagingKeys(TASK).filter((k) => env.FILES.has(k)), [llmKey(TASK, "cancel")], "the Stop marker outlives clean-up while the consumer may still come");
});

// ---- the plan of a mesh edit ----

const PICTURE = `data:image/jpeg;base64,${Buffer.from("not really a jpeg but base64").toString("base64")}`;
const MESH_REQUEST = {
    package: {
        version: 1,
        frame: { size_mm: [643, 851, 1000], facing: "-Y" },
        facts: "Model facts: size X 643 mm, Y 851 mm, Z 1000 mm; 499,808 triangles; textured.",
        views: ["FRONT", "SIDE", "TOP"].map((id) => ({ id, caption: `${id} view caption`, image: PICTURE })),
        pieces: null,
        extras: null,
        original_prompt: "a rocking chair",
    },
    refine: null,
};
const MESH_EDIT = { target: "mesh", package_key: llmKey(TASK, "in") };
const meshJob = (extra = {}) => job({ prompt: "make the backrest taller", edit: MESH_EDIT, ...extra });
const FLAT_OP = { op: "stretch", label: "backrest", boxes: [{ min: [-300, 0, 600], max: [300, 300, 1000] }], exclude: [], feather_mm: 40, axis: "z", from_mm: 700, to_mm: 900, amount_mm: 150, vector_mm: [0, 0, 0], factors: [1, 1, 1], pivot_mm: [0, 0, 0], degrees: 0, mirror_at_mm: 0, color: "#000000", strength: 0, parts: [] };
const programAnswer = (extra = {}) => ({ summary: "Made the backrest 150 mm taller.", applied: true, regen_prompt: "", ops: [FLAT_OP], ...extra });

async function meshEnv(extra = {}) {
    const env = makeEnv({ DB: fakeDb(), ...extra });
    await env.FILES.put(llmKey(TASK, "in"), JSON.stringify(MESH_REQUEST), { httpMetadata: { contentType: "application/json" } });
    return env;
}

test("mesh plan: the model gets the pictures and the facts, the cleaned program is left in the record (no file)", async () => {
    const env = await meshEnv();
    const calls = stubFetch([modelReply(programAnswer(), { cost: 0.0006 })]);
    const message = await consume(env, meshJob());
    assert.equal(message.acked, true);
    const { body } = calls[0];
    assert.deepEqual(body.messages[0], { role: "system", content: MESH_SYSTEM_PROMPT });
    assert.deepEqual(body.response_format, { type: "json_schema", json_schema: MESH_PROGRAM_SCHEMA });
    const user = body.messages[1].content;
    assert.equal(user[0].type, "text");
    assert.equal(user[0].text, meshUserText(MESH_REQUEST.package, "make the backrest taller"));
    assert.match(user[0].text, /^Model facts: size X 643 mm[\s\S]*Original description: "a rocking chair"\nFRONT view caption\nSIDE view caption\nTOP view caption\n\nEdit instruction: make the backrest taller$/);
    assert.deepEqual(user.slice(1), [PICTURE, PICTURE, PICTURE].map((url) => ({ type: "image_url", image_url: { url } })));
    assert.equal(body.max_tokens, 8000);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.plan.target, "mesh");
    assert.equal(record.plan.applied, true);
    assert.equal(record.plan.summary, "Made the backrest 150 mm taller.");
    assert.equal(record.plan.program.ops.length, 1);
    assert.equal(record.plan.program.ops[0].op, "stretch");
    assert.ok(!env.FILES.has(llmKey(TASK, "glb")));
    const verdict = await openRouterDesigner.poll(env, TASK, { queued_at: Date.now(), edit: "mesh" });
    assert.deepEqual(verdict, { status: "succeeded", plan: record.plan });
    assert.equal(slotsHandedBack(env), 0);
});

test("mesh plan: 'cannot be done' is a result; an answer with nothing to run is tried once more; unreadable pictures fail early", async () => {
    let env = await meshEnv();
    stubFetch([modelReply({ summary: "Not about this model.", applied: false, regen_prompt: "", ops: [] })]);
    await consume(env, meshJob());
    let record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.plan.applied, false);
    assert.deepEqual(record.plan.program.ops, []);

    env = await meshEnv();
    stubFetch([modelReply({ summary: "x", applied: true, ops: [] })]);
    let message = await consume(env, meshJob(), 1);
    assert.ok(message.retried, "no usable operation: one more try");
    assert.match(env.FILES.json(llmKey(TASK, "json")).status, /designing/);

    env = makeEnv({ DB: fakeDb() });
    await env.FILES.put(llmKey(TASK, "in"), "{not json");
    const calls = stubFetch([]);
    message = await consume(env, meshJob());
    assert.equal(message.acked, true);
    assert.equal(calls.length, 0);
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /pictures of the model could not be read/);
    assert.equal(slotsHandedBack(env), 1);
    env = makeEnv({ DB: fakeDb() });
    message = await consume(env, meshJob());
    assert.match(env.FILES.json(llmKey(TASK, "json")).error, /no longer available/);
});

test("mesh plan: the second pass (off in the product) sends the first program back with the zoomed pictures", async () => {
    const env = makeEnv({ DB: fakeDb() });
    const first = programAnswer();
    await env.FILES.put(llmKey(TASK, "in"), JSON.stringify({ ...MESH_REQUEST, refine: { program: first, views: [{ id: "FRONT", caption: "FRONT zoom", image: PICTURE }] } }));
    const calls = stubFetch([modelReply(programAnswer({ summary: "Second pass." }))]);
    await consume(env, meshJob({ edit: { ...MESH_EDIT, refine: true } }));
    const { messages } = calls[0].body;
    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.match(messages[1].content, /pictures omitted in this history/);
    assert.deepEqual(JSON.parse(messages[2].content), first);
    assert.match(messages[3].content[0].text, /^Second pass\. Below are ZOOMED pictures/);
    assert.match(messages[3].content[0].text, /FRONT zoom$/);
    assert.equal(messages[3].content[1].image_url.url, PICTURE);
    assert.equal(env.FILES.json(llmKey(TASK, "json")).plan.summary, "Second pass.");
});

test("mesh plan: with MOCK_PROVIDER=1 the plan is one whole-model recolor, offline", async () => {
    const env = await meshEnv({ MOCK_PROVIDER: "1", OPENROUTER_API_KEY: undefined });
    const calls = stubFetch([]);
    const message = await consume(env, meshJob());
    assert.equal(message.acked, true);
    assert.equal(calls.length, 0);
    const record = env.FILES.json(llmKey(TASK, "json"));
    assert.equal(record.status, "done");
    assert.equal(record.plan.program.ops.length, 1);
    assert.equal(record.plan.program.ops[0].op, "recolor");
    assert.deepEqual(record.plan.program.ops[0].boxes, [], "the whole model");
});

// ---------- the job engine and the purge, on a real local D1 ----------

const ROOT = new URL("../../", import.meta.url);
let engineState = null;

/** wrangler's getPlatformProxy gives a real (local, temp-folder) D1; with every migration applied. Null-ish `skip` when it cannot start. */
async function openEngine() {
    if (engineState) return engineState;
    let dir = null;
    const outerTmp = process.env.TMPDIR;
    const restoreTmp = () => (outerTmp === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = outerTmp));
    try {
        dir = mkdtempSync(join(tmpdir(), "muse-engine-"));
        process.env.TMPDIR = dir; // wrangler leaves scratch folders in the temp dir: keep them inside ours, which is removed at the end
        const { getPlatformProxy } = await import("wrangler");
        const proxy = await getPlatformProxy({ configPath: new URL("wrangler.jsonc", ROOT).pathname, persist: { path: join(dir, "state") }, remoteBindings: false });
        const migrations = new URL("migrations/", ROOT).pathname;
        for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
            // line comments are cut (a whole line, or the tail of a statement line: no migration has "--" inside a string)
            const sql = readFileSync(join(migrations, file), "utf8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
            for (const statement of sql.split(";").map((x) => x.trim()).filter(Boolean)) await proxy.env.DB.prepare(statement).run();
        }
        engineState = {
            db: proxy.env.DB,
            dispose: async () => {
                await proxy.dispose().catch(() => {});
                restoreTmp();
                rmSync(dir, { recursive: true, force: true });
            },
        };
    } catch (err) {
        restoreTmp();
        if (dir) rmSync(dir, { recursive: true, force: true });
        engineState = { skip: String(err?.message ?? err).split("\n")[0] };
    }
    return engineState;
}

/** A test that needs the D1 above; the bucket, the queue and fetch stay the stubs of the other tests (no key, no network). */
function engineTest(name, fn) {
    test(`engine: ${name}`, async () => {
        const engine = await openEngine();
        if (engine.skip) {
            realLog(`      skipped: wrangler's local D1 is not available (${engine.skip})`);
            return;
        }
        await fn(makeEnv({ DB: engine.db, ASSETS: { fetch: async () => new Response("", { status: 404 }) }, ALLOW_OPEN_GENERATION: "1" }));
    });
}

const noContext = () => ({ waitUntil() {}, passThroughOnException() {} });
const stagedKeys = (env) => [...env.FILES.store.keys()].filter((k) => k.startsWith("llm/")).sort();
const jobRow = (env, id) => env.DB.prepare("SELECT status, stage, error, model_id FROM jobs WHERE id = ?1").bind(id).first();

async function seedProject(env, { trashed = false } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO projects (id, name, created_at, modified_at, deleted_at) VALUES (?1, 'p', ?2, ?2, ?3)").bind(id, now, trashed ? now : null).run();
    return id;
}

async function seedJob(env, projectId, { taskId = crypto.randomUUID(), provider = "muse", via = "openrouter", queuedAt = Date.now(), finalizeAttempts = 0 } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, provider_task_id, provider_state, created_at, updated_at, finalize_attempts)
         VALUES (?1, ?2, ?3, ?4, 'a stool', 'running', 0, 'Submitted', ?5, ?6, ?7, ?7, ?8)`,
    ).bind(id, projectId, provider, via, taskId, JSON.stringify({ queued_at: queuedAt }), now, finalizeAttempts).run();
    return { id, taskId };
}

/** Lets the real consumer design (stubbed OpenRouter) so the bucket holds what a finished task leaves there. */
async function finishDesign(env, taskId) {
    stubFetch([modelReply(STOOL)]);
    assert.equal((await consume(env, job({ taskId }))).acked, true);
    assert.equal(env.FILES.json(llmKey(taskId, "json")).status, "done");
}

engineTest("a finished design becomes a model and every staging file goes, a late cancel marker included", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env));
    await finishDesign(env, taskId);
    await env.FILES.put(llmKey(taskId, "cancel"), "canceled"); // a Stop that arrived while the last step ran
    const result = await advanceJob(env, noContext(), id);
    assert.equal(result.status, "succeeded", result.error ?? "");
    assert.ok(env.FILES.has(`models/${(await jobRow(env, id)).model_id}.glb`));
    assert.deepEqual(stagedKeys(env), []);
});

engineTest("a design that never came back fails after the time-out and keeps only the marker that stops the consumer", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env), { queuedAt: Date.now() - DESIGN_TIMEOUT_MS - 60_000 });
    await env.FILES.put(llmKey(taskId, "json"), JSON.stringify({ status: "designing" }));
    const result = await advanceJob(env, noContext(), id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /took too long/);
    assert.deepEqual(stagedKeys(env), [llmKey(taskId, "cancel")], "the consumer must still find the marker if it ever gets the message");
});

engineTest("a staged file that is not a GLB fails the job for good and releases the staging", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env));
    await env.FILES.put(llmKey(taskId, "glb"), new Uint8Array(64).fill(7));
    await env.FILES.put(llmKey(taskId, "json"), JSON.stringify({ status: "done" }));
    await env.FILES.put(llmKey(taskId, "cancel"), "canceled");
    const result = await advanceJob(env, noContext(), id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /not a GLB/);
    assert.deepEqual(stagedKeys(env), []);
});

engineTest("a job out of save attempts fails and releases the staging", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env), { finalizeAttempts: 3 });
    await finishDesign(env, taskId);
    const result = await advanceJob(env, noContext(), id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /after several tries/);
    assert.deepEqual(stagedKeys(env), []);
});

engineTest("a save that fails for a passing reason keeps the staging for the next poll", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env));
    await finishDesign(env, taskId);
    const real = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (key, options) => {
        if (key.endsWith(".glb")) throw new Error("R2 is down");
        return real(key, options);
    };
    const result = await advanceJob(env, noContext(), id);
    assert.equal(result.status, "running");
    assert.equal(result.stage, "Retrying the save");
    assert.deepEqual(stagedKeys(env), [llmKey(taskId, "glb"), llmKey(taskId, "json")].sort());
});

engineTest("Stop leaves the marker for a designer still at work and takes its staged files away", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env));
    await env.FILES.put(llmKey(taskId, "json"), JSON.stringify({ status: "designing" }));
    const result = await cancelJob(env, new Request("https://example.test/jobs/x/cancel", { method: "POST" }), id);
    assert.equal(result.status, "canceled");
    assert.deepEqual(stagedKeys(env), [llmKey(taskId, "cancel")]);
});

engineTest("Stop that loses the race with a finishing designer leaves nothing behind", async (env) => {
    const { id, taskId } = await seedJob(env, await seedProject(env));
    await env.FILES.put(llmKey(taskId, "json"), JSON.stringify({ status: "building" }));
    // the consumer finishes right after Stop looked at the record
    const real = env.FILES.get.bind(env.FILES);
    let reads = 0;
    env.FILES.get = async (key, options) => {
        const out = await real(key, options);
        if (key === llmKey(taskId, "json") && ++reads === 1) {
            env.FILES.store.set(key, { bytes: new TextEncoder().encode(JSON.stringify({ status: "done" })), contentType: null });
            env.FILES.store.set(llmKey(taskId, "glb"), { bytes: new Uint8Array(8), contentType: null });
        }
        return out;
    };
    const result = await cancelJob(env, new Request("https://example.test/jobs/x/cancel", { method: "POST" }), id);
    assert.equal(result.status, "canceled");
    assert.deepEqual(stagedKeys(env), [], "record, file and marker are all gone");
});

engineTest("purging projects removes the staging files of their Muse jobs, and only theirs", async (env) => {
    const gone = await seedProject(env, { trashed: true });
    const kept = await seedProject(env);
    const a = await seedJob(env, gone);
    const odd = await seedJob(env, gone, { taskId: "../models/precious" });
    await seedJob(env, gone, { provider: "tripo", via: "fal", taskId: "fal-task-1" });
    const c = await seedJob(env, kept);
    for (const task of [a.taskId, c.taskId]) for (const file of ["json", "glb", "cancel", "in"]) await env.FILES.put(llmKey(task, file), "x");
    await env.FILES.put("models/precious.glb", "x");
    assert.equal(await purgeProjects(env, [gone]), 1);
    assert.deepEqual(stagedKeys(env), stagingKeys(c.taskId).sort(), "the other project's files stay");
    assert.ok(env.FILES.has("models/precious.glb"), "a task id that is not a uuid names nothing");
    assert.equal(await jobRow(env, a.id), null);
    assert.equal(await jobRow(env, odd.id), null);
    assert.ok(await jobRow(env, c.id));
});

// ---------- run ----------

let passed = 0;
const failures = [];
const t0 = Date.now();
for (const { name, fn } of tests) {
    try {
        await fn();
        passed++;
    } catch (err) {
        failures.push({ name, err });
    } finally {
        globalThis.fetch = realFetch;
    }
}
await engineState?.dispose?.();
console.log = realLog;
console.error = realError;

for (const { name, err } of failures) {
    console.error(`FAIL  ${name}\n      ${String(err?.stack ?? err).split("\n").slice(0, 8).join("\n      ")}`);
}
console.log(`\n${passed}/${tests.length} Muse tests passed in ${Date.now() - t0} ms`);
process.exit(failures.length === 0 ? 0 : 1);
