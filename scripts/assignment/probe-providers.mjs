// Checks that the text-to-3D API keys work, using only FREE calls (no generation, no credits spent), and prints
// what each account can afford. Run it once after you have created the keys:
//
//   node --env-file=.dev.vars scripts/assignment/probe-providers.mjs
//   (or export FAL_KEY / TRIPO_API_KEY / MESHY_API_KEY in your shell first)
//
// Exit code: 0 when every key that is set works, 1 when a key is rejected, 2 when no key is set.
// Keys are only ever sent to the vendor's own API host and are never printed.
//
//   Tripo : GET https://openapi.tripo3d.com/v3/account/balance            (free)
//   Meshy : GET https://api.meshy.ai/openapi/v1/balance                    (free)
//   fal   : GET https://api.fal.ai/v1/account/billing?expand=credits       (free; needs a key with billing read access)
//           GET https://api.fal.ai/v1/models/pricing?endpoint_id=<id>      (free; any valid key, also shows live prices)

const TIMEOUT_MS = 20_000;

const FAL_ENDPOINTS = [
    ["Meshy 7.1", "meshy/v7.1/text-to-3d"],
    ["Rodin Gen-2.5", "fal-ai/hyper3d/rodin/v2.5/text-to-3d"],
    ["Hunyuan 3D 3.1 Pro", "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d"],
    ["Tripo H3.1", "tripo3d/h3.1/text-to-3d"],
];

async function get(url, authorization) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: authorization, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        let body = null;
        try {
            body = JSON.parse(text);
        } catch {
            // not JSON
        }
        return { status: res.status, body, text };
    } catch (err) {
        const reason = err?.name === "TimeoutError" ? "timed out" : (err?.cause?.code ?? err?.message ?? "network error");
        return { status: 0, body: null, text: String(reason) };
    }
}

const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "?");
const line = (label, text) => console.log(`  ${label.padEnd(10)} ${text}`);

function httpProblem(r) {
    if (r.status === 0) return `could not reach the API (${r.text})`;
    if (r.status === 401) return "key rejected (401): wrong key, or it was deleted";
    if (r.status === 402) return "payment required (402): the plan or credits do not allow API use";
    if (r.status === 403) return "forbidden (403): the key lacks access, or the account is out of credits";
    if (r.status === 429) return "rate limited (429): wait a minute and run the probe again";
    return `unexpected HTTP ${r.status}`;
}

// Each probe returns "ok" | "bad" | "unknown" (reachable but could not be verified).

async function probeTripo(key) {
    const r = await get("https://openapi.tripo3d.com/v3/account/balance", `Bearer ${key}`);
    if (r.status !== 200 || (r.body && r.body.code !== 0 && r.body.code !== undefined)) {
        line("Tripo", `FAIL  ${r.body?.message ?? httpProblem(r)}${r.body?.suggestion ? ` (${r.body.suggestion})` : ""}`);
        return "bad";
    }
    const { balance, frozen } = r.body?.data ?? {};
    line("Tripo", `OK    ${num(balance)} credits available, ${num(frozen)} frozen (1 credit = $0.01)`);
    if (typeof balance === "number") {
        line("", `enough for ~${Math.floor(balance / 30)} "Tripo H3.1 · Parts" runs (30 credits) or ~${Math.floor(balance / 20)} textured runs (20 credits)`);
        if (balance < 30) line("", "top up in the Tripo console before generating");
    }
    return "ok";
}

async function probeMeshy(key) {
    const r = await get("https://api.meshy.ai/openapi/v1/balance", `Bearer ${key}`);
    if (r.status !== 200) {
        line("Meshy", `FAIL  ${r.body?.message ?? httpProblem(r)}`);
        return "bad";
    }
    const { balance, monthly_credits: monthly, permanent_credits: permanent } = r.body ?? {};
    line("Meshy", `OK    ${num(balance)} credits (${num(monthly)} monthly + ${num(permanent)} permanent)`);
    if (typeof balance === "number") {
        line("", `enough for ~${Math.floor(balance / 30)} textured Meshy 7.1 runs (20 preview + 10 refine = 30 credits)`);
    }
    return "ok";
}

async function probeFal(key) {
    const auth = `Key ${key}`;
    const billing = await get("https://api.fal.ai/v1/account/billing?expand=credits", auth);
    let verdict = "unknown";
    if (billing.status === 200) {
        const credits = billing.body?.credits;
        line("fal.ai", `OK    balance ${credits ? `${num(credits.current_balance)} ${credits.currency ?? "USD"}` : "not reported"}`);
        verdict = "ok";
    } else if (billing.status === 401) {
        line("fal.ai", `FAIL  ${httpProblem(billing)}`);
        return "bad";
    } else if (billing.status === 403) {
        // Valid key without billing access; the pricing call below still proves it works.
        line("fal.ai", "key works but cannot read the balance (needs billing read access); check fal.ai/dashboard/billing");
    } else {
        line("fal.ai", `note  balance call returned ${httpProblem(billing)}`);
    }

    // Live per-run prices double as a free "is this key valid" check.
    for (const [label, endpoint] of FAL_ENDPOINTS) {
        const r = await get(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`, auth);
        if (r.status === 401) {
            line("fal.ai", `FAIL  ${httpProblem(r)}`);
            return "bad";
        }
        if (r.status !== 200) {
            line("", `${label.padEnd(20)} price unavailable (${httpProblem(r)})`);
            continue;
        }
        verdict = "ok";
        const price = Array.isArray(r.body?.prices) ? r.body.prices.find((p) => p.endpoint_id === endpoint) : null;
        line("", `${label.padEnd(20)} ${price ? `${price.currency ?? "USD"} ${price.unit_price} per ${price.unit}` : "no price listed"}`);
    }
    if (verdict === "unknown") line("fal.ai", "could not verify the key (see notes above)");
    return verdict;
}

async function main() {
    const env = process.env;
    const keys = {
        tripo: env.TRIPO_API_KEY?.trim(),
        meshy: env.MESHY_API_KEY?.trim(),
        fal: env.FAL_KEY?.trim(),
    };
    if (!keys.tripo && !keys.meshy && !keys.fal) {
        console.log("No keys found. Set FAL_KEY, TRIPO_API_KEY and/or MESHY_API_KEY (for example in .dev.vars) and run:");
        console.log("  node --env-file=.dev.vars scripts/assignment/probe-providers.mjs");
        return 2;
    }

    console.log("Probing with free calls only (nothing is generated or charged):\n");
    const results = {};
    if (keys.tripo) results.tripo = await probeTripo(keys.tripo);
    else line("Tripo", "skipped  TRIPO_API_KEY is not set");
    if (keys.meshy) results.meshy = await probeMeshy(keys.meshy);
    else line("Meshy", "skipped  MESHY_API_KEY is not set");
    if (keys.fal) results.fal = await probeFal(keys.fal);
    else line("fal.ai", "skipped  FAL_KEY is not set");

    // What the app will offer with these keys, using the real routing table.
    try {
        const { listProviders } = await import("../../worker/providers/index.ts");
        const working = {
            TRIPO_API_KEY: results.tripo === "ok" ? "set" : undefined,
            MESHY_API_KEY: results.meshy === "ok" ? "set" : undefined,
            FAL_KEY: results.fal === "ok" ? "set" : undefined,
        };
        console.log("\nModels the app would offer with the working keys:");
        for (const p of listProviders(working)) {
            line(p.available ? "available" : "-", `${p.label}${p.available ? `  via ${p.via}` : "  (needs another key)"}`);
        }
    } catch {
        // the summary is a nicety: it needs Node to import the .ts sources (22.18+)
    }

    const bad = Object.values(results).includes("bad");
    console.log(bad ? "\nAt least one key was rejected." : "\nAll keys that are set look good.");
    return bad ? 1 : 0;
}

process.exitCode = await main();
