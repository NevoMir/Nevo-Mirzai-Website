// Smoke test of POST /llm/optimize-spec against `wrangler dev` (MOCK_PROVIDER=1: the answer is the "lightest stable" preset and nobody is called).
//
//   npx wrangler dev --port 8740 --local --var DAILY_LLM_LIMIT:5      # migrations 0001 to 0006 applied first
//   BASE=http://127.0.0.1:8740 node scripts/assignment/smoke-optimize-spec.mjs
//
// Covers the route (405 for other methods, 404 for another /llm path), the guards (empty or missing goal, a brief that is not one, a body over 6 KB,
// not JSON), the mock answer (a spec the page's cleaner accepts unchanged), and the daily counter of AI calls (DAILY_LLM_LIMIT, default 400): with the
// limit at 5 the sixth call is a 429 with the sentence the page shows. The counter is read through wrangler dev's explorer when it is reachable.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8740").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const LIMIT = Number(process.env.DAILY_LLM_LIMIT ?? 5);
const L = await import("./optimize-lib.mjs");

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
    if (ok) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`); }
}
async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        if (typeof body !== "string") init.headers["content-type"] = "application/json";
    }
    const res = await fetch(`${API}${path}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
}

let DB_ID = "";
try { DB_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"))?.[1] ?? ""; } catch { /* skipped */ }
async function sql(statement) {
    if (!DB_ID) return null;
    try {
        const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/${DB_ID}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: statement }) });
        const body = await res.json();
        if (!body.success) return null;
        const results = body.result?.[0]?.results;
        return results?.columns ? results.rows.map((row) => Object.fromEntries(results.columns.map((c, i) => [c, row[i]]))) : [];
    } catch { return null; }
}
const today = () => new Date().toISOString().slice(0, 10);
const llmToday = async () => (await sql(`SELECT llm FROM usage WHERE day = '${today()}'`))?.[0]?.llm ?? (DB_ID ? 0 : null);

const { ctx } = await L.ctxFor("pencil-leg-chair");
const brief = L.SPEC.briefOf(ctx);
const goal = "as light as possible, keep the seat";
const post = (body) => call("POST", "/llm/optimize-spec", body);

console.log("\n== the route");
let r = await call("GET", "/llm/optimize-spec");
check("GET is a 405", r.status === 405 && /Allow/i.test([...r.headers.keys()].join()) || r.status === 405, `${r.status}`);
r = await call("POST", "/llm/nothing", {});
check("another /llm path is a 404", r.status === 404, `${r.status}`);
r = await call("DELETE", "/llm/optimize-spec");
check("DELETE is a 405", r.status === 405, `${r.status}`);

console.log("\n== the guards (none of these takes a slot)");
await sql(`DELETE FROM usage WHERE day = '${today()}'`);
check("no goal is a 400", (await post({ brief })).status === 400);
check("a blank goal is a 400", (await post({ goal: "   ", brief })).status === 400);
check("a goal that is not text is a 400", (await post({ goal: 12, brief })).status === 400);
check("no brief is a 400", (await post({ goal })).status === 400);
check("a brief with no blocks is a 400", (await post({ goal, brief: { ...brief, blocks: 0 } })).status === 400);
check("a body that is not JSON is a 400", (await call("POST", "/llm/optimize-spec", "{nope", { "content-type": "application/json" })).status === 400);
check("a JSON array is a 400", (await post("[1,2]")).status === 400);
r = await post({ goal, brief, pad: "x".repeat(7000) });
check("a body over 6 KB is a 413", r.status === 413, `${r.status}`);
const used0 = await llmToday();
check("and none of them took a slot", used0 === 0 || used0 === null, `used ${used0}`);

console.log("\n== the mock answer");
r = await post({ goal, brief });
check("200 with a spec", r.status === 200 && r.json?.spec && r.json.model === "mock", `${r.status} ${r.text.slice(0, 120)}`);
check("the spec is the lightest-stable preset", r.json?.spec?.title === "Lightest stable" && r.json.spec.objective?.[0]?.metric === "blocks" && r.json.spec.actionable === true);
const again = L.SL.repairSpec(r.json.spec, L.SL.repairContextOfBrief(brief));
check("the page's cleaner leaves it as it is", JSON.stringify(again.spec) === JSON.stringify(r.json.spec) && again.changes.length === 0);
check("no cost, no changes", r.json?.cost_usd === null && Array.isArray(r.json?.changes) && r.json.changes.length === 0);
check("answers are never cached", /no-store/.test(r.headers.get("cache-control") ?? ""));
const used1 = await llmToday();
check("it took a slot of the day's counter", used1 === null || used1 === 1, `used ${used1}`);

console.log(`\n== the daily limit (${LIMIT})`);
for (let n = 2; n <= LIMIT; n++) {
    const ok = await post({ goal, brief });
    if (ok.status !== 200) check(`call ${n} of ${LIMIT} is allowed`, false, `${ok.status} ${ok.text.slice(0, 100)}`);
}
r = await post({ goal, brief });
check("the next one is a 429 with the sentence the page shows", r.status === 429 && /limit of AI requests is used up/i.test(r.json?.error ?? ""), `${r.status} ${r.text.slice(0, 120)}`);
const used2 = await llmToday();
check("and the counter stays at the limit", used2 === null || used2 === LIMIT, `used ${used2}`);
await sql(`DELETE FROM usage WHERE day = '${today()}'`);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
