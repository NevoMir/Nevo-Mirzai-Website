// Offline tests for the Tencent Hunyuan 3D adapter (worker/providers/tencent.ts). No network, no real keys:
// globalThis.fetch is replaced by a stub that serves responses shaped like Tencent's API docs.
//
//   node scripts/assignment/test-tencent.mjs
//
// Needs Node >= 22.18 (imports the .ts source directly; on 22.6-22.17 add --experimental-strip-types).

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { MAX_TRANSIENT_POLLS, signTc3Request, tencentHunyuan } from "../../worker/providers/tencent.ts";
import { ProviderError } from "../../worker/providers/types.ts";

const SECRET_ID = "AKIDtestSecretId0123456789abcdefgh";
const SECRET_KEY = "testSecretKey0123456789abcdefghij";
const ENV = { TENCENTCLOUD_SECRET_ID: SECRET_ID, TENCENTCLOUD_SECRET_KEY: SECRET_KEY };

// ---------- tiny harness ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const realFetch = globalThis.fetch;
const allCalls = [];

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
            rawBody: typeof init.body === "string" ? init.body : null,
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
    return calls;
}

const ok = (response) => ({ json: { Response: { RequestId: "req-1", ...response } } });
const fail = (Code, Message = "") => ({ json: { Response: { Error: { Code, Message }, RequestId: "req-1" } } });

// ---------- 1. signature v3 against the worked example in Tencent's docs ----------
//
// https://www.tencentcloud.com/document/api/213/33224 publishes a CVM DescribeInstances request with masked
// credentials. The signature it prints (a7b85514...) is the one produced by taking the masked placeholders literally:
// SecretId "AKID" + 32 asterisks and a SecretKey of 32 asterisks. Same inputs here, so the same Authorization header.

const DOC_PAYLOAD = '{"Limit": 1, "Filters": [{"Values": ["unnamed"], "Name": "instance-name"}]}';
const DOC_SECRET_ID = `AKID${"*".repeat(32)}`;
const DOC_SECRET_KEY = "*".repeat(32);

test("TC3 signature reproduces the worked example of the official docs", async () => {
    const sig = await signTc3Request({
        secretId: DOC_SECRET_ID,
        secretKey: DOC_SECRET_KEY,
        service: "cvm",
        host: "cvm.tencentcloudapi.com",
        timestamp: 1551113065,
        payload: DOC_PAYLOAD,
        contentType: "application/json; charset=utf-8",
    });
    assert.equal(
        sig.canonicalRequest,
        [
            "POST",
            "/",
            "",
            "content-type:application/json; charset=utf-8",
            "host:cvm.tencentcloudapi.com",
            "",
            "content-type;host",
            "99d58dfbc6745f6747f36bfca17dee5e6881dc0428a0a36f96199342bc5b4907", // documented payload hash
        ].join("\n"),
    );
    assert.equal(
        sig.stringToSign,
        [
            "TC3-HMAC-SHA256",
            "1551113065",
            "2019-02-25/cvm/tc3_request",
            "2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a", // documented hashed canonical request
        ].join("\n"),
    );
    assert.equal(sig.credentialScope, "2019-02-25/cvm/tc3_request");
    assert.equal(sig.signature, "a7b8551448762bd123d6f79e81815e31a92013640a6cef36a08ad4b292a4d2f2");
    assert.equal(
        sig.authorization,
        `TC3-HMAC-SHA256 Credential=${DOC_SECRET_ID}/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host, Signature=a7b8551448762bd123d6f79e81815e31a92013640a6cef36a08ad4b292a4d2f2`,
    );
});

test("TC3 signature matches an independent node:crypto implementation for the Hunyuan host", async () => {
    const timestamp = 1790000000; // 2026-09-21 UTC
    const payload = JSON.stringify({ Prompt: "a wooden chair, 椅子", Model: "3.1" });
    const sig = await signTc3Request({
        secretId: SECRET_ID,
        secretKey: SECRET_KEY,
        service: "hunyuan",
        host: "hunyuan.intl.tencentcloudapi.com",
        timestamp,
        payload,
    });
    const sha = (s) => createHash("sha256").update(s).digest("hex");
    const mac = (k, s) => createHmac("sha256", k).update(s).digest();
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonical = `POST\n/\n\ncontent-type:application/json\nhost:hunyuan.intl.tencentcloudapi.com\n\ncontent-type;host\n${sha(payload)}`;
    const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${date}/hunyuan/tc3_request\n${sha(canonical)}`;
    const key = mac(mac(mac(`TC3${SECRET_KEY}`, date), "hunyuan"), "tc3_request");
    const expected = createHmac("sha256", key).update(toSign).digest("hex");
    assert.equal(sig.signature, expected);
    assert.equal(sig.canonicalRequest, canonical);
    assert.match(sig.authorization, new RegExp(`^TC3-HMAC-SHA256 Credential=${SECRET_ID}/${date}/hunyuan/tc3_request, SignedHeaders=content-type;host, Signature=${expected}$`));
});

// ---------- 2. submit ----------

test("submit sends a signed Normal / 3.1 / no-PBR request to the international Hunyuan host", async () => {
    const calls = stubFetch([ok({ JobId: "1422504058612350976" })]);
    const before = Math.floor(Date.now() / 1000);
    const result = await tencentHunyuan.submit(ENV, "  a small wooden chair  ");
    const after = Math.floor(Date.now() / 1000);

    assert.equal(tencentHunyuan.via, "tencent");
    assert.deepEqual(result, { taskId: "1422504058612350976", state: { region: "ap-singapore", model: "3.1" } });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, "https://hunyuan.intl.tencentcloudapi.com/");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, { Prompt: "a small wooden chair", Model: "3.1", GenerateType: "Normal", EnablePBR: false });
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers["x-tc-action"], "SubmitHunyuanTo3DProJob");
    assert.equal(call.headers["x-tc-version"], "2023-09-01");
    assert.equal(call.headers["x-tc-region"], "ap-singapore");
    const timestamp = Number(call.headers["x-tc-timestamp"]);
    assert.ok(Number.isInteger(timestamp) && timestamp >= before && timestamp <= after, "X-TC-Timestamp is the current UNIX time in seconds");
    assert.ok(call.signal instanceof AbortSignal, "every fetch carries an abort signal (a timeout)");
    assert.equal(call.headers["x-tc-language"], "en-US", "messages are requested in English");

    // The Authorization header must be the signature of exactly the body that was sent.
    const expected = await signTc3Request({
        secretId: SECRET_ID,
        secretKey: SECRET_KEY,
        service: "hunyuan",
        host: "hunyuan.intl.tencentcloudapi.com",
        timestamp,
        payload: call.rawBody,
        contentType: "application/json",
    });
    assert.equal(call.headers.authorization, expected.authorization);
    assert.ok(!Object.values(call.headers).some((v) => v.includes(SECRET_KEY)), "the secret key is never sent");
});

test("submit shortens a prompt over 1024 characters and records it", async () => {
    const calls = stubFetch([ok({ JobId: "j-long" })]);
    const long = "word ".repeat(400); // 2000 characters
    const result = await tencentHunyuan.submit(ENV, long);
    assert.ok(Array.from(calls[0].body.Prompt).length <= 1024);
    assert.equal(result.state.prompt_trimmed_to, 1024);
});

test("submit without keys fails with a 503 that names the variable, not a key", async () => {
    stubFetch(() => assert.fail("must not call the API without keys"));
    await assert.rejects(tencentHunyuan.submit({ TENCENTCLOUD_SECRET_ID: SECRET_ID }, "a chair"), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 503);
        assert.match(err.message, /TENCENTCLOUD_SECRET_KEY is not configured/);
        return true;
    });
    await assert.rejects(tencentHunyuan.submit(ENV, "   "), /prompt is empty/i);
});

test("submit without a JobId in the reply fails clearly", async () => {
    stubFetch([ok({})]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), /no job id/i);
});

// ---------- 3. poll ----------

const STATE = { region: "ap-singapore", model: "3.1" };
const poll = (id = "job-1", state = STATE) => tencentHunyuan.poll(ENV, id, state);

test("poll sends QueryHunyuanTo3DProJob with the JobId and the stored region", async () => {
    const calls = stubFetch([ok({ Status: "RUN", ErrorCode: "", ErrorMessage: "", ResultFile3Ds: [] })]);
    await poll("1375367755519696896", { region: "na-siliconvalley" });
    const call = calls[0];
    assert.equal(call.url, "https://hunyuan.intl.tencentcloudapi.com/");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, { JobId: "1375367755519696896" });
    assert.equal(call.headers["x-tc-action"], "QueryHunyuanTo3DProJob");
    assert.equal(call.headers["x-tc-version"], "2023-09-01");
    assert.equal(call.headers["x-tc-region"], "na-siliconvalley");
    assert.match(call.headers.authorization, /^TC3-HMAC-SHA256 Credential=AKID\S+\/\d{4}-\d{2}-\d{2}\/hunyuan\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
});

test("poll maps WAIT, RUN and FAIL", async () => {
    stubFetch([
        ok({ Status: "WAIT", ResultFile3Ds: [] }),
        ok({ Status: "RUN", ResultFile3Ds: [] }),
        ok({ Status: "FAIL", ErrorCode: "InvalidParameter.PromptRisk", ErrorMessage: "The prompt did not pass the content review.", ResultFile3Ds: [] }),
        ok({ Status: "FAIL", ErrorCode: "", ErrorMessage: "" }),
    ]);
    assert.deepEqual(await poll(), { status: "queued", stage: "In queue" });
    assert.deepEqual(await poll(), { status: "running", stage: "Generating 3D model" });
    assert.deepEqual(await poll(), {
        status: "failed",
        error: "Hunyuan 3D could not generate this model: The prompt did not pass the content review.",
    });
    assert.deepEqual(await poll(), { status: "failed", error: "Hunyuan 3D could not generate this model." });
});

test("poll keeps the 'prompt shortened' note in the stage text", async () => {
    stubFetch([ok({ Status: "WAIT" })]);
    const result = await poll("job-1", { ...STATE, prompt_trimmed_to: 1024 });
    assert.equal(result.status, "queued");
    assert.match(result.stage, /^In queue \(prompt shortened to 1024 characters\)$/);
});

test("poll DONE picks the GLB (by Type, any case) and its preview image", async () => {
    stubFetch([
        ok({
            Status: "DONE",
            ResultFile3Ds: [
                { Type: "OBJ", Url: "https://x.cos.ap-singapore.myqcloud.com/job/model.zip?sign=a", PreviewImageUrl: "https://x.cos.ap-singapore.myqcloud.com/job/obj-preview.png" },
                { Type: "glb", Url: "https://x.cos.ap-singapore.myqcloud.com/job/model.glb?sign=b", PreviewImageUrl: "https://x.cos.ap-singapore.myqcloud.com/job/glb-preview.png" },
            ],
        }),
    ]);
    assert.deepEqual(await poll(), {
        status: "succeeded",
        glbUrl: "https://x.cos.ap-singapore.myqcloud.com/job/model.glb?sign=b",
        thumbnailUrl: "https://x.cos.ap-singapore.myqcloud.com/job/glb-preview.png",
    });
});

test("poll DONE falls back to a .glb path when Type is missing, and to another entry's preview", async () => {
    stubFetch([
        ok({
            Status: "DONE",
            ResultFile3Ds: [
                { Type: "Image", Url: "https://x.example/tex.png", PreviewImageUrl: "https://x.example/preview.png" },
                { Url: "http://x.example/path/Model.GLB?token=1" }, // http is upgraded, extension match is case-insensitive
            ],
            SomethingNew: { ignored: true }, // extra fields are tolerated
        }),
        ok({ Status: "DONE", ResultFile3Ds: [{ Type: "GLB", Url: "https://x.example/m.glb" }] }),
    ]);
    assert.deepEqual(await poll(), {
        status: "succeeded",
        glbUrl: "https://x.example/path/Model.GLB?token=1",
        thumbnailUrl: "https://x.example/preview.png",
    });
    assert.deepEqual(await poll(), { status: "succeeded", glbUrl: "https://x.example/m.glb", thumbnailUrl: null });
});

test("poll DONE without a GLB fails and lists the formats received", async () => {
    stubFetch([
        ok({
            Status: "DONE",
            ResultFile3Ds: [
                { Type: "OBJ", Url: "https://x.example/model.zip", PreviewImageUrl: "https://x.example/p.png" },
                { Type: "Image", Url: "https://x.example/tex.png" },
                { Type: "OBJ", Url: "https://x.example/other.zip" },
            ],
        }),
        ok({ Status: "DONE", ResultFile3Ds: [] }),
    ]);
    const result = await poll();
    assert.equal(result.status, "failed");
    assert.match(result.error, /no GLB file \(received: OBJ, Image\)/);
    // DONE with an empty file list keeps polling (the files can lag the status) instead of failing a paid model.
    const empty = await poll();
    assert.equal(empty.status, "running");
    assert.equal(empty.stage, "Hunyuan 3D finished; waiting for its files…");
});

// ---------- 4. error mapping ----------

test("AuthFailure.* is a key rejection (and never echoes the key)", async () => {
    for (const code of ["AuthFailure.SignatureFailure", "AuthFailure.SecretIdNotFound", "AuthFailure.InvalidSecretId"]) {
        stubFetch([fail(code, `The SecretId ${SECRET_ID} is not found`)]);
        await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.message, "Tencent Cloud rejected the API key (check TENCENTCLOUD_SECRET_ID/KEY)");
            assert.equal(err.retryable, false);
            return true;
        });
    }
    // While polling a rejected key is retried a few times (a blip must not throw away a paid job), then fails the job
    // instead of retrying forever; see the "poll" tests below for the full policy.
    let state = STATE;
    for (let i = 1; i <= 3; i++) {
        stubFetch([fail("AuthFailure.SignatureFailure", "bad signature")]);
        const r = await tencentHunyuan.poll(ENV, "job-1", state);
        assert.equal(r.status, "running", `attempt ${i}`);
        assert.equal(r.stage, "Tencent Cloud rejected the API key (check TENCENTCLOUD_SECRET_ID/KEY), retrying…");
        state = r.state;
    }
    stubFetch([fail("AuthFailure.SignatureFailure", "bad signature")]);
    assert.deepEqual(await tencentHunyuan.poll(ENV, "job-1", state), {
        status: "failed",
        error: "Tencent Cloud rejected the API key (check TENCENTCLOUD_SECRET_ID/KEY)",
    });
    // A CAM permission problem and a clock problem get their own wording.
    stubFetch([fail("AuthFailure.UnauthorizedOperation", "denied"), fail("AuthFailure.SignatureExpire", "expired")]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), /QcloudAI3DFullAccess/);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), /clock/);
});

test("used-up free credits, billing errors and missing activation get their own messages", async () => {
    const credits = "The Hunyuan 3D free credits are used up (or the service isn't activated) — see the Tencent Cloud console";
    for (const code of [
        "FailedOperation.FreeResourcePackExhausted",
        "FailedOperation.ResourcePackExhausted",
        "FailedOperation.ServiceStopArrears",
    ]) {
        stubFetch([fail(code, "Free resource pack is exhausted")]);
        await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.message, credits, code);
            return true;
        });
    }
    // A billing error found by its wording only, on a code the docs do not list.
    stubFetch([fail("FailedOperation.Unknown", "Your account is in arrears")]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => err.message === credits);
    // During a poll the job fails with the same text.
    stubFetch([fail("FailedOperation.FreeResourcePackExhausted", "used up")]);
    assert.deepEqual(await poll(), { status: "failed", error: credits });

    for (const code of ["FailedOperation.ServiceNotActivated", "ResourceUnavailable.NotExist", "ResourceUnavailable"]) {
        stubFetch([fail(code, "Service is not activated")]);
        await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), /isn't activated.*activate the service/, code);
    }
});

test("RequestLimitExceeded keeps a poll running and fails a submit", async () => {
    stubFetch([fail("RequestLimitExceeded", "Too many requests"), fail("RequestLimitExceeded.UinLimitExceeded", "uin limit")]);
    assert.deepEqual(await poll(), {
        status: "running",
        stage: "Rate limited, retrying…",
        state: { ...STATE, transient_errors: 1 },
    });
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 429);
        assert.match(err.message, /Rate limited by Tencent Cloud/);
        return true;
    });
});

test("poll rides out transient failures, then recovers or gives up", async () => {
    // network error, HTML 502, engine hiccup, then a clean RUN resets the counter
    stubFetch([
        new TypeError("fetch failed"),
        { status: 502, text: "<html>Bad Gateway</html>" },
        fail("FailedOperation.EngineServerError", "engine error"),
        ok({ Status: "RUN" }),
    ]);
    let state = STATE;
    for (let i = 1; i <= 3; i++) {
        const r = await tencentHunyuan.poll(ENV, "job-1", state);
        assert.equal(r.status, "running");
        assert.equal(r.state.transient_errors, i);
        state = r.state;
    }
    const clean = await tencentHunyuan.poll(ENV, "job-1", state);
    assert.deepEqual(clean, { status: "running", stage: "Generating 3D model", state: STATE });

    // a timeout is retryable too
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    stubFetch([timeout]);
    const t = await poll();
    assert.equal(t.status, "running");
    assert.match(t.stage, /did not answer in time/);

    // and a dead vendor cannot hang a job forever, but is given about ten minutes first
    stubFetch(() => fail("InternalError", "boom"));
    const last = await tencentHunyuan.poll(ENV, "job-1", { ...STATE, transient_errors: MAX_TRANSIENT_POLLS - 1 });
    assert.equal(last.status, "running");
    const dead = await tencentHunyuan.poll(ENV, "job-1", { ...STATE, transient_errors: MAX_TRANSIENT_POLLS });
    assert.equal(dead.status, "failed");
    assert.match(dead.error, new RegExp(`^Gave up after ${MAX_TRANSIENT_POLLS + 1} failed attempts: Tencent Cloud is having trouble \\(InternalError\\)$`));
});

test("the transient poll budget covers at least eight minutes of one poll per 5 seconds", () => {
    assert.ok(MAX_TRANSIENT_POLLS * 5 >= 8 * 60, `${MAX_TRANSIENT_POLLS} polls`);
});

test("other Tencent errors are reported with their code and message, without secrets", async () => {
    stubFetch([
        fail("InvalidParameterValue.Model", "Model does not exist."),
        fail("FailedOperation", `Something broke for ${SECRET_ID} / ${SECRET_KEY}`),
        { text: "not json at all", status: 200 },
    ]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
        assert.equal(err.message, "Tencent Cloud error InvalidParameterValue.Model: Model does not exist.");
        assert.equal(err.status, 422);
        return true;
    });
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
        assert.equal(err.message, "Tencent Cloud error FailedOperation: Something broke for *** / ***");
        assert.ok(!err.message.includes(SECRET_ID) && !err.message.includes(SECRET_KEY));
        return true;
    });
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), /unexpected reply \(200\)/);
});

// ---------- 5. poll errors: a paid job is only failed on a definite answer ----------

const RETRY_STAGE = /, retrying…$/;

/** Polls `times` times, each reply from `make(i)`, feeding the state back in; returns every result. */
async function pollRepeatedly(times, make, state = STATE) {
    const results = [];
    for (let i = 1; i <= times; i++) {
        stubFetch([make(i)]);
        const r = await tencentHunyuan.poll(ENV, "job-1", state);
        results.push(r);
        if (r.status !== "running") break;
        state = r.state;
    }
    return results;
}

test("poll retries every error code that is not a definite answer (the job is already paid for)", async () => {
    for (const code of [
        "LimitExceeded",
        "FailedOperation",
        "FailedOperation.Unknown",
        "UnsupportedOperation",
        "ResourceUnavailable",
        "ResourceUnavailable.NotExist",
        "ResourceInsufficient",
        "ResourceInUse",
        "AuthFailure.SignatureExpire",
        "AuthFailure.TokenFailure",
        "IpInBlacklist",
        "InternalError",
        "ServiceUnavailable",
        "FailedOperation.EngineServerError",
        "SomethingNew.NeverSeen",
        "ResourceExhausted", // named like a billing code, but only the documented billing codes end a paid job
    ]) {
        stubFetch([fail(code, "Something went wrong")]);
        const r = await poll();
        assert.equal(r.status, "running", code);
        assert.match(r.stage, RETRY_STAGE, code);
        if (!code.startsWith("AuthFailure")) assert.ok(r.stage.includes(code), `${code} is named in the stage text`);
        assert.equal(r.state.transient_errors, 1, code);
        assert.ok(!JSON.stringify(r).includes(SECRET_KEY));
    }
    // a clean poll afterwards resets the counters
    stubFetch([ok({ Status: "RUN" })]);
    const clean = await tencentHunyuan.poll(ENV, "job-1", { ...STATE, transient_errors: 7, transient_kind: "ResourceNotFound", transient_kind_count: 2 });
    assert.deepEqual(clean, { status: "running", stage: "Generating 3D model", state: STATE });
});

test("poll fails at once only on billing errors and malformed requests", async () => {
    const credits = "The Hunyuan 3D free credits are used up (or the service isn't activated) — see the Tencent Cloud console";
    for (const code of ["FailedOperation.FreeResourcePackExhausted", "FailedOperation.ResourcePackExhausted", "FailedOperation.ServiceStopArrears"]) {
        stubFetch([fail(code, "used up")]);
        assert.deepEqual(await poll(), { status: "failed", error: credits }, code);
    }
    stubFetch([fail("InvalidParameterValue.JobId", "JobId is invalid."), fail("MissingParameter", "JobId is missing")]);
    assert.deepEqual(await poll(), { status: "failed", error: "Tencent Cloud error InvalidParameterValue.JobId: JobId is invalid." });
    assert.deepEqual(await poll(), { status: "failed", error: "Tencent Cloud error MissingParameter: JobId is missing" });
});

test("poll gives a rejected key three chances, then fails the job with the key message", async () => {
    for (const code of ["AuthFailure.SecretIdNotFound", "AuthFailure.InvalidSecretId", "AuthFailure.SignatureFailure"]) {
        const results = await pollRepeatedly(4, () => fail(code, "nope"));
        assert.deepEqual(results.map((r) => r.status), ["running", "running", "running", "failed"], code);
        assert.equal(results[2].state.transient_kind, code);
        assert.equal(results[2].state.transient_kind_count, 3);
        assert.equal(results[3].error, "Tencent Cloud rejected the API key (check TENCENTCLOUD_SECRET_ID/KEY)");
    }
    for (const code of ["AuthFailure.UnauthorizedOperation", "UnauthorizedOperation"]) {
        const results = await pollRepeatedly(4, () => fail(code, "denied"));
        assert.deepEqual(results.map((r) => r.status), ["running", "running", "running", "failed"], code);
        assert.match(results[3].error, /^This Tencent Cloud API key may not use Hunyuan 3D .*QcloudAI3DFullAccess policy\)$/);
    }
});

test("poll treats a missing job (ResourceNotFound) as real only after five in a row", async () => {
    const results = await pollRepeatedly(6, () => fail("ResourceNotFound.JobNotExist", "no such job"));
    assert.deepEqual(results.map((r) => r.status), ["running", "running", "running", "running", "running", "failed"]);
    assert.equal(results[5].error, "Tencent Cloud cannot find this job (ResourceNotFound)");
});

test("poll: a clean poll or a different error ends a streak", async () => {
    // key error x3, a clean RUN, key error x3 again: never reaches a 4th in a row
    stubFetch([fail("AuthFailure.SignatureFailure"), fail("AuthFailure.SignatureFailure"), fail("AuthFailure.SignatureFailure"), ok({ Status: "RUN" })]);
    let state = STATE;
    for (let i = 0; i < 3; i++) state = (await tencentHunyuan.poll(ENV, "job-1", state)).state;
    const clean = await tencentHunyuan.poll(ENV, "job-1", state);
    assert.deepEqual(clean.state, STATE);
    const again = await pollRepeatedly(3, () => fail("AuthFailure.SignatureFailure"), clean.state);
    assert.deepEqual(again.map((r) => r.status), ["running", "running", "running"]);

    // a different transient error in between also starts the count again; the overall budget keeps counting
    const mixed = await pollRepeatedly(
        5,
        (i) => (i === 3 ? fail("InternalError", "boom") : fail("AuthFailure.SignatureFailure")),
    );
    assert.deepEqual(mixed.map((r) => r.status), ["running", "running", "running", "running", "running"]);
    assert.equal(mixed[4].state.transient_errors, 5);
    assert.equal(mixed[4].state.transient_kind_count, 2);
});

test("poll retries replies that are not a Tencent envelope, whatever the status", async () => {
    stubFetch([
        { status: 403, text: "<html>Forbidden</html>" },
        { status: 502, text: "<html>Bad Gateway</html>" },
        { status: 200, text: "" },
        { status: 429, text: "slow down" },
    ]);
    for (const re of [/unexpected reply \(403\), retrying…$/, /having trouble \(502\), retrying…$/, /unexpected reply \(200\), retrying…$/, /unexpected reply \(429\), retrying…$/]) {
        const r = await poll();
        assert.equal(r.status, "running");
        assert.match(r.stage, re);
    }
});

test("ResourceInsufficient is a capacity answer, not 'credits used up'", async () => {
    const insufficient = "Tencent Cloud reports insufficient resources (credits may be used up, or capacity is short)";
    stubFetch([fail("ResourceInsufficient", "Free resource pack is exhausted")]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
        assert.equal(err.message, insufficient);
        assert.equal(err.retryable, false);
        return true;
    });
    stubFetch([fail("ResourceInsufficient", "Insufficient resource")]);
    const r = await poll();
    assert.equal(r.status, "running"); // never fails a paid job by itself
    assert.match(r.stage, /ResourceInsufficient/);
});

test("billing wording is matched in the message of FailedOperation.* errors only, and never beats a hiccup code", async () => {
    const credits = "The Hunyuan 3D free credits are used up (or the service isn't activated) — see the Tencent Cloud console";
    stubFetch([
        fail("FailedOperation.SomethingNew", "Your balance is insufficient"), // wording fallback still works here
        fail("LimitExceeded", "insufficient balance"), // not a FailedOperation: no guessing from wording
        fail("FailedOperation.EngineServerLimitExceeded", "Insufficient capacity, please retry"), // a hiccup, not billing
        fail("ArrearsXyz", "x"), // a code that names the billing problem itself
    ]);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => err.message === credits);
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => err.message === "Tencent Cloud error LimitExceeded: insufficient balance");
    await assert.rejects(
        tencentHunyuan.submit(ENV, "a chair"),
        (err) => err.message === "Tencent Cloud had a server error (FailedOperation.EngineServerLimitExceeded). Try again in a moment.",
    );
    await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => err.message === credits);
});

// ---------- 6. an unanswered submit may have created a paid job ----------

const MAY_HAVE_STARTED = /The model may still have started, so check your Tencent usage before running it again\.$/;

test("a submit whose reply is lost says the model may have started, and is flagged retryable (= ambiguous)", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    stubFetch([timeout, new TypeError("fetch failed"), { status: 502, text: "<html>Bad Gateway</html>" }, ok({})]);
    const seen = [];
    for (let i = 0; i < 4; i++) {
        await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.retryable, true);
            assert.match(err.message, MAY_HAVE_STARTED);
            seen.push(err.message);
            return true;
        });
    }
    assert.match(seen[0], /^Tencent Cloud did not answer in time\./);
    assert.match(seen[1], /^Lost contact with Tencent Cloud\./);
    assert.match(seen[2], /^Tencent Cloud had a server error \(502\)\./);
    assert.match(seen[3], /^Tencent Cloud accepted the request but returned no job id\./);
});

test("a submit that Tencent answered with an error is definite: not retryable, no 'may have started'", async () => {
    stubFetch([fail("InternalError", "boom"), { status: 404, text: "not found" }, fail("RequestLimitExceeded", "slow down")]);
    for (let i = 0; i < 3; i++) {
        await assert.rejects(tencentHunyuan.submit(ENV, "a chair"), (err) => {
            assert.equal(err.retryable, false);
            assert.doesNotMatch(err.message, /may still have started/);
            return true;
        });
    }
});

test("polling keeps the short timeout wording (nothing to double-spend there)", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    stubFetch([timeout, new TypeError("fetch failed")]);
    assert.equal((await poll()).stage, "Tencent Cloud did not answer in time");
    assert.equal((await poll()).stage, "Could not reach Tencent Cloud");
});

test("submit waits up to 30 s for the reply, polls 20 s", async () => {
    const real = AbortSignal.timeout;
    const asked = [];
    AbortSignal.timeout = (ms) => {
        asked.push(ms);
        return real.call(AbortSignal, ms);
    };
    try {
        stubFetch([ok({ JobId: "j-1" }), ok({ Status: "RUN" })]);
        await tencentHunyuan.submit(ENV, "a chair");
        await poll();
    } finally {
        AbortSignal.timeout = real;
    }
    assert.deepEqual(asked, [30_000, 20_000]);
});

test("the adapter has no cancel(): the engine must refuse Stop instead of faking it", () => {
    assert.equal(tencentHunyuan.cancel, undefined);
});

test("no secret key ever appears in a request URL, body or header", () => {
    assert.ok(allCalls.length > 0);
    for (const call of allCalls) {
        const sent = JSON.stringify([call.url, call.rawBody, call.headers]);
        assert.ok(!sent.includes(SECRET_KEY), "secret key leaked into a request");
    }
});

// ---------- run ----------

let failed = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}\n       ${err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 8).join("\n       ") : String(err)}`);
    }
}
globalThis.fetch = realFetch;
console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${allCalls.length} stubbed API calls, no network used`);
process.exit(failed === 0 ? 0 : 1);
