// Tests for the direct AI lane (worker/llmCall.ts and worker/voxelEdit.ts): one OpenRouter chat call that returns JSON. The vendor is a stub of `fetch`
// and the database a small fake, so every thing the vendor can say is covered without a key or a network.
//
//   node scripts/assignment/test-llm-call.mjs
//
// What it pins: what the request to the vendor carries (the Worker's own prompt and strict schema, the key only in the header, the model, the effort
// and the limits), what each answer becomes (the model's JSON, the cost, the status for a refusal / a filter / a cut-off / a rate limit / a 5xx), the
// one retry, the daily slot (taken first, handed back when the call fails, kept when the model was paid and answered rubbish), the guards, and that the
// key never appears in anything that leaves the Worker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { callOpenRouterJson, extractJson, usageOf, reserveLlmSlot, refundLlmSlot, llmDailyLimit } = await import(path.join(root, "worker/llmCall.ts"));
const { editModelOf } = await import(path.join(root, "worker/providers/openrouter.ts"));
const { handleVoxelEdit } = await import(path.join(root, "worker/voxelEdit.ts"));
const { VOXEL_EDIT_SCHEMA, VOXEL_EDIT_SYSTEM_PROMPT } = await import(path.join(root, "src/assignment/shared/voxelEdit/prompt.ts"));
const { HttpError } = await import(path.join(root, "worker/util.ts"));
const { ACCESS_HEADER } = await import(path.join(root, "src/assignment/shared/contract.ts"));

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).split("\n").slice(0, 4).join("\n").replace(/^/gm, "       ")}`);
    }
}

// ---------- the world: a vendor and a database ----------

const KEY = "sk-or-v1-THIS-IS-A-TEST-KEY-0123456789abcdef";
const realFetch = globalThis.fetch;
const realWarn = console.warn, realError = console.error, realLog = console.log;
let vendor = []; // queued replies: Response | Error | function
let sent = []; // the requests the vendor received
globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    const next = vendor.shift();
    if (next === undefined) throw new Error("the vendor was asked more often than the test expected");
    const reply = typeof next === "function" ? await next() : next;
    if (reply instanceof Error) throw reply;
    return reply;
};
const reply = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const completion = (content, extra = {}) => reply(200, { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop", ...extra.choice }], usage: { prompt_tokens: 2600, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 }, cost: 0.00045 }, ...extra.body });
const GOOD = { summary: "Added a column.", notes: "", clarification: "", ops: [{ op: "add", region: null, box: [2, 2, 0, 2, 2, 1], dirs: null, amount: null, axis: null, at: null, plane: null, offset: null, wall: null, include_added: false }] };

/** A D1 that knows the one table these calls touch. */
function fakeDb(start = 0) {
    const db = { llm: start, calls: [] };
    db.prepare = (sql) => ({
        bind: (...args) => ({
            first: async () => {
                db.calls.push(["first", sql.trim().split("\n")[0], args]);
                if (/INSERT INTO usage \(day, llm\)/.test(sql)) {
                    if (db.llm >= args[1]) return null;
                    db.llm++;
                    return { llm: db.llm };
                }
                throw new Error(`unexpected first(): ${sql}`);
            },
            run: async () => {
                db.calls.push(["run", sql.trim().split("\n")[0], args]);
                if (/UPDATE usage SET llm = MAX/.test(sql)) db.llm = Math.max(0, db.llm - 1);
                return { success: true };
            },
        }),
    });
    return db;
}
// (ALLOW_OPEN_GENERATION is what wrangler.jsonc sets: without it, or an access code, a real key is closed. See the test of that below.)
const envOf = (over = {}) => ({ DB: fakeDb(), OPENROUTER_API_KEY: KEY, ALLOW_OPEN_GENERATION: "1", ...over });
const request = (body, headers = {}) => new Request("https://x.test/api/assignment_alex/llm/voxel-edit", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const good = { instruction: "add a column under the seat", scene: "MODEL: chair. GRID 10x10x10" };
const reset = () => { vendor = []; sent = []; };
const fails = async (promise, status, pattern) => {
    try {
        await promise;
    } catch (e) {
        assert.ok(e instanceof HttpError, `an HttpError, not ${e?.stack ?? e}`);
        assert.equal(e.status, status, `${e.status} ${e.message}`);
        if (pattern) assert.match(e.message, pattern);
        return e;
    }
    assert.fail(`expected a ${status}`);
};

// ---------- the helpers ----------

console.log("llmCall");
await test("extractJson takes the whole text, or the outermost braces, or nothing", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('  {"a":1}\n'), { a: 1 });
    assert.deepEqual(extractJson('Sure! Here it is: {"a":{"b":2}} Hope it helps.'), { a: { b: 2 } });
    assert.equal(extractJson("no json here"), undefined);
    assert.equal(extractJson(""), undefined);
    assert.equal(extractJson("{broken"), undefined);
});
await test("usageOf reads tokens and cost, and is all null for a body without them", () => {
    assert.deepEqual(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.001 } }), { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 3, cost_usd: 0.001 });
    assert.deepEqual(usageOf(null), { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, cost_usd: null });
    assert.equal(usageOf({ usage: { cost: -1 } }).cost_usd, null);
});
await test("the daily slot: taken with one atomic statement, refused over the cap, handed back, the cap is a setting", async () => {
    const env = envOf({ DAILY_LLM_LIMIT: "2" });
    assert.equal(llmDailyLimit(env), 2);
    assert.equal(llmDailyLimit({}), 400);
    assert.equal(llmDailyLimit({ DAILY_LLM_LIMIT: "0" }), 400);
    assert.equal(llmDailyLimit({ DAILY_LLM_LIMIT: "many" }), 400);
    assert.equal(await reserveLlmSlot(env), true);
    assert.equal(await reserveLlmSlot(env), true);
    assert.equal(await reserveLlmSlot(env), false);
    await refundLlmSlot(env);
    assert.equal(env.DB.llm, 1);
    assert.equal(await reserveLlmSlot(env), true);
    await refundLlmSlot(envOf());
    const empty = envOf();
    await refundLlmSlot(empty);
    assert.equal(empty.DB.llm, 0, "never below zero");
    assert.ok(env.DB.calls.some((c) => /ON CONFLICT/.test(c[1]) || /INSERT INTO usage/.test(c[1])));
});
await test("the edit model: OPENROUTER_EDIT_MODEL when it looks like a model id, else the designer's", () => {
    assert.equal(editModelOf({ OPENROUTER_EDIT_MODEL: "meta/muse-spark-1.3-contributor" }), "meta/muse-spark-1.3-contributor");
    assert.equal(editModelOf({ OPENROUTER_EDIT_MODEL: "x y; drop table" }), editModelOf({}));
    assert.equal(editModelOf({ OPENROUTER_EDIT_MODEL: "  vendor/model:free " }), "vendor/model:free");
});
await test("callOpenRouterJson sends the Worker's own prompt and schema, the key only in the header, and returns the content with the cost", async () => {
    reset();
    vendor.push(completion(GOOD));
    const env = envOf({ OPENROUTER_EDIT_MODEL: "meta/muse-spark-1.3-contributor" });
    const res = await callOpenRouterJson(env, { system: "SYS", user: "USER", schema: VOXEL_EDIT_SCHEMA, maxTokens: 4000, effort: "low", timeoutMs: 45_000 });
    assert.ok(res.ok);
    assert.deepEqual(extractJson(res.content), GOOD);
    assert.equal(res.usage.cost_usd, 0.00045);
    assert.equal(res.model, "meta/muse-spark-1.3-contributor");
    assert.equal(sent.length, 1);
    const [req] = sent;
    assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(req.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(JSON.stringify(req.body).includes(KEY), false, "the key is not in the body");
    assert.deepEqual(req.body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
    assert.deepEqual(req.body.response_format, { type: "json_schema", json_schema: VOXEL_EDIT_SCHEMA });
    assert.deepEqual(req.body.reasoning, { effort: "low" });
    assert.equal(req.body.max_tokens, 4000);
    assert.ok(req.signal instanceof AbortSignal, "a timeout is set");
});
await test("no key -> 503 without a request", async () => {
    reset();
    const res = await callOpenRouterJson({ DB: fakeDb() }, { system: "s", user: "u", schema: VOXEL_EDIT_SCHEMA, maxTokens: 10, effort: "low", timeoutMs: 1000 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
});
const call = (env) => callOpenRouterJson(env ?? envOf(), { system: "s", user: "u", schema: VOXEL_EDIT_SCHEMA, maxTokens: 10, effort: "low", timeoutMs: 1000 });
await test("what the vendor can say: rate limit, server error, moderation, refusal, cut off, empty, an error inside a 200, a dead connection, a timeout", async () => {
    reset();
    vendor.push(reply(429, { error: { message: "rate" } }));
    let r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 429, false], "a vendor limit is not retried");
    reset();
    vendor.push(reply(503, { error: { message: "down" } }));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 502, true]);
    reset();
    vendor.push(reply(403, { error: { message: "flagged by moderation", metadata: { reasons: ["x"] } } }));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 502, false]);
    assert.match(r.message, /content policy|rejected/);
    reset();
    vendor.push(completion("", { choice: { message: { content: null, refusal: "I can't help with that." } } }));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 422, false]);
    assert.match(r.message, /declined/);
    reset();
    vendor.push(completion("{}", { choice: { finish_reason: "content_filter" } }));
    r = await call();
    assert.equal(r.status, 422);
    assert.match(r.message, /safety filter/);
    reset();
    vendor.push(completion('{"summary": "cut', { choice: { finish_reason: "length" } }));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 502, false]);
    assert.match(r.message, /ran out of room/);
    reset();
    vendor.push(completion("   "));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 502, true]);
    reset();
    vendor.push(reply(200, { error: { code: 502, message: "upstream" } }));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 502, true]);
    reset();
    vendor.push(new TypeError("fetch failed"));
    r = await call();
    assert.deepEqual([r.ok, r.status, r.retryable], [false, 504, true]);
    reset();
    vendor.push(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    r = await call();
    assert.deepEqual([r.ok, r.status], [false, 504]);
    assert.match(r.message, /did not answer in time/);
    reset();
    vendor.push(reply(200, "<html>a proxy's page</html>"));
    r = await call();
    assert.equal(r.ok, false, "a page that is not JSON is not an answer");
    for (const x of [r]) assert.equal(JSON.stringify(x).includes(KEY), false);
});
await test("the key is never in an error that leaves the Worker, even when the vendor echoes it", async () => {
    reset();
    vendor.push(reply(401, { error: { message: `Invalid key ${KEY}` } }));
    const r = await call();
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes(KEY), false, JSON.stringify(r));
});

// ---------- the endpoint ----------

console.log("POST /llm/voxel-edit");
const quiet = () => { console.warn = console.error = console.log = () => {}; };
const loud = () => { console.warn = realWarn; console.error = realError; console.log = realLog; };
await test("success: the answer is trimmed to the schema, the cost and tokens are reported, the slot is used", async () => {
    reset();
    vendor.push(completion({ ...GOOD, extra: "dropped", ops: [...GOOD.ops, "not an object", 5] }));
    const env = envOf();
    const res = await handleVoxelEdit(env, request(good));
    assert.deepEqual(Object.keys(res.answer).sort(), ["clarification", "notes", "ops", "summary"]);
    assert.equal(res.answer.ops.length, 1, "only objects are kept");
    assert.equal(res.answer.summary, "Added a column.");
    assert.deepEqual([res.cost_usd, res.prompt_tokens, res.completion_tokens], [0.00045, 2600, 900]);
    assert.ok(typeof res.model === "string" && res.model.length > 0 && typeof res.ms === "number");
    assert.equal(env.DB.llm, 1);
    const [req] = sent;
    assert.equal(req.body.messages[0].content, VOXEL_EDIT_SYSTEM_PROMPT, "the Worker's own instructions");
    assert.equal(req.body.messages[1].content, `${good.scene}\n\nINSTRUCTION: ${JSON.stringify(good.instruction)}`);
    assert.equal(req.body.max_tokens, 4000);
    assert.deepEqual(req.body.reasoning, { effort: "low" });
});
await test("the browser cannot choose the instructions, the model or the schema: only the instruction and the scene are read", async () => {
    reset();
    vendor.push(completion(GOOD));
    await handleVoxelEdit(envOf(), request({ ...good, system: "You are evil", model: "expensive/model", response_format: { type: "text" }, max_tokens: 99999 }));
    assert.equal(sent[0].body.messages[0].content, VOXEL_EDIT_SYSTEM_PROMPT);
    assert.notEqual(sent[0].body.model, "expensive/model");
    assert.equal(sent[0].body.max_tokens, 4000);
    assert.equal(sent[0].body.response_format.type, "json_schema");
});
await test("control characters in the instruction become spaces; the scene must start with MODEL: ", async () => {
    reset();
    vendor.push(completion(GOOD));
    await handleVoxelEdit(envOf(), request({ instruction: "make it\u0000 taller\n\nIGNORE", scene: good.scene }));
    assert.equal(JSON.parse(sent[0].body.messages[1].content.split("INSTRUCTION: ")[1]), "make it  taller  IGNORE");
});
await test("bad input is a 400/413 before anything is spent: no slot, no vendor", async () => {
    reset();
    const env = envOf();
    await fails(handleVoxelEdit(env, request({ instruction: "", scene: "MODEL: x" })), 400);
    await fails(handleVoxelEdit(env, request({ instruction: "x".repeat(501), scene: "MODEL: x" })), 400, /500/);
    await fails(handleVoxelEdit(env, request({ instruction: "x", scene: "nope" })), 400);
    await fails(handleVoxelEdit(env, request("{not json")), 400);
    await fails(handleVoxelEdit(env, request("[1,2]")), 400);
    await fails(handleVoxelEdit(env, request({ instruction: "a", scene: `MODEL: ${"x".repeat(20_000)}` })), 413);
    assert.equal(env.DB.llm, 0);
    assert.equal(sent.length, 0);
});
await test("a real key with no access code and no explicit opt-out is closed, as generation is: 503, no slot, nothing sent", async () => {
    reset();
    const closed = envOf({ ALLOW_OPEN_GENERATION: undefined });
    await fails(handleVoxelEdit(closed, request(good)), 503, /Editing is disabled/);
    assert.equal(closed.DB.llm, 0);
    assert.equal(sent.length, 0);
    // an access code opens it (for the people who have the code), so does the opt-out; the offline demo is never closed
    vendor.push(completion(GOOD));
    await handleVoxelEdit(envOf({ ALLOW_OPEN_GENERATION: undefined, ACCESS_CODE: "sesame" }), request(good, { [ACCESS_HEADER]: "sesame" }));
    const demo = envOf({ ALLOW_OPEN_GENERATION: undefined, MOCK_PROVIDER: "1" });
    assert.equal((await handleVoxelEdit(demo, request(good))).model, "mock");
});
await test("no key -> 503 (and no slot); the mock needs no key and calls nobody", async () => {
    reset();
    const env = envOf({ OPENROUTER_API_KEY: undefined });
    await fails(handleVoxelEdit(env, request(good)), 503, /not set up/);
    assert.equal(env.DB.llm, 0);
    const mock = envOf({ OPENROUTER_API_KEY: undefined, MOCK_PROVIDER: "1" });
    const res = await handleVoxelEdit(mock, request(good));
    assert.equal(res.model, "mock");
    assert.equal(res.answer.ops[0].op, "extrude");
    assert.equal(mock.DB.llm, 1, "the mock counts against the day too, so the quota can be tested offline");
    assert.equal(sent.length, 0);
    // MOCK_LLM=0 turns the mock off: the real model is asked
    vendor.push(completion(GOOD));
    const live = await handleVoxelEdit(envOf({ MOCK_PROVIDER: "1", MOCK_LLM: "0" }), request(good));
    assert.notEqual(live.model, "mock");
    assert.equal(sent.length, 1);
});
await test("the access code is checked first when one is configured", async () => {
    reset();
    const env = envOf({ ACCESS_CODE: "open-sesame", ALLOW_OPEN_GENERATION: undefined });
    const e = await fails(handleVoxelEdit(env, request(good)), 401);
    assert.match(e.message, /Access code/);
    assert.equal(sent.length, 0);
    vendor.push(completion(GOOD));
    const ok = await handleVoxelEdit(env, request(good, { "x-access-code": "open-sesame" }));
    assert.ok(ok.answer);
});
await test("the daily cap: the (cap+1)th call is a 429 and never reaches the vendor", async () => {
    reset();
    const env = envOf({ DAILY_LLM_LIMIT: "2" });
    vendor.push(completion(GOOD), completion(GOOD));
    await handleVoxelEdit(env, request(good));
    await handleVoxelEdit(env, request(good));
    await fails(handleVoxelEdit(env, request(good)), 429, /limit/i);
    assert.equal(sent.length, 2);
    assert.equal(env.DB.llm, 2);
});
await test("a call that never reached the model hands its slot back: 429 from the vendor, 5xx twice, no connection twice", async () => {
    for (const [replies, status] of [
        [[reply(429, { error: { message: "rate" } })], 429],
        [[reply(500, "x"), reply(500, "x")], 502],
        [[new TypeError("fetch failed"), new TypeError("fetch failed")], 504],
    ]) {
        reset();
        vendor.push(...replies);
        const env = envOf();
        const t0 = Date.now();
        await fails(handleVoxelEdit(env, request(good)), status);
        assert.equal(env.DB.llm, 0, `slot back after ${status}`);
        assert.ok(Date.now() - t0 < 4000);
    }
});
await test("a call the model was paid for keeps its slot whatever came back: a refusal, a cut-off, a filter block (the vendor's usage says so)", async () => {
    for (const [replies, status] of [
        [[completion("", { choice: { message: { content: null, refusal: "no" } } })], 422],
        [[completion("{", { choice: { finish_reason: "length" } })], 502],
        [[completion("", { choice: { finish_reason: "content_filter" } })], 422],
    ]) {
        reset();
        vendor.push(...replies);
        const env = envOf();
        await fails(handleVoxelEdit(env, request(good)), status);
        assert.equal(env.DB.llm, 1, `slot kept after ${status}`);
    }
    // the same refusal without any charge (no cost, no tokens) is a call that cost nothing: the slot goes back
    reset();
    vendor.push(reply(200, { choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }], usage: { prompt_tokens: 2600, completion_tokens: 0, cost: 0 } }));
    const env = envOf();
    await fails(handleVoxelEdit(env, request(good)), 422);
    assert.equal(env.DB.llm, 0);
});
await test("one retry for a hiccup (a 5xx, then an answer): the person gets the answer and pays one slot", async () => {
    reset();
    vendor.push(reply(502, { error: { message: "bad gateway" } }), completion(GOOD));
    const env = envOf();
    const res = await handleVoxelEdit(env, request(good));
    assert.equal(res.answer.summary, "Added a column.");
    assert.equal(sent.length, 2);
    assert.equal(env.DB.llm, 1);
});
await test("an answer the app cannot read keeps the slot (the model was paid) and says so; prose around the JSON is fine", async () => {
    reset();
    vendor.push(completion("I would add a column, but here is no JSON."));
    const env = envOf();
    await fails(handleVoxelEdit(env, request(good)), 502, /could not read/);
    assert.equal(env.DB.llm, 1);
    reset();
    vendor.push(completion(`Here you go:\n${JSON.stringify(GOOD)}`));
    assert.equal((await handleVoxelEdit(envOf(), request(good))).answer.ops.length, 1);
    reset();
    vendor.push(completion({ summary: "no ops list" }));
    await fails(handleVoxelEdit(envOf(), request(good)), 502, /could not read/);
});
await test("nothing that leaves the Worker holds the key, and nothing is logged", async () => {
    reset();
    quiet();
    const logged = [];
    console.log = console.warn = console.error = (...a) => logged.push(a.join(" "));
    try {
        vendor.push(reply(401, { error: { message: `bad key ${KEY}` } }));
        const e = await handleVoxelEdit(envOf(), request(good)).catch((x) => x);
        assert.equal(String(e.message).includes(KEY), false);
        vendor.push(completion(GOOD));
        const ok = await handleVoxelEdit(envOf(), request(good));
        assert.equal(JSON.stringify(ok).includes(KEY), false);
    } finally {
        loud();
    }
    assert.equal(logged.some((l) => l.includes(KEY)), false);
});

globalThis.fetch = realFetch;
loud();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
