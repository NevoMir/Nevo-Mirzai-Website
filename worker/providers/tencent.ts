// Tencent Hunyuan 3D, the official "Tencent HY 3D Global" Professional API (international Tencent Cloud).
// Checked 2026-10-23 against:
//   API    https://www.tencentcloud.com/document/api/1284/75540 (SubmitHunyuanTo3DProJob)
//          https://www.tencentcloud.com/document/api/1284/75541 (QueryHunyuanTo3DProJob)
//          https://www.tencentcloud.com/document/api/1284/75543 (error codes), .../75534 (regions)
//   Sign   https://www.tencentcloud.com/document/api/213/33224 (signature v3, TC3-HMAC-SHA256)
//   Prices https://www.tencentcloud.com/document/product/1284/75281
//
//   POST https://hunyuan.intl.tencentcloudapi.com/   Version 2023-09-01, service "hunyuan" (the host's first label)
//     X-TC-Action: SubmitHunyuanTo3DProJob  {Prompt, Model, GenerateType, EnablePBR, ...} -> {Response: {JobId}}
//     X-TC-Action: QueryHunyuanTo3DProJob   {JobId} -> {Response: {Status: WAIT|RUN|FAIL|DONE, ErrorCode,
//                                                       ErrorMessage, ResultFile3Ds: [{Type, Url, PreviewImageUrl}]}}
// Errors come back with HTTP 200 and {Response: {Error: {Code, Message}, RequestId}}. Every request is signed with
// the account's SecretId/SecretKey (there is no bearer token), see signTc3Request. X-TC-Language: en-US asks for
// English messages (it is not a signed header).
//
// Money safety, since a started job cannot be stopped (there is no cancel API) and the Submit API has no idempotency
// token: a submit whose reply is lost (timeout, dropped connection, a proxy's 5xx) says the model may have started
// instead of inviting a retry, and while polling only a definite answer fails a job that is already paid for (see
// pollError); anything else is retried for about ten minutes (MAX_TRANSIENT_POLLS).
//
// Credits (1 credit is about $0.015 prepaid): the free pack is 200 credits, one time, valid a year, and when it is
// used up calls fail with a billing error (no automatic postpaid). Normal (textured) costs 25 credits; EnablePBR,
// FaceCount and MultiViewImages add 10 each; Geometry (white model) costs 15. The Model version is free.
// This adapter sends Normal, no PBR and no FaceCount, so one run is 25 credits: 8 runs from the free 200. (Leaving
// FaceCount out means Tencent's default of 500,000 faces; setting it would cost +10 credits per run.)
// Failed tasks, including content-moderated ones, are not charged. Limits: 3 concurrent Professional jobs
// (extra tasks wait in WAIT), 20 requests/second. Result URLs are valid for 24 hours, so the engine copies them.
//
// The Professional submit page documents no ResultFormat; the Chinese edition of the API returns OBJ and GLB by
// default, and the international File3D page still lists the stale Type values GIF/OBJ/Image. Hence pickGlb looks for
// a GLB by Type or file extension and fails with the list of formats actually received when there is none.

import {
    ProviderError,
    REQUEST_TIMEOUT_MS,
    asString,
    guardPoll,
    isRecord,
    preparePrompt,
    requireKey,
    withPromptNote,
    type AdapterState,
    type Env,
    type Json,
    type PollResult,
    type ProviderAdapter,
    type SubmitResult,
} from "./types.ts";

const HOST = "hunyuan.intl.tencentcloudapi.com";
const SERVICE = "hunyuan"; // the credential scope uses the host's service label
const VERSION = "2023-09-01";
const REGION = "ap-singapore"; // the product lists ap-singapore, eu-frankfurt and na-siliconvalley
const MODEL = "3.1"; // newest Professional model; "3.0" is the API default
const GENERATE_TYPE = "Normal"; // textured; 3.1 does not offer LowPoly or Sketch
const PROMPT_LIMIT = 1024; // "up to 1024 utf-8 characters"
// Submit gets longer than the 20 s every other call has: a reply that gets lost leaves a paid job nobody tracks.
const SUBMIT_TIMEOUT_MS = 30_000;
const MAY_HAVE_STARTED = "The model may still have started, so check your Tencent usage before running it again.";
/**
 * Consecutive transient poll errors tolerated before a job is failed. A real poll happens every 3-6 s (the engine's
 * lease plus the client's loop), so this is about 10 minutes of Tencent or network trouble. The job is already paid
 * for and the result URL lasts 24 h, so giving up early only throws the model away; the engine's 30 minute cap bounds it.
 */
export const MAX_TRANSIENT_POLLS = 120;

// ---------------------------------------------------------------------------------------------------------
// Signature v3 (TC3-HMAC-SHA256) with Web Crypto only, so it runs in Workers as well as Node.
// ---------------------------------------------------------------------------------------------------------

export interface Tc3Request {
    secretId: string;
    secretKey: string;
    service: string; // "hunyuan" for hunyuan.intl.tencentcloudapi.com
    host: string;
    timestamp: number; // UNIX seconds, the same value as the X-TC-Timestamp header
    payload: string; // the exact request body that is sent
    contentType?: string; // must equal the Content-Type header that is sent; default "application/json"
}

export interface Tc3Signature {
    authorization: string; // the Authorization header value
    signature: string; // lowercase hex
    credentialScope: string; // "<UTC date>/<service>/tc3_request"
    canonicalRequest: string;
    stringToSign: string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
    return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** HMAC-SHA256; the first step of the key chain uses a string key, the later ones the previous digest. */
async function hmacSha256(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const raw = typeof key === "string" ? encoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/**
 * The Authorization header for a POST to "/" with a JSON body. Only content-type and host are signed, which is the
 * minimum the docs require (the other X-TC-* headers are not part of the signature).
 */
export async function signTc3Request(req: Tc3Request): Promise<Tc3Signature> {
    const contentType = req.contentType ?? "application/json";
    const date = new Date(req.timestamp * 1000).toISOString().slice(0, 10); // the credential date is UTC
    const credentialScope = `${date}/${req.service}/tc3_request`;
    const signedHeaders = "content-type;host";
    const canonicalRequest = [
        "POST",
        "/",
        "", // a POST has no query string
        `content-type:${contentType}\nhost:${req.host}\n`, // each header line ends with a newline
        signedHeaders,
        await sha256Hex(req.payload),
    ].join("\n");
    const stringToSign = [
        "TC3-HMAC-SHA256",
        String(req.timestamp),
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join("\n");
    const secretDate = await hmacSha256(`TC3${req.secretKey}`, date);
    const secretService = await hmacSha256(secretDate, req.service);
    const secretSigning = await hmacSha256(secretService, "tc3_request");
    const signature = toHex(await hmacSha256(secretSigning, stringToSign));
    return {
        authorization: `TC3-HMAC-SHA256 Credential=${req.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        signature,
        credentialScope,
        canonicalRequest,
        stringToSign,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------

/** Removes the account's key material from text that is about to be shown to the user. */
function scrub(text: string, secrets: string[]): string {
    let out = text.replace(/\s+/g, " ").trim();
    for (const secret of secrets) {
        if (secret.length >= 8) out = out.split(secret).join("***");
    }
    return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

const BILLING_CODES = new Set([
    "FailedOperation.FreeResourcePackExhausted",
    "FailedOperation.ResourcePackExhausted",
    "FailedOperation.ServiceStopArrears",
]);
// Code names are stable identifiers (they are not localized), so unmistakable billing tokens in them count too.
// "ResourceInsufficient" is deliberately not billing: it is a generic common code ("not enough resources") that
// can equally mean short capacity.
const BILLING_CODE_PARTS = /arrear|exhaust|overdue/i;
// Codes the docs do not list for a drained free pack ("billing exception") are matched by wording, but only on a
// FailedOperation.* error and only as a fallback: Response.Error.Message may be localized (X-TC-Language).
const BILLING_WORDS = /exhaust|arrear|insufficient|balance|billing|overdue|resource ?pack|free (quota|resource|package)/i;
const ACTIVATION_WORDS = /not (been )?activated|activate/i;
// Tencent-side hiccups that are worth another try.
const HICCUP_CODES = new Set([
    "InternalError",
    "ServiceUnavailable",
    "FailedOperation.EngineRequestTimeout",
    "FailedOperation.EngineServerError",
    "FailedOperation.EngineServerLimitExceeded",
]);

const MSG_CLOCK = "Tencent Cloud rejected the request: the server clock differs from Tencent's by more than 5 minutes";
const MSG_CAM = "This Tencent Cloud API key may not use Hunyuan 3D (a sub-account needs the QcloudAI3DFullAccess policy)";
const MSG_KEY = "Tencent Cloud rejected the API key (check TENCENTCLOUD_SECRET_ID/KEY)";
const MSG_CREDITS = "The Hunyuan 3D free credits are used up (or the service isn't activated) — see the Tencent Cloud console";
const MSG_ACTIVATE =
    "Tencent HY 3D isn't activated for this Tencent Cloud account — open the Tencent HY console, accept the terms and activate the service";
const MSG_INSUFFICIENT = "Tencent Cloud reports insufficient resources (credits may be used up, or capacity is short)";

const isCamDenied = (code: string) => code === "AuthFailure.UnauthorizedOperation" || code === "UnauthorizedOperation";
const isBillingCode = (code: string) => BILLING_CODES.has(code) || BILLING_CODE_PARTS.test(code);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Maps a Tencent error (Response.Error) to a user-safe ProviderError. */
function tencentError(code: string, rawMessage: string, phase: "submit" | "poll", secrets: string[]): ProviderError {
    const message = scrub(rawMessage, secrets);
    return phase === "poll" ? pollError(code, message) : submitError(code, message);
}

/** A submit that fails here did not create a job (Tencent answered with an error), so the user may simply try again. */
function submitError(code: string, message: string): ProviderError {
    if (code === "AuthFailure.SignatureExpire") return new ProviderError(MSG_CLOCK, 502);
    if (isCamDenied(code)) return new ProviderError(MSG_CAM, 502);
    if (code.startsWith("AuthFailure")) return new ProviderError(MSG_KEY, 502);
    if (code.startsWith("RequestLimitExceeded")) {
        return new ProviderError("Rate limited by Tencent Cloud — too many requests. Wait a moment and try again.", 429);
    }
    if (code === "ResourceInsufficient") return new ProviderError(MSG_INSUFFICIENT, 502);
    if (isBillingCode(code)) return new ProviderError(MSG_CREDITS, 502);
    if (HICCUP_CODES.has(code)) return new ProviderError(`Tencent Cloud had a server error (${code}). Try again in a moment.`, 502);
    if (code.startsWith("FailedOperation") && BILLING_WORDS.test(message)) return new ProviderError(MSG_CREDITS, 502);
    if (
        code.startsWith("ResourceUnavailable") ||
        code === "FailedOperation.ServiceNotActivated" ||
        code === "FailedOperation.ServiceStop" ||
        ACTIVATION_WORDS.test(message)
    ) {
        return new ProviderError(MSG_ACTIVATE, 502);
    }
    return new ProviderError(
        `Tencent Cloud error ${code}${message ? `: ${message}` : ""}`,
        code.startsWith("InvalidParameter") || code === "MissingParameter" ? 422 : 502,
    );
}

/**
 * While polling the job already exists and is paid for, and Tencent keeps running it whatever this answer says, so
 * only a definite answer fails it at once: drained credits, or a request the API rejects as malformed. Answers that
 * could be real but also a blip (a rejected key, a missing job) are retried a few times first, and everything else,
 * including codes nobody has seen, is retried until MAX_TRANSIENT_POLLS (guardPoll) or the engine's runtime cap.
 */
function pollError(code: string, message: string): ProviderError {
    // Only the documented codes: guessing from a code's name is fine for a submit, not for a job that is paid for.
    if (BILLING_CODES.has(code)) return new ProviderError(MSG_CREDITS, 502);
    if (code.startsWith("InvalidParameter") || code === "MissingParameter") {
        return new ProviderError(`Tencent Cloud error ${code}${message ? `: ${message}` : ""}`, 422);
    }
    if (code === "AuthFailure.SignatureExpire") return new ProviderError(`${MSG_CLOCK}, retrying…`, 502, true);
    if (isCamDenied(code)) return new ProviderError(`${MSG_CAM}, retrying…`, 502, true, { kind: code, max: 3 });
    if (code.startsWith("AuthFailure")) {
        const rejected = ["AuthFailure.SecretIdNotFound", "AuthFailure.InvalidSecretId", "AuthFailure.SignatureFailure"].includes(code);
        return new ProviderError(`${MSG_KEY}, retrying…`, 502, true, rejected ? { kind: code, max: 3 } : null);
    }
    if (code.startsWith("ResourceNotFound")) {
        return new ProviderError("Tencent Cloud cannot find this job (ResourceNotFound), retrying…", 502, true, {
            kind: "ResourceNotFound",
            max: 5,
        });
    }
    if (code.startsWith("RequestLimitExceeded")) return new ProviderError("Rate limited, retrying…", 429, true);
    if (HICCUP_CODES.has(code)) return new ProviderError(`Tencent Cloud is having trouble (${code}), retrying…`, 502, true);
    const detail = message ? `: ${clip(message, 80)}` : "";
    return new ProviderError(`Tencent Cloud reported an error (${code}${detail}), retrying…`, 502, true);
}

// ---------------------------------------------------------------------------------------------------------
// One signed call
// ---------------------------------------------------------------------------------------------------------

async function callTencent(
    env: Env,
    action: string,
    region: string,
    body: Json,
    phase: "submit" | "poll",
): Promise<Json> {
    const secretId = requireKey(env.TENCENTCLOUD_SECRET_ID, "TENCENTCLOUD_SECRET_ID");
    const secretKey = requireKey(env.TENCENTCLOUD_SECRET_KEY, "TENCENTCLOUD_SECRET_KEY");
    const secrets = [secretId, secretKey];
    const payload = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const contentType = "application/json";
    const { authorization } = await signTc3Request({ secretId, secretKey, service: SERVICE, host: HOST, timestamp, payload, contentType });

    let status: number;
    let text: string;
    try {
        const res = await fetch(`https://${HOST}/`, {
            method: "POST",
            headers: {
                "Content-Type": contentType,
                Authorization: authorization,
                "X-TC-Action": action,
                "X-TC-Version": VERSION,
                "X-TC-Region": region,
                "X-TC-Timestamp": String(timestamp),
                "X-TC-Language": "en-US", // keeps Error.Message in English; not a signed header, so it is safe to add
            },
            body: payload,
            signal: AbortSignal.timeout(phase === "submit" ? SUBMIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
        });
        status = res.status;
        text = await res.text();
    } catch (err) {
        const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
        if (phase === "submit") {
            // The request may have been accepted before the reply was lost. The API has no idempotency token, so
            // saying "try again" here would invite a second paid job.
            throw new ProviderError(
                `${timedOut ? "Tencent Cloud did not answer in time." : "Lost contact with Tencent Cloud."} ${MAY_HAVE_STARTED}`,
                timedOut ? 504 : 502,
                true,
            );
        }
        throw new ProviderError(
            timedOut ? "Tencent Cloud did not answer in time" : "Could not reach Tencent Cloud",
            timedOut ? 504 : 502,
            true,
        );
    }

    let response: Json | null = null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && isRecord(parsed.Response)) response = parsed.Response;
    } catch {
        // not JSON (a proxy's HTML error page, an empty body): handled below
    }
    if (!response) {
        // No Response envelope: a proxy's error page or a garbled reply. At submit a 5xx may mean the job was created
        // behind it (ambiguous, like a timeout); while polling nothing is lost by asking again, whatever the status.
        if (phase === "poll") {
            const what = status >= 500 ? "is having trouble" : "sent an unexpected reply";
            throw new ProviderError(`Tencent Cloud ${what} (${status}), retrying…`, 502, true);
        }
        throw status >= 500
            ? new ProviderError(`Tencent Cloud had a server error (${status}). ${MAY_HAVE_STARTED}`, 502, true)
            : new ProviderError(`Tencent Cloud sent an unexpected reply (${status})`, 502);
    }
    if (isRecord(response.Error)) {
        throw tencentError(asString(response.Error.Code) ?? "Unknown", asString(response.Error.Message) ?? "", phase, secrets);
    }
    return response;
}

// ---------------------------------------------------------------------------------------------------------
// Result files
// ---------------------------------------------------------------------------------------------------------

interface ResultFile {
    type: string; // as reported: "GLB", "OBJ", "Image", ... ("" when missing)
    url: string; // https
    preview: string | null; // https
}

const toHttps = (url: string): string => url.replace(/^http:\/\//i, "https://");

function readFiles(value: unknown): ResultFile[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): ResultFile[] => {
        const url = isRecord(item) ? asString(item.Url) : null;
        if (!isRecord(item) || url === null) return [];
        const preview = asString(item.PreviewImageUrl);
        return [{ type: asString(item.Type) ?? "", url: toHttps(url), preview: preview === null ? null : toHttps(preview) }];
    });
}

function extensionOf(url: string): string {
    let path = url;
    try {
        path = new URL(url).pathname; // the extension of the path only, never of the query
    } catch {
        // not parseable: judge the raw string
    }
    return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** The GLB entry: Type "GLB" in any case, or a file whose path ends in .glb. */
function pickGlb(files: ResultFile[]): ResultFile | null {
    return (
        files.find((f) => f.url.startsWith("https://") && (f.type.toUpperCase() === "GLB" || extensionOf(f.url) === "glb")) ?? null
    );
}

/** "OBJ, Image" for the failure message. */
function describeFormats(files: ResultFile[]): string {
    const names = files.map((f) => f.type || extensionOf(f.url).toUpperCase() || "unknown");
    return [...new Set(names)].join(", ");
}

// ---------------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------------

function regionOf(state: AdapterState): string {
    const region = isRecord(state) ? asString(state.region) : null;
    return region !== null && /^[a-z0-9-]{3,32}$/.test(region) ? region : REGION;
}

/** One QueryHunyuanTo3DProJob call, as a PollResult. Throws ProviderError; guardPoll decides what a throw means. */
async function queryJob(env: Env, taskId: string, state: AdapterState): Promise<PollResult> {
    const reply = await callTencent(env, "QueryHunyuanTo3DProJob", regionOf(state), { JobId: taskId }, "poll");
    switch (reply.Status) {
        case "WAIT":
            return { status: "queued", stage: withPromptNote("In queue", state) };
        case "RUN":
            return { status: "running", stage: withPromptNote("Generating 3D model", state) };
        case "FAIL": {
            const secrets = [env.TENCENTCLOUD_SECRET_ID?.trim() ?? "", env.TENCENTCLOUD_SECRET_KEY?.trim() ?? ""];
            const message = scrub(asString(reply.ErrorMessage) ?? asString(reply.ErrorCode) ?? "", secrets);
            return {
                status: "failed",
                error: `Hunyuan 3D could not generate this model${message ? `: ${message}` : "."}`,
            };
        }
        case "DONE": {
            const files = readFiles(reply.ResultFile3Ds);
            // DONE can arrive a moment before the file list is filled in; a retryable throw polls again
            // (guardPoll and the engine's error budget cap it) instead of failing a model that was paid for.
            if (files.length === 0) {
                throw new ProviderError("Hunyuan 3D finished; waiting for its files…", 502, true);
            }
            const glb = pickGlb(files);
            if (!glb) {
                return {
                    status: "failed",
                    error: `Hunyuan 3D finished but returned no GLB file (received: ${describeFormats(files)}).`,
                };
            }
            const thumbnailUrl = glb.preview ?? files.find((f) => f.preview !== null)?.preview ?? null;
            return { status: "succeeded", glbUrl: glb.url, thumbnailUrl };
        }
        default:
            // An unknown status is most likely a transient API hiccup: keep polling, guardPoll caps it.
            throw new ProviderError("Tencent Cloud returned an unknown task status, retrying…", 502, true);
    }
}

export const tencentHunyuan: ProviderAdapter = {
    via: "tencent",

    async submit(env: Env, rawPrompt: string): Promise<SubmitResult> {
        const { prompt, trimmedTo } = preparePrompt(rawPrompt, PROMPT_LIMIT);
        const reply = await callTencent(
            env,
            "SubmitHunyuanTo3DProJob",
            REGION,
            { Prompt: prompt, Model: MODEL, GenerateType: GENERATE_TYPE, EnablePBR: false },
            "submit",
        );
        const jobId = asString(reply.JobId);
        if (!jobId) throw new ProviderError(`Tencent Cloud accepted the request but returned no job id. ${MAY_HAVE_STARTED}`, 502, true);
        return {
            taskId: jobId,
            state: { region: REGION, model: MODEL, ...(trimmedTo !== null ? { prompt_trimmed_to: trimmedTo } : {}) },
        };
    },

    poll(env, taskId, state): Promise<PollResult> {
        return guardPoll(state, () => queryJob(env, taskId, state), { maxTransient: MAX_TRANSIENT_POLLS });
    },
};
