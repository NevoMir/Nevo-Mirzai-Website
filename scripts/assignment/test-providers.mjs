// Offline tests for the text-to-3D vendor adapters (worker/providers). No network, no keys: globalThis.fetch is
// replaced by a stub that serves responses shaped like the vendors' docs (fal queue API, Tripo v3, Meshy v2).
//
//   node scripts/assignment/test-providers.mjs
//
// Needs Node >= 22.18 (imports the .ts sources directly; on 22.6-22.17 add --experimental-strip-types).

import assert from "node:assert/strict";
import { falHunyuan, falMeshy, falRodin, falTripo } from "../../worker/providers/fal.ts";
import { OFFERED_PROVIDERS, PROVIDER_SPECS, listProviders, resolveProvider } from "../../worker/providers/index.ts";
import { meshyDirect } from "../../worker/providers/meshy.ts";
import { mockAdapter } from "../../worker/providers/mock.ts";
import { openRouterDesigner } from "../../worker/providers/openrouter.ts";
import { tencentHunyuan } from "../../worker/providers/tencent.ts";
import { tripoParts, tripoTextured } from "../../worker/providers/tripo.ts";
import { MAX_TRANSIENT_POLL_ERRORS, ProviderError, guardPoll, preparePrompt } from "../../worker/providers/types.ts";

const KEYS = {
    FAL_KEY: "fal-test-key-0123456789abcdef",
    TRIPO_API_KEY: "tsk_test_0123456789abcdef",
    MESHY_API_KEY: "msy_test_0123456789abcdef",
};
const ENV = { ...KEYS };

// ---------- tiny harness ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const realFetch = globalThis.fetch;
const allCalls = [];
const logged = [];
const realConsoleError = console.error;
console.error = (...args) => logged.push(args.map(String).join(" "));

/** Replaces fetch. `script` is an array of replies consumed in order, or a function (call) => reply. */
function stubFetch(script) {
    const calls = [];
    const queue = Array.isArray(script) ? [...script] : null;
    globalThis.fetch = async (url, init = {}) => {
        const headers = Object.fromEntries(
            Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        const call = {
            url: String(url),
            method: init.method ?? "GET",
            headers,
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            signal: init.signal,
        };
        calls.push(call);
        allCalls.push(call);
        const reply = queue ? queue.shift() : script(call);
        assert.ok(reply, `unexpected extra fetch: ${call.method} ${call.url}`);
        if (reply instanceof Error) throw reply;
        const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
        return new Response(text, { status: reply.status ?? 200, headers: reply.headers ?? {} });
    };
    return {
        calls,
        remaining: () => (queue ? queue.length : 0),
    };
}

const reply = (status, json, headers) => ({ status, json, headers });
const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

function assertNoKeys(text, what = "text") {
    for (const key of Object.values(KEYS)) assert.ok(!String(text).includes(key), `${what} leaks an API key`);
}

/** The ProviderError thrown by `fn`, with sanity checks every error must pass. */
async function thrown(fn) {
    try {
        await fn();
    } catch (err) {
        assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${err}`);
        assertNoKeys(err.message, "error message");
        return err;
    }
    assert.fail("expected a ProviderError, nothing was thrown");
}

function assertFailed(result, pattern) {
    assert.equal(result.status, "failed", `expected failed, got ${JSON.stringify(result)}`);
    assert.match(result.error, pattern);
    assertNoKeys(result.error, "failure text");
}

// ---------- fixtures: fal ----------

const REQ = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const falUrls = (app) => ({
    request_id: REQ,
    response_url: `https://queue.fal.run/${app}/requests/${REQ}`,
    status_url: `https://queue.fal.run/${app}/requests/${REQ}/status`,
    cancel_url: `https://queue.fal.run/${app}/requests/${REQ}/cancel`,
    queue_position: 0,
});
const file = (url, extra = {}) => ({ url, content_type: "application/octet-stream", file_size: 1024, ...extra });
const glb = (name) => file(`https://v3b.fal.media/files/b/test/${name}.glb`, { content_type: "model/gltf-binary", file_name: `${name}.glb` });
const png = (name) => file(`https://v3b.fal.media/files/b/test/${name}.png`, { content_type: "image/png", file_name: `${name}.png` });

const FAL_CASES = [
    {
        name: "falMeshy",
        adapter: falMeshy,
        endpoint: "meshy/v7.1/text-to-3d",
        app: "meshy/v7.1",
        input: {
            mode: "full",
            enable_pbr: true,
            model_type: "standard",
            topology: "triangle",
            should_remesh: true,
            target_polycount: 30000,
        },
        promptLimit: 600,
        output: {
            model_glb: glb("meshy_model"),
            model_urls: { glb: glb("meshy_model"), usdz: file("https://v3b.fal.media/files/b/test/m.usdz") },
            thumbnail: png("meshy_preview"),
            texture_urls: [{ base_color: png("texture_0") }],
            prompt: "a chair",
            seed: 4002110719,
            some_future_field: { nested: true },
        },
        glbUrl: "https://v3b.fal.media/files/b/test/meshy_model.glb",
        thumbnailUrl: "https://v3b.fal.media/files/b/test/meshy_preview.png",
        noGlbOutput: { model_urls: { fbx: file("https://v3b.fal.media/files/b/test/m.fbx") }, prompt: "x" },
    },
    {
        name: "falRodin",
        adapter: falRodin,
        endpoint: "fal-ai/hyper3d/rodin/v2.5/text-to-3d",
        app: "fal-ai/hyper3d",
        input: {
            tier: "Gen-2.5-Medium",
            quality_mesh_option: "150K Triangle",
            material: "PBR",
            geometry_file_format: "glb",
        },
        promptLimit: 1024,
        output: {
            model_mesh: glb("base_basic_pbr"),
            model_meshes: [glb("base_basic_shaded")],
            textures: [
                file("https://v3b.fal.media/files/b/test/preview.webp", { content_type: "image/webp", file_name: "preview.webp" }),
            ],
            seed: 1234,
        },
        glbUrl: "https://v3b.fal.media/files/b/test/base_basic_pbr.glb",
        thumbnailUrl: "https://v3b.fal.media/files/b/test/preview.webp",
        noGlbOutput: { model_mesh: file("https://v3b.fal.media/files/b/test/model.fbx", { file_name: "model.fbx" }), textures: [], seed: 1 },
    },
    {
        name: "falHunyuan",
        adapter: falHunyuan,
        endpoint: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
        app: "fal-ai/hunyuan-3d",
        input: { generate_type: "Normal", enable_pbr: false },
        promptLimit: 1024,
        output: {
            thumbnail: png("hy_preview"),
            seed: 7,
            model_glb: glb("hy_model"),
            model_urls: { glb: glb("hy_model"), texture: png("hy_tex"), obj: file("https://v3b.fal.media/files/b/test/hy.obj") },
        },
        glbUrl: "https://v3b.fal.media/files/b/test/hy_model.glb",
        thumbnailUrl: "https://v3b.fal.media/files/b/test/hy_preview.png",
        noGlbOutput: { model_urls: { obj: file("https://v3b.fal.media/files/b/test/hy.obj") } },
    },
    {
        name: "falTripo",
        adapter: falTripo,
        endpoint: "tripo3d/h3.1/text-to-3d",
        app: "tripo3d/h3.1",
        input: { texture: true, pbr: true, texture_quality: "standard", geometry_quality: "standard" },
        promptLimit: 1024,
        output: {
            task_id: "task_fal_1",
            model_mesh: glb("tripo_model"),
            model_urls: { glb: glb("tripo_model"), pbr_model: glb("tripo_pbr"), base_model: glb("tripo_base") },
            rendered_image: png("tripo_render"),
        },
        glbUrl: "https://v3b.fal.media/files/b/test/tripo_pbr.glb",
        thumbnailUrl: "https://v3b.fal.media/files/b/test/tripo_render.png",
        noGlbOutput: { model_mesh: file("https://v3b.fal.media/files/b/test/q.fbx", { file_name: "q.fbx" }), model_urls: {} },
    },
];

// ---------- fal tests ----------

for (const c of FAL_CASES) {
    const submitState = () => {
        const urls = falUrls(c.app);
        return { request_id: urls.request_id, status_url: urls.status_url, response_url: urls.response_url, cancel_url: urls.cancel_url };
    };

    test(`${c.name}: submit posts the model input to the queue with the Key auth header`, async () => {
        const f = stubFetch([reply(200, falUrls(c.app))]);
        const result = await c.adapter.submit(ENV, "  a small wooden chair  ");
        assert.equal(f.calls.length, 1);
        const [call] = f.calls;
        assert.equal(call.url, `https://queue.fal.run/${c.endpoint}`);
        assert.equal(call.method, "POST");
        assert.equal(call.headers.authorization, `Key ${KEYS.FAL_KEY}`);
        assert.equal(call.headers["content-type"], "application/json");
        assert.deepEqual(call.body, { prompt: "a small wooden chair", ...c.input });
        assert.equal(c.adapter.via, "fal");
        assert.equal(result.taskId, REQ);
        assert.deepEqual(result.state, submitState());
    });

    test(`${c.name}: poll IN_QUEUE is queued with the queue position`, async () => {
        const f = stubFetch([reply(200, { status: "IN_QUEUE", request_id: REQ, queue_position: 3, response_url: falUrls(c.app).response_url })]);
        const r = await c.adapter.poll(ENV, REQ, submitState());
        assert.equal(r.status, "queued");
        assert.equal(r.stage, "In queue (position 3)");
        // it polls the URL fal returned, not one derived from the endpoint id
        assert.equal(f.calls[0].url, falUrls(c.app).status_url);
        assert.equal(f.calls[0].method, "GET");
        assert.equal(f.calls[0].headers.authorization, `Key ${KEYS.FAL_KEY}`);
    });

    test(`${c.name}: poll IN_PROGRESS is running`, async () => {
        stubFetch([reply(200, { status: "IN_PROGRESS", request_id: REQ, logs: [{ message: "x", timestamp: "t" }] })]);
        const r = await c.adapter.poll(ENV, REQ, submitState());
        assert.equal(r.status, "running");
        assert.equal(typeof r.stage, "string");
    });

    test(`${c.name}: poll COMPLETED fetches the result and extracts the GLB and thumbnail`, async () => {
        const f = stubFetch([
            reply(200, { status: "COMPLETED", request_id: REQ, metrics: { inference_time: 41.2 }, logs: [] }),
            reply(200, c.output),
        ]);
        const r = await c.adapter.poll(ENV, REQ, submitState());
        assert.equal(r.status, "succeeded");
        assert.equal(r.glbUrl, c.glbUrl);
        assert.equal(r.thumbnailUrl, c.thumbnailUrl);
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].url, falUrls(c.app).response_url);
        assert.equal(f.calls[1].method, "GET");
    });

    test(`${c.name}: a COMPLETED result without a GLB is a clear failure`, async () => {
        stubFetch([reply(200, { status: "COMPLETED", request_id: REQ }), reply(200, c.noGlbOutput)]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /no GLB/);
    });

    test(`${c.name}: COMPLETED with error / error_type fails with a readable message`, async () => {
        stubFetch([reply(200, { status: "COMPLETED", request_id: REQ, error: "CUDA out of memory", error_type: "runner_server_error" })]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /fal\.ai could not generate this model: CUDA out of memory/);
        stubFetch([reply(200, { status: "COMPLETED", request_id: REQ, error: "flagged", error_type: "content_policy_violation" })]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /content policy/);
        stubFetch([reply(200, { status: "COMPLETED", request_id: REQ, error: "late", error_type: "request_timeout" })]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /timed out/);
    });

    test(`${c.name}: a 422 content-policy reply from the result endpoint fails the job`, async () => {
        stubFetch([
            reply(200, { status: "COMPLETED", request_id: REQ }),
            reply(422, { detail: [{ loc: ["body", "prompt"], msg: "The prompt was flagged", type: "content_policy_violation", url: "https://docs.fal.ai/errors" }] }),
        ]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /rejected the prompt \(content policy\)/);
    });

    test(`${c.name}: submit error mapping (401, 402, 403, 429, 500)`, async () => {
        stubFetch([reply(401, { detail: "Invalid key" })]);
        assert.equal((await thrown(() => c.adapter.submit(ENV, "x"))).message, "The fal.ai API key was rejected (401)");
        stubFetch([reply(402, { detail: "Payment required" })]);
        assert.equal(
            (await thrown(() => c.adapter.submit(ENV, "x"))).message,
            "Out of credits on fal.ai — top up at fal.ai/dashboard/billing",
        );
        stubFetch([reply(403, { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." })]);
        assert.equal(
            (await thrown(() => c.adapter.submit(ENV, "x"))).message,
            "Out of credits on fal.ai — top up at fal.ai/dashboard/billing",
        );
        stubFetch([reply(403, { detail: "Forbidden" })]);
        assert.match((await thrown(() => c.adapter.submit(ENV, "x"))).message, /^Out of credits on fal\.ai, or the key lacks access \(403\)/);
        stubFetch([reply(429, { detail: "Too many requests" }, { "retry-after": "2" })]);
        const rate = await thrown(() => c.adapter.submit(ENV, "x"));
        assert.match(rate.message, /^Rate limited by fal\.ai/);
        assert.equal(rate.status, 429);
        stubFetch([reply(500, { detail: "boom" })]);
        assert.match((await thrown(() => c.adapter.submit(ENV, "x"))).message, /^fal\.ai had a server error \(500\)/);
        stubFetch([reply(422, { detail: [{ loc: ["body", "prompt"], msg: "String should have at most 600 characters", type: "string_too_long" }] })]);
        assert.match((await thrown(() => c.adapter.submit(ENV, "x"))).message, /^fal\.ai rejected the request \(422\): String should have at most 600/);
    });

    test(`${c.name}: submit never echoes the API key, even if the vendor does`, async () => {
        stubFetch([reply(400, { detail: `Bad key ${KEYS.FAL_KEY}` })]);
        const err = await thrown(() => c.adapter.submit(ENV, "x"));
        assert.match(err.message, /\*\*\*/);
    });

    test(`${c.name}: poll 429 and 5xx keep the job running and count the retries`, async () => {
        stubFetch([reply(429, { detail: "slow down" })]);
        const r = await c.adapter.poll(ENV, REQ, submitState());
        assert.equal(r.status, "running");
        assert.equal(r.stage, "Rate limited by fal.ai, retrying…");
        assert.equal(r.state.transient_errors, 1);
        assert.equal(r.state.status_url, falUrls(c.app).status_url); // the handle survives
        stubFetch([reply(503, { detail: "unavailable" })]);
        const r2 = await c.adapter.poll(ENV, REQ, r.state);
        assert.equal(r2.status, "running");
        assert.equal(r2.state.transient_errors, 2);
        // the next clean poll resets the counter
        stubFetch([reply(200, { status: "IN_PROGRESS", request_id: REQ })]);
        const r3 = await c.adapter.poll(ENV, REQ, r2.state);
        assert.equal(r3.status, "running");
        assert.equal(r3.state.transient_errors, undefined);
        assert.equal(r3.state.request_id, REQ);
    });

    test(`${c.name}: poll timeouts are retried, a dead vendor eventually fails the job`, async () => {
        let state = submitState();
        for (let i = 1; i <= MAX_TRANSIENT_POLL_ERRORS; i++) {
            stubFetch([timeoutError()]);
            const r = await c.adapter.poll(ENV, REQ, state);
            assert.equal(r.status, "running", `attempt ${i}`);
            assert.equal(r.stage, "fal.ai did not answer in time");
            state = r.state;
        }
        stubFetch([timeoutError()]);
        assertFailed(await c.adapter.poll(ENV, REQ, state), /Gave up after \d+ failed attempts: fal\.ai did not answer in time/);
    });

    test(`${c.name}: poll 401 / 404 fail the job`, async () => {
        stubFetch([reply(401, { detail: "nope" })]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /^The fal\.ai API key was rejected \(401\)$/);
        stubFetch([reply(404, { detail: "Request not found" })]);
        assertFailed(await c.adapter.poll(ENV, REQ, submitState()), /^fal\.ai rejected the request \(404\): Request not found$/);
    });

    test(`${c.name}: cancel PUTs the cancel_url and never throws`, async () => {
        const f = stubFetch([reply(202, { status: "CANCELLATION_REQUESTED" })]);
        await c.adapter.cancel(ENV, REQ, submitState());
        assert.equal(f.calls[0].method, "PUT");
        assert.equal(f.calls[0].url, falUrls(c.app).cancel_url);
        assert.equal(f.calls[0].headers.authorization, `Key ${KEYS.FAL_KEY}`);
        stubFetch([reply(400, { status: "ALREADY_COMPLETED" })]);
        await c.adapter.cancel(ENV, REQ, submitState());
        stubFetch([timeoutError()]);
        await c.adapter.cancel(ENV, REQ, submitState());
        await c.adapter.cancel({}, REQ, submitState()); // no key at all
    });

    test(`${c.name}: a missing key is a clear error that names the variable, not the value`, async () => {
        stubFetch([]);
        const err = await thrown(() => c.adapter.submit({}, "x"));
        assert.equal(err.message, "FAL_KEY is not configured");
        const blank = await thrown(() => c.adapter.submit({ FAL_KEY: "  \n" }, "x"));
        assert.equal(blank.message, "FAL_KEY is not configured");
    });

    test(`${c.name}: a key with a trailing newline is trimmed`, async () => {
        const f = stubFetch([reply(200, falUrls(c.app))]);
        await c.adapter.submit({ FAL_KEY: `${KEYS.FAL_KEY}\n` }, "x");
        assert.equal(f.calls[0].headers.authorization, `Key ${KEYS.FAL_KEY}`);
    });

    test(`${c.name}: stored URLs outside queue.fal.run are never sent the key`, async () => {
        const f = stubFetch([reply(200, { status: "IN_PROGRESS", request_id: REQ })]);
        const evil = { ...submitState(), status_url: "https://evil.example/steal" };
        await c.adapter.poll(ENV, REQ, evil);
        assert.ok(f.calls[0].url.startsWith("https://queue.fal.run/"));
    });

    test(`${c.name}: a long prompt is cut to ${c.promptLimit} characters and the stage says so`, async () => {
        const long = `${"chair ".repeat(300)}end`;
        const f = stubFetch([reply(200, falUrls(c.app))]);
        const sub = await c.adapter.submit(ENV, long);
        assert.ok(f.calls[0].body.prompt.length <= c.promptLimit);
        assert.ok(f.calls[0].body.prompt.length > c.promptLimit * 0.9);
        assert.equal(sub.state.prompt_trimmed_to, c.promptLimit);
        stubFetch([reply(200, { status: "IN_PROGRESS", request_id: REQ })]);
        const r = await c.adapter.poll(ENV, REQ, sub.state);
        assert.match(r.stage, new RegExp(`prompt shortened to ${c.promptLimit} characters`));
    });
}

test("fal: an empty prompt is rejected before any request", async () => {
    const f = stubFetch([]);
    const err = await thrown(() => falTripo.submit(ENV, "   "));
    assert.equal(err.message, "The prompt is empty.");
    assert.equal(f.calls.length, 0);
});

test("fal: a submit reply without request_id is an error", async () => {
    stubFetch([reply(200, { something: "else" })]);
    assert.match((await thrown(() => falTripo.submit(ENV, "x"))).message, /no request id/);
});

test("fal: unknown status values count as running", async () => {
    stubFetch([reply(200, { status: "SOMETHING_NEW" })]);
    assert.equal((await falTripo.poll(ENV, REQ, null)).status, "running");
});

test("fal: queue position 0 shows plain 'In queue'", async () => {
    stubFetch([reply(200, { status: "IN_QUEUE", queue_position: 0 })]);
    assert.equal((await falTripo.poll(ENV, REQ, null)).stage, "In queue");
});

test("falTripo: falls back to model_mesh when model_urls has no named GLB", async () => {
    stubFetch([
        reply(200, { status: "COMPLETED" }),
        reply(200, { model_mesh: glb("only"), model_urls: { fbx: file("https://v3b.fal.media/files/b/test/x.fbx") } }),
    ]);
    const r = await falTripo.poll(ENV, REQ, null);
    assert.equal(r.glbUrl, "https://v3b.fal.media/files/b/test/only.glb");
    assert.equal(r.thumbnailUrl, null);
});

test("falRodin: picks the GLB from model_meshes when model_mesh is another format", async () => {
    stubFetch([
        reply(200, { status: "COMPLETED" }),
        reply(200, { model_mesh: file("https://v3b.fal.media/files/b/test/a.fbx", { file_name: "a.fbx" }), model_meshes: [glb("extra")], textures: [], seed: 1 }),
    ]);
    const r = await falRodin.poll(ENV, REQ, null);
    assert.equal(r.glbUrl, "https://v3b.fal.media/files/b/test/extra.glb");
    assert.equal(r.thumbnailUrl, null); // a texture map is not a thumbnail
});

// ---------- fixtures: Tripo ----------

const TRIPO_BASE = "https://openapi.tripo3d.com/v3";
const taskReply = (data) => reply(200, { code: 0, data: { task_id: "task_abc123", type: "text_to_model", created_at: "2026-10-23T12:00:00Z", ...data } });
const tripoErr = (status, code, message, suggestion) => reply(status, { code, status: "error", message, suggestion, request_id: "req_abc123" });

for (const [name, adapter, body] of [
    ["tripoParts", tripoParts, { model: "v3.1-20260211", texture: false, pbr: false, generate_parts: true }],
    ["tripoTextured", tripoTextured, { model: "v3.1-20260211", texture: true, pbr: true, texture_quality: "standard" }],
]) {
    const parts = name === "tripoParts";

    test(`${name}: submit posts to /v3/generation/text-to-model with Bearer auth`, async () => {
        const f = stubFetch([reply(200, { code: 0, data: { task_id: "task_abc123" } })]);
        const r = await adapter.submit(ENV, "  a desk lamp with a hinged arm ");
        const [call] = f.calls;
        assert.equal(call.url, `${TRIPO_BASE}/generation/text-to-model`);
        assert.equal(call.method, "POST");
        assert.equal(call.headers.authorization, `Bearer ${KEYS.TRIPO_API_KEY}`);
        assert.equal(call.headers["content-type"], "application/json");
        assert.deepEqual(call.body, { prompt: "a desk lamp with a hinged arm", ...body });
        assert.equal(adapter.via, "tripo");
        assert.equal(r.taskId, "task_abc123");
        assert.equal(r.state ?? null, null);
    });

    test(`${name}: poll maps queued / running with the reported progress`, async () => {
        const f = stubFetch([taskReply({ status: "queued", progress: 0 }), taskReply({ status: "running", progress: 42 })]);
        const q = await adapter.poll(ENV, "task_abc123", null);
        assert.deepEqual(q, { status: "queued", progress: 0, stage: "In queue" });
        const run = await adapter.poll(ENV, "task_abc123", null);
        assert.equal(run.status, "running");
        assert.equal(run.progress, 42);
        assert.equal(run.stage, parts ? "Generating parts" : "Generating textured model");
        assert.equal(f.calls[0].url, `${TRIPO_BASE}/tasks/task_abc123`);
        assert.equal(f.calls[0].method, "GET");
        assert.equal(f.calls[0].headers.authorization, `Bearer ${KEYS.TRIPO_API_KEY}`);
    });

    test(`${name}: poll success takes output.model_url and rendered_image_url`, async () => {
        stubFetch([
            taskReply({
                status: "success",
                progress: 100,
                output: { model_url: "https://cdn.tripo3d.ai/output/model_pbr.glb?sig=abc", rendered_image_url: "https://cdn.tripo3d.ai/output/preview.png", future: 1 },
                credits_consumed: 30.0,
                completed_at: "2026-10-23T12:01:30Z",
            }),
        ]);
        const r = await adapter.poll(ENV, "task_abc123", null);
        assert.deepEqual(r, {
            status: "succeeded",
            glbUrl: "https://cdn.tripo3d.ai/output/model_pbr.glb?sig=abc",
            thumbnailUrl: "https://cdn.tripo3d.ai/output/preview.png",
        });
    });

    test(`${name}: success without a usable GLB fails clearly`, async () => {
        stubFetch([taskReply({ status: "success", progress: 100, output: { rendered_image_url: "https://cdn.tripo3d.ai/p.png" } })]);
        assertFailed(await adapter.poll(ENV, "t", null), /no GLB/);
        stubFetch([taskReply({ status: "success", progress: 100, output: { model_url: "https://cdn.tripo3d.ai/output/model.fbx" } })]);
        assertFailed(await adapter.poll(ENV, "t", null), /no GLB/);
    });

    test(`${name}: failed / banned / expired / cancelled statuses`, async () => {
        stubFetch([taskReply({ status: "failed", error_code: 2018, error_message: "Model too complex" })]);
        assertFailed(await adapter.poll(ENV, "t", null), /^Tripo could not generate this model: Model too complex$/);
        stubFetch([taskReply({ status: "failed" })]);
        assertFailed(await adapter.poll(ENV, "t", null), /^Tripo could not generate this model\.$/);
        stubFetch([taskReply({ status: "banned" })]);
        assertFailed(await adapter.poll(ENV, "t", null), /content policy/);
        stubFetch([taskReply({ status: "expired" })]);
        assertFailed(await adapter.poll(ENV, "t", null), /expired/);
        stubFetch([taskReply({ status: "cancelled" })]);
        assert.deepEqual(await adapter.poll(ENV, "t", null), { status: "canceled" });
    });

    test(`${name}: submit error mapping (401, 403 credits, 403, 429, 500, envelope error)`, async () => {
        stubFetch([tripoErr(401, 1000, "Invalid API key", "Check the key")]);
        assert.equal((await thrown(() => adapter.submit(ENV, "x"))).message, "The Tripo API key was rejected (401)");
        stubFetch([tripoErr(403, 2010, "You don't have enough credit to create this task", "Please purchase more credit")]);
        assert.equal(
            (await thrown(() => adapter.submit(ENV, "x"))).message,
            "Out of credits on Tripo — top up at platform.tripo3d.ai",
        );
        stubFetch([reply(402, { code: 2010, message: "credit" })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /^Out of credits on Tripo/);
        stubFetch([reply(403, { message: "Forbidden" })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /^Out of credits on Tripo, or the key lacks access \(403\)/);
        stubFetch([tripoErr(429, 1007, "Rate limit exceeded", "Wait")]);
        const rate = await thrown(() => adapter.submit(ENV, "x"));
        assert.match(rate.message, /^Rate limited by Tripo/);
        assert.equal(rate.status, 429);
        stubFetch([reply(429, { code: 2000, message: "You have exceeded the limit of generation" }, { "retry-after": "5" })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /maximum number of tasks/);
        stubFetch([reply(500, { code: 5000, message: "internal" })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /^Tripo had a server error \(500\)/);
        stubFetch([tripoErr(400, 1004, "Parameter combination not allowed", "Set texture=false")]);
        assert.match(
            (await thrown(() => adapter.submit(ENV, "x"))).message,
            /^Tripo rejected the request \(400\): Parameter combination not allowed \(Set texture=false\)$/,
        );
        stubFetch([tripoErr(400, 2008, "Content policy violation", "Change the prompt")]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /content policy/);
        // HTTP 200 whose envelope carries an error code
        stubFetch([reply(200, { code: 2010, message: "no credit" })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /^Out of credits on Tripo/);
        // HTTP 200 without a task id
        stubFetch([reply(200, { code: 0, data: {} })]);
        assert.match((await thrown(() => adapter.submit(ENV, "x"))).message, /no task id/);
    });

    test(`${name}: poll 429 keeps running ("Rate limited by Tripo, retrying…"), 401 fails`, async () => {
        stubFetch([tripoErr(429, 1007, "Rate limit exceeded")]);
        const r = await adapter.poll(ENV, "t", null);
        assert.equal(r.status, "running");
        assert.equal(r.stage, "Rate limited by Tripo, retrying…");
        assert.equal(r.state.transient_errors, 1);
        stubFetch([reply(429, { code: 2000, message: "limit" }, { "retry-after": "3" })]);
        assert.equal((await adapter.poll(ENV, "t", r.state)).state.transient_errors, 2);
        stubFetch([reply(500, { message: "oops" })]);
        const e = await adapter.poll(ENV, "t", null);
        assert.equal(e.status, "running");
        assert.equal(e.stage, "Tripo is having trouble (500), retrying…");
        stubFetch([taskReply({ status: "running", progress: 10 })]);
        const ok = await adapter.poll(ENV, "t", r.state);
        assert.equal(ok.status, "running");
        assert.equal(ok.state.transient_errors, undefined);
        stubFetch([tripoErr(401, 1000, "Invalid API key")]);
        assertFailed(await adapter.poll(ENV, "t", null), /^The Tripo API key was rejected \(401\)$/);
        stubFetch([tripoErr(404, 3001, "Task not found")]);
        assertFailed(await adapter.poll(ENV, "t", null), /^Tripo rejected the request \(404\): Task not found$/);
    });

    test(`${name}: has no cancel() (v3 has no cancel endpoint)`, () => {
        assert.equal(adapter.cancel, undefined);
    });
}

test("tripo: a prompt over 1024 characters is cut and noted in the stage", async () => {
    const f = stubFetch([reply(200, { code: 0, data: { task_id: "task_long" } }), taskReply({ status: "running", progress: 5 })]);
    const sub = await tripoParts.submit(ENV, `${"gear ".repeat(400)}end`);
    assert.ok(f.calls[0].body.prompt.length <= 1024 && f.calls[0].body.prompt.length > 900);
    assert.deepEqual(sub.state, { prompt_trimmed_to: 1024 });
    const r = await tripoParts.poll(ENV, sub.taskId, sub.state);
    assert.match(r.stage, /prompt shortened to 1024 characters/);
});

test("tripo: progress is clamped while running", async () => {
    stubFetch([taskReply({ status: "running", progress: 100 })]);
    assert.equal((await tripoTextured.poll(ENV, "t", null)).progress, 99);
});

test("tripo: the key is only ever sent to openapi.tripo3d.com", async () => {
    const f = stubFetch([taskReply({ status: "running", progress: 1 })]);
    await tripoParts.poll(ENV, "../../evil", null);
    assert.ok(f.calls[0].url.startsWith("https://openapi.tripo3d.com/v3/tasks/"));
    assert.ok(!f.calls[0].url.includes("../"));
});

// ---------- fixtures: Meshy ----------

const MESHY_ENDPOINT = "https://api.meshy.ai/openapi/v2/text-to-3d";
const mtask = (extra) => ({
    id: "018a210d-8ba4-705c-b111-1f1776f7f578",
    type: "text-to-3d-preview",
    prompt: "a monster mask",
    progress: 0,
    created_at: 1692771650657,
    started_at: 0,
    finished_at: 0,
    preceding_tasks: 0,
    task_error: { message: "" },
    ...extra,
});
const PREVIEW_ID = "018a210d-8ba4-705c-b111-1f1776f7f578";
const REFINE_ID = "018a210e-0000-7000-8000-000000000001";
const MESHY_GLB = "https://assets.meshy.ai/abc/tasks/x/output/model.glb?Expires=1793491200&Signature=sig";
const MESHY_THUMB = "https://assets.meshy.ai/abc/tasks/x/output/preview.png?Expires=1793491200&Signature=sig";

test("meshyDirect: submit posts the preview task", async () => {
    const f = stubFetch([reply(202, { result: PREVIEW_ID })]);
    const r = await meshyDirect.submit(ENV, " a monster mask ");
    const [call] = f.calls;
    assert.equal(call.url, MESHY_ENDPOINT);
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, `Bearer ${KEYS.MESHY_API_KEY}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, {
        mode: "preview",
        prompt: "a monster mask",
        ai_model: "meshy-7.1",
        should_remesh: true,
        topology: "triangle",
        target_polycount: 30000,
        target_formats: ["glb"],
    });
    assert.equal(meshyDirect.via, "meshy");
    assert.equal(r.taskId, PREVIEW_ID);
    assert.deepEqual(r.state, { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null });
});

test("meshyDirect: preview PENDING is queued, IN_PROGRESS maps 0-100 to 0-50", async () => {
    const state = { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null };
    const f = stubFetch([
        reply(200, mtask({ status: "PENDING", preceding_tasks: 4 })),
        reply(200, mtask({ status: "IN_PROGRESS", progress: 40, started_at: 1692771667037 })),
    ]);
    const q = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.deepEqual(q, { status: "queued", progress: 0, stage: "In queue (4 ahead)" });
    const run = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.deepEqual(run, { status: "running", progress: 20, stage: "Generating mesh" });
    assert.equal(f.calls[0].url, `${MESHY_ENDPOINT}/${PREVIEW_ID}`);
    assert.equal(f.calls[0].method, "GET");
    assert.equal(f.calls[0].headers.authorization, `Bearer ${KEYS.MESHY_API_KEY}`);
});

test("meshyDirect: preview SUCCEEDED submits the refine task and hands off through state", async () => {
    const state = { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null };
    const f = stubFetch([
        reply(200, mtask({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://assets.meshy.ai/p.glb" } })),
        reply(202, { result: REFINE_ID }),
    ]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.equal(r.status, "running");
    assert.equal(r.progress, 50);
    assert.equal(r.stage, "Texturing");
    assert.deepEqual(r.state, { phase: "refine", preview_task_id: PREVIEW_ID, refine_task_id: REFINE_ID });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url, MESHY_ENDPOINT);
    assert.equal(f.calls[1].method, "POST");
    assert.deepEqual(f.calls[1].body, { mode: "refine", preview_task_id: PREVIEW_ID, enable_pbr: true, target_formats: ["glb"] });
    assert.equal(f.calls[1].headers.authorization, `Bearer ${KEYS.MESHY_API_KEY}`);
});

test("meshyDirect: the refine phase polls the refine task, maps 0-100 to 50-100 and returns the textured GLB", async () => {
    const state = { phase: "refine", preview_task_id: PREVIEW_ID, refine_task_id: REFINE_ID };
    const f = stubFetch([
        reply(200, mtask({ id: REFINE_ID, type: "text-to-3d-refine", status: "PENDING" })),
        reply(200, mtask({ id: REFINE_ID, type: "text-to-3d-refine", status: "IN_PROGRESS", progress: 50 })),
        reply(
            200,
            mtask({
                id: REFINE_ID,
                type: "text-to-3d-refine",
                status: "SUCCEEDED",
                progress: 100,
                model_urls: { glb: MESHY_GLB, fbx: "https://assets.meshy.ai/m.fbx" },
                thumbnail_url: MESHY_THUMB,
                texture_urls: [{ base_color: "https://assets.meshy.ai/t.png" }],
                consumed_credits: 10,
            }),
        ),
    ]);
    const pending = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.deepEqual(pending, { status: "running", progress: 50, stage: "Texturing" }); // not flipped back to queued
    const mid = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.deepEqual(mid, { status: "running", progress: 75, stage: "Texturing" });
    const done = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.deepEqual(done, { status: "succeeded", glbUrl: MESHY_GLB, thumbnailUrl: MESHY_THUMB });
    assert.ok(f.calls.every((c) => c.url === `${MESHY_ENDPOINT}/${REFINE_ID}`));
});

test("meshyDirect: refine SUCCEEDED without a GLB, FAILED and CANCELED", async () => {
    const state = { phase: "refine", preview_task_id: PREVIEW_ID, refine_task_id: REFINE_ID };
    stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100, model_urls: { fbx: "https://assets.meshy.ai/m.fbx" } }))]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, state), /no GLB/);
    stubFetch([reply(200, mtask({ status: "FAILED", task_error: { type: "invalid_input", code: "image_too_complex", message: "The prompt is too complex." } }))]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, { ...state, phase: "preview" }), /^Meshy could not generate this model: The prompt is too complex\.$/);
    stubFetch([reply(200, mtask({ status: "FAILED", task_error: { message: "" } }))]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, state), /^Meshy could not generate this model\.$/);
    stubFetch([reply(200, mtask({ status: "CANCELED" }))]);
    assert.deepEqual(await meshyDirect.poll(ENV, PREVIEW_ID, state), { status: "canceled" });
});

test("meshyDirect: a failure to start texturing is reported with context; transient ones retry the hand-off", async () => {
    const state = { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null };
    stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100 })), reply(402, { message: "Insufficient credits" })]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, state), /^The mesh is ready, but Meshy could not start texturing\. Out of credits on Meshy — top up at meshy\.ai\/settings\/subscription$/);
    stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100 })), reply(500, { message: "oops" })]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.equal(r.status, "running");
    assert.equal(r.state.phase, "preview"); // still preview, so the next poll tries the refine again
    assert.equal(r.state.transient_errors, 1);
    const f = stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100 })), reply(202, { result: REFINE_ID })]);
    const again = await meshyDirect.poll(ENV, PREVIEW_ID, r.state);
    assert.equal(again.state.phase, "refine");
    assert.equal(again.state.refine_task_id, REFINE_ID);
    assert.equal(again.state.transient_errors, undefined);
    assert.equal(f.calls.length, 2);
});

const PREVIEW_GLB = "https://assets.meshy.ai/abc/tasks/x/output/preview.glb?Expires=1793491200&Signature=sig";
const previewDone = (extra = {}) =>
    mtask({ status: "SUCCEEDED", progress: 100, model_urls: { glb: PREVIEW_GLB }, thumbnail_url: MESHY_THUMB, ...extra });
const PREVIEW_STATE = { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null };

test("meshyDirect: when texturing cannot start, the paid untextured mesh is kept instead of failing the job", async () => {
    const refineReplies = [
        reply(402, { message: "Insufficient credits" }),
        reply(403, { message: "meshy-7.1 is not available for your plan" }),
        reply(400, { message: "preview task not found" }),
        reply(202, {}), // accepted, but no task id
        timeoutError(), // ambiguous: the refine task may exist, so no blind retry
        new TypeError("fetch failed"),
    ];
    for (const refine of refineReplies) {
        const f = stubFetch([reply(200, previewDone()), refine]);
        const r = await meshyDirect.poll(ENV, PREVIEW_ID, PREVIEW_STATE);
        assert.deepEqual(r, { status: "succeeded", glbUrl: PREVIEW_GLB, thumbnailUrl: MESHY_THUMB });
        assert.equal(f.calls.length, 2); // one preview GET, one refine POST: never repeated
        assert.match(logged.at(-1), /^meshy: texturing did not start, keeping the untextured mesh: /);
    }
});

test("meshyDirect: a rate limit or 5xx on the refine POST still retries the hand-off, with the mesh at hand", async () => {
    for (const refine of [reply(500, { message: "oops" }), reply(429, { message: "slow down" }), reply(429, { message: "NoMorePendingTasks" })]) {
        stubFetch([reply(200, previewDone()), refine]);
        const r = await meshyDirect.poll(ENV, PREVIEW_ID, PREVIEW_STATE);
        assert.equal(r.status, "running");
        assert.equal(r.state.phase, "preview");
        assert.equal(r.state.transient_errors, 1);
    }
});

test("meshyDirect: a refine POST that timed out without a mesh fails clearly, once, and says it may have started", async () => {
    const f = stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100 })), timeoutError()]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, PREVIEW_STATE);
    assertFailed(r, /^The mesh is ready, but Meshy could not start texturing\. Meshy did not confirm the texturing request, so it may have started\. Check your Meshy dashboard/);
    assert.equal(f.calls.length, 2);
});

test("meshyDirect: submit error mapping (401, 402, 402 free plan, 403, 429 x2, 500, 400)", async () => {
    stubFetch([reply(401, { message: "Unauthorized" })]);
    assert.equal((await thrown(() => meshyDirect.submit(ENV, "x"))).message, "The Meshy API key was rejected (401)");
    stubFetch([reply(402, { message: "Insufficient credits" })]);
    assert.equal(
        (await thrown(() => meshyDirect.submit(ENV, "x"))).message,
        "Out of credits on Meshy — top up at meshy.ai/settings/subscription",
    );
    stubFetch([reply(402, { message: "Creating a task requires a paid plan" })]);
    assert.match((await thrown(() => meshyDirect.submit(ENV, "x"))).message, /^Meshy API access needs a paid plan/);
    stubFetch([reply(403, { message: "ip_not_authorized" })]);
    assert.match((await thrown(() => meshyDirect.submit(ENV, "x"))).message, /^Out of credits on Meshy, or the key lacks access \(403\)/);
    stubFetch([reply(429, { message: "Rate limit exceeded" }, { "retry-after": "1" })]);
    const rate = await thrown(() => meshyDirect.submit(ENV, "x"));
    assert.match(rate.message, /^Rate limited by Meshy/);
    assert.equal(rate.status, 429);
    stubFetch([reply(429, { message: "NoMorePendingTasks: too many tasks" })]);
    assert.match((await thrown(() => meshyDirect.submit(ENV, "x"))).message, /maximum number of tasks/);
    stubFetch([reply(500, { message: "Internal" })]);
    assert.match((await thrown(() => meshyDirect.submit(ENV, "x"))).message, /^Meshy had a server error \(500\)/);
    stubFetch([reply(400, { message: "prompt is too long" })]);
    assert.equal((await thrown(() => meshyDirect.submit(ENV, "x"))).message, "Meshy rejected the request (400): prompt is too long");
    stubFetch([reply(202, {})]);
    assert.match((await thrown(() => meshyDirect.submit(ENV, "x"))).message, /no task id/);
});

test("meshyDirect: poll 429 keeps running, 401 and 404 fail", async () => {
    const state = { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null };
    stubFetch([reply(429, { message: "Rate limit exceeded" }, { "retry-after": "1" })]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, state);
    assert.equal(r.status, "running");
    assert.equal(r.stage, "Rate limited by Meshy, retrying…");
    assert.equal(r.state.transient_errors, 1);
    assert.equal(r.state.preview_task_id, PREVIEW_ID);
    stubFetch([reply(401, { message: "Unauthorized" })]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, state), /^The Meshy API key was rejected \(401\)$/);
    stubFetch([reply(404, { message: "Task not found" })]);
    assertFailed(await meshyDirect.poll(ENV, PREVIEW_ID, state), /^Meshy rejected the request \(404\): Task not found$/);
});

test("meshyDirect: without state it polls the task id it was given", async () => {
    const f = stubFetch([reply(200, mtask({ status: "IN_PROGRESS", progress: 10 }))]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, null);
    assert.equal(r.progress, 5);
    assert.equal(f.calls[0].url, `${MESHY_ENDPOINT}/${PREVIEW_ID}`);
});

test("meshyDirect: cancel deletes the active task and swallows 409 and errors", async () => {
    const f = stubFetch([reply(200, {})]);
    await meshyDirect.cancel(ENV, PREVIEW_ID, { phase: "refine", preview_task_id: PREVIEW_ID, refine_task_id: REFINE_ID });
    assert.equal(f.calls[0].method, "DELETE");
    assert.equal(f.calls[0].url, `${MESHY_ENDPOINT}/${REFINE_ID}`);
    assert.equal(f.calls[0].headers.authorization, `Bearer ${KEYS.MESHY_API_KEY}`);
    const g = stubFetch([reply(409, { message: "Task is IN_PROGRESS and cannot be deleted." })]);
    await meshyDirect.cancel(ENV, PREVIEW_ID, { phase: "preview", preview_task_id: PREVIEW_ID, refine_task_id: null });
    assert.equal(g.calls[0].url, `${MESHY_ENDPOINT}/${PREVIEW_ID}`);
    stubFetch([timeoutError()]);
    await meshyDirect.cancel(ENV, PREVIEW_ID, null);
    await meshyDirect.cancel({}, PREVIEW_ID, null);
});

test("meshyDirect: a prompt over 800 characters is cut and noted through the hand-off", async () => {
    const f = stubFetch([reply(202, { result: PREVIEW_ID })]);
    const sub = await meshyDirect.submit(ENV, `${"wheel ".repeat(200)}end`);
    assert.ok(f.calls[0].body.prompt.length <= 800 && f.calls[0].body.prompt.length > 700);
    assert.equal(sub.state.prompt_trimmed_to, 800);
    stubFetch([reply(200, mtask({ status: "SUCCEEDED", progress: 100 })), reply(202, { result: REFINE_ID })]);
    const r = await meshyDirect.poll(ENV, PREVIEW_ID, sub.state);
    assert.equal(r.state.prompt_trimmed_to, 800); // survives the state replacement
    assert.match(r.stage, /prompt shortened to 800 characters/);
});

// ---------- shared helpers ----------

test("guardPoll: an error with a limit fails the job with its own message after `max` of the same kind in a row", async () => {
    const boom = (kind) => async () => {
        throw new ProviderError("Key rejected, retrying…", 502, true, { kind, max: 2 });
    };
    const r1 = await guardPoll({ a: 1 }, boom("key"));
    assert.deepEqual(r1, { status: "running", stage: "Key rejected, retrying…", state: { a: 1, transient_errors: 1, transient_kind: "key", transient_kind_count: 1 } });
    const r2 = await guardPoll(r1.state, boom("key"));
    assert.equal(r2.state.transient_kind_count, 2);
    assert.deepEqual(await guardPoll(r2.state, boom("key")), { status: "failed", error: "Key rejected" });
    // another kind starts its own streak; the total keeps counting
    const other = await guardPoll(r2.state, boom("other"));
    assert.equal(other.status, "running");
    assert.deepEqual([other.state.transient_errors, other.state.transient_kind, other.state.transient_kind_count], [3, "other", 1]);
    // a plain retryable error ends the streak
    const plain = await guardPoll(r2.state, async () => {
        throw new ProviderError("Busy, retrying…", 502, true);
    });
    assert.deepEqual(plain.state, { a: 1, transient_errors: 3 });
    // a clean poll drops all the bookkeeping
    const clean = await guardPoll(r2.state, async () => ({ status: "running", stage: "Generating" }));
    assert.deepEqual(clean, { status: "running", stage: "Generating", state: { a: 1 } });
});

test("guardPoll: maxTransient replaces the default budget of consecutive transient errors", async () => {
    const hiccup = async () => {
        throw new ProviderError("Down, retrying…", 502, true);
    };
    assert.equal((await guardPoll({ transient_errors: MAX_TRANSIENT_POLL_ERRORS }, hiccup)).status, "failed");
    assert.equal((await guardPoll({ transient_errors: MAX_TRANSIENT_POLL_ERRORS }, hiccup, { maxTransient: 120 })).status, "running");
    assert.equal((await guardPoll({ transient_errors: 119 }, hiccup, { maxTransient: 120 })).status, "running");
    assertFailed(await guardPoll({ transient_errors: 120 }, hiccup, { maxTransient: 120 }), /^Gave up after 121 failed attempts: Down$/);
});

test("cancel(): only adapters whose started tasks can be stopped define it (the engine refuses Stop for the rest)", async () => {
    // Tencent has no cancel API for Professional jobs and Tripo v3 has none either: a "canceled" job there would keep
    // running and charging, so these must not get a cancel(), and Stop is refused for them.
    for (const adapter of [tencentHunyuan, tripoParts, tripoTextured]) assert.equal(adapter.cancel, undefined, adapter.via);
    for (const adapter of [falHunyuan, falMeshy, falRodin, falTripo, meshyDirect, mockAdapter, openRouterDesigner]) {
        assert.equal(typeof adapter.cancel, "function", adapter.via);
    }
    await mockAdapter.cancel(ENV, "mock-1", null); // resolves, does nothing
    // and the routes in the registry agree
    const stoppable = Object.fromEntries(PROVIDER_SPECS.flatMap((spec) => spec.routes.map((r) => [`${spec.id}/${r.via}`, typeof r.adapter.cancel === "function"])));
    assert.equal(stoppable["hunyuan/tencent"], false);
    assert.equal(stoppable["hunyuan/fal"], true);
    assert.equal(stoppable["tripo/tripo"], false);
    assert.equal(stoppable["tripo/fal"], true);
    assert.equal(stoppable["mock/mock"], true);
    assert.equal(stoppable["muse/openrouter"], true); // Stop leaves a marker the queue consumer honours
});

test("preparePrompt: trims, cuts at a word boundary and counts code points", () => {
    assert.deepEqual(preparePrompt("  hi  ", 10), { prompt: "hi", trimmedTo: null });
    const cut = preparePrompt("aaaa bbbb cccc dddd eeee ffff", 22);
    assert.equal(cut.trimmedTo, 22);
    assert.equal(cut.prompt, "aaaa bbbb cccc dddd"); // backs up to the last space
    const hard = preparePrompt("alpha beta gamma delta epsilon", 20); // the last space is too far back: hard cut
    assert.equal(hard.prompt, "alpha beta gamma del");
    const emoji = preparePrompt("😀".repeat(30), 10);
    assert.equal(Array.from(emoji.prompt).length, 10);
    assert.throws(() => preparePrompt("   ", 10), ProviderError);
});

test("every request carries the 20 s timeout signal", async () => {
    // Recorded across all the tests above.
    assert.ok(allCalls.length > 100, "expected many recorded calls");
    for (const call of allCalls) {
        assert.ok(call.signal instanceof AbortSignal, `${call.method} ${call.url} has no AbortSignal`);
    }
});

// ---------- registry ----------

const ids = (env) => listProviders(env).map((p) => p.id);
const viaOf = (env) => Object.fromEntries(listProviders(env).map((p) => [p.id, p.via]));
const availableOf = (env) => listProviders(env).filter((p) => p.available).map((p) => p.id);

test("registry: only Hunyuan 3D and the Muse designer are offered; nothing is available without keys", () => {
    assert.deepEqual([...OFFERED_PROVIDERS], ["hunyuan", "muse"]);
    assert.deepEqual(ids({}), ["hunyuan", "muse"]);
    assert.deepEqual(availableOf({}), []);
    assert.ok(!ids({}).includes("mock"));
    assert.equal(resolveProvider({}, "hunyuan"), null);
});

test("registry: other vendors are neither listed nor accepted, whatever keys exist", () => {
    const every = { FAL_KEY: "k", TRIPO_API_KEY: "k", MESHY_API_KEY: "k", TENCENTCLOUD_SECRET_ID: "i", TENCENTCLOUD_SECRET_KEY: "s", OPENROUTER_API_KEY: "k" };
    assert.deepEqual(ids(every), ["hunyuan", "muse"]);
    assert.deepEqual(availableOf(every), ["hunyuan", "muse"]);
    for (const id of ["tripo-parts", "tripo", "meshy", "rodin", "mock"]) assert.equal(resolveProvider(every, id), null, id);
});

test("registry: Hunyuan runs through Tencent's own API, falling back to fal only without the Tencent key", () => {
    const tencent = { TENCENTCLOUD_SECRET_ID: "i", TENCENTCLOUD_SECRET_KEY: "s", FAL_KEY: "k" };
    assert.equal(resolveProvider(tencent, "hunyuan").adapter, tencentHunyuan);
    assert.deepEqual(viaOf(tencent), { hunyuan: "tencent", muse: null });
    assert.equal(resolveProvider({ FAL_KEY: "k" }, "hunyuan").adapter, falHunyuan);
    // half a Tencent key pair is no key
    assert.equal(resolveProvider({ TENCENTCLOUD_SECRET_ID: "i" }, "hunyuan"), null);
});

test("registry: OPENROUTER_API_KEY serves the Muse designer through openrouter, listed after hunyuan", () => {
    const env = { OPENROUTER_API_KEY: "k" };
    assert.deepEqual(availableOf(env), ["muse"]);
    assert.deepEqual(viaOf(env), { hunyuan: null, muse: "openrouter" });
    assert.equal(resolveProvider(env, "muse").adapter, openRouterDesigner);
    assert.equal(resolveProvider(env, "hunyuan"), null);
    // with a Hunyuan route as well, hunyuan comes first (and so is the default)
    const both = { TENCENTCLOUD_SECRET_ID: "i", TENCENTCLOUD_SECRET_KEY: "s", OPENROUTER_API_KEY: "k" };
    assert.deepEqual(availableOf(both), ["hunyuan", "muse"]);
    const muse = listProviders(env).find((p) => p.id === "muse");
    assert.deepEqual([muse.parts, muse.textured, muse.available, muse.via], [true, false, true, "openrouter"]);
});

test("registry: blank keys do not count; MOCK_PROVIDER=1 (local dev and tests only) adds the offline demo", () => {
    assert.deepEqual(availableOf({ TENCENTCLOUD_SECRET_ID: " ", TENCENTCLOUD_SECRET_KEY: "", OPENROUTER_API_KEY: "\n" }), []);
    const env = { MOCK_PROVIDER: "1" };
    assert.deepEqual(ids(env), ["hunyuan", "muse", "mock"]);
    assert.deepEqual(availableOf(env), ["mock"]);
    assert.equal(resolveProvider(env, "mock").adapter, mockAdapter);
    assert.ok(!ids({ MOCK_PROVIDER: "0" }).includes("mock"));
});

test("registry: every model has a label, description, a realistic time and consistent flags", () => {
    const expected = ["tripo-parts", "tripo", "meshy", "rodin", "hunyuan", "muse", "mock"];
    assert.deepEqual(PROVIDER_SPECS.map((s) => s.id), expected);
    for (const spec of PROVIDER_SPECS) {
        assert.ok(spec.info.label && spec.info.vendor && spec.info.description, spec.id);
        assert.ok(spec.info.approx_seconds >= 10 && spec.info.approx_seconds <= 300, spec.id);
        assert.ok(spec.routes.length >= 1, spec.id);
        for (const route of spec.routes) assert.equal(route.adapter.via, route.via, `${spec.id} route ${route.via}`);
    }
    // Third-party pages put the Hunyuan Pro edition at 3-6 minutes: a 2 minute estimate would park the bar at 95%.
    assert.ok(PROVIDER_SPECS.find((s) => s.id === "hunyuan").info.approx_seconds >= 180);
    const parts = PROVIDER_SPECS.find((s) => s.id === "tripo-parts");
    assert.equal(parts.info.parts, true);
    assert.equal(parts.info.textured, false); // generate_parts forces texture=false
    // the direct API is always listed before fal
    for (const spec of PROVIDER_SPECS) {
        const order = spec.routes.map((r) => r.via);
        if (order.includes("fal")) assert.equal(order.at(-1), "fal", spec.id);
    }
});

test("no API key ever reached the console", () => {
    for (const line of logged) assertNoKeys(line, "console output");
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
console.error = realConsoleError;

for (const { name, err } of failures) {
    console.error(`FAIL  ${name}\n      ${String(err?.stack ?? err).split("\n").slice(0, 6).join("\n      ")}`);
}
console.log(
    `\n${passed}/${tests.length} provider tests passed in ${Date.now() - t0} ms ` +
        `(${FAL_CASES.length} fal adapters, 2 Tripo adapters, 1 Meshy adapter, ${allCalls.length} stubbed requests)`,
);
process.exit(failures.length === 0 ? 0 : 1);
