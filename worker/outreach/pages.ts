// The pages under /client-outreach:
//   /client-outreach             the founder's page (Vite: client-outreach/index.html), or the sign-in form
//   /client-outreach/agent       the console for agents in a browser (Vite: client-outreach/agent.html)
//   /client-outreach/agents      the public guide for agents (and agents.md)
//   /client-outreach/login       POST: the owner key, once; sets the session cookie
//   /client-outreach/logout      POST
//   /client-outreach/s/<token>   a one-time link that starts an agent's browser session

import {
    actorFromRow,
    authenticate,
    checkOwnerKey,
    clearCookieHeader,
    currentEpoch,
    failureKey,
    isSameOriginRequest,
    keyIsLive,
    noteFailure,
    sessionCookieHeader,
    sha256Hex,
    tooManyFailures,
    type KeyRow,
} from "./auth.ts";
import { guideHtml, guideMarkdown } from "./guide.ts";
import { PAGE_CSP, escapeHtml, html, text, withPrivateHeaders } from "./http.ts";
import type { OutreachEnv } from "./types.ts";

export const BASE = "/client-outreach";

const STYLE = `
:root { --bg:#f3f5f4; --surface:#fff; --ink:#182020; --muted:#5c6866; --line:#dbe0de; --accent:#0d6668; --no:#b42318; --no-soft:#fbe2df; }
@media (prefers-color-scheme: dark) { :root { --bg:#111716; --surface:#19211f; --ink:#e4ebe8; --muted:#9aa7a3; --line:#2b3633; --accent:#4fb3ad; --no:#f2867c; --no-soft:#3a1d1a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 "Public Sans","Helvetica Neue",Arial,system-ui,sans-serif; }
main { max-width:760px; margin:0 auto; padding:40px 16px 64px; }
h1 { font:700 26px/1.2 "Bricolage Grotesque","Avenir Next",system-ui,sans-serif; margin:0 0 8px; }
h2 { font:700 19px/1.3 "Bricolage Grotesque","Avenir Next",system-ui,sans-serif; margin:28px 0 8px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:20px; margin:16px 0; }
label { display:block; font-weight:600; margin:0 0 6px; }
input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
button { margin-top:12px; padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:600 15px/1 inherit; cursor:pointer; }
.err { background:var(--no-soft); color:var(--no); border-radius:8px; padding:8px 12px; margin:0 0 12px; }
.muted { color:var(--muted); }
code, pre { font:13px/1.5 "IBM Plex Mono",ui-monospace,Menlo,monospace; }
pre { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto; }
table { border-collapse:collapse; margin:8px 0; font-size:14px; display:block; overflow-x:auto; }
th, td { border:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; }
a { color:var(--accent); }
`;

function shell(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(error = "", status = 200): Response {
    return html(
        shell(
            "Client outreach: sign in",
            `<h1>Client outreach</h1>
<p class="muted">Private. Sign in with your owner key.</p>
<form class="card" method="post" action="${BASE}/login">
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <label for="key">Owner key</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required minlength="32">
  <button type="submit">Sign in</button>
</form>
<div class="card"><strong>AI agents:</strong> do not type a key here. Read the guide at <a href="${BASE}/agents">${BASE}/agents</a>:
use an agent key in the Authorization header, or the one-time link the founder gives you.</div>`,
        ),
        status,
    );
}

async function servePage(env: OutreachEnv, request: Request, assetPath: string): Promise<Response> {
    const res = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), { method: "GET" }));
    if (!res.ok) return html(shell("Not built", "<h1>The page is not built</h1><p>Run <code>npm run build</code> before deploying.</p>"), 503);
    return withPrivateHeaders(res, { "Content-Security-Policy": PAGE_CSP });
}

const redirect = (to: string, cookie?: string): Response =>
    withPrivateHeaders(new Response(null, { status: 303, headers: { Location: to, ...(cookie ? { "Set-Cookie": cookie } : {}) } }));

async function readKeyField(request: Request): Promise<string> {
    const type = request.headers.get("Content-Type") || "";
    const raw = (await request.text()).slice(0, 4096);
    if (/application\/json/i.test(type)) {
        try {
            const v = JSON.parse(raw)?.key;
            return typeof v === "string" ? v.trim() : "";
        } catch {
            return "";
        }
    }
    return (new URLSearchParams(raw).get("key") || "").trim();
}

const sameOrigin = isSameOriginRequest;

export async function handlePages(request: Request, env: OutreachEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || BASE;
    const db = env.OUTREACH_DB as D1Database;
    const m = request.method;

    if (m === "GET" && path === `${BASE}/agents`) return html(shell("Client outreach: guide for AI agents", guideHtml(url.origin)));
    if (m === "GET" && path === `${BASE}/agents.md`) return text(guideMarkdown(url.origin), 200, "text/markdown; charset=utf-8");

    if (m === "POST" && path === `${BASE}/login`) {
        if (!sameOrigin(request)) return loginPage("Sign in from this page.", 403);
        // The owner key may be a passphrase a person chose, so guessing stops for 15 minutes after 20 misses from one
        // address, before the key is even checked. (Agent keys are 256 random bits: no lockout is needed for them.)
        const fk = failureKey("login", request);
        if (await tooManyFailures(db, fk)) return loginPage("Too many attempts. Wait 15 minutes.", 429);
        const key = await readKeyField(request);
        if (!key || !(await checkOwnerKey(env, key))) {
            await noteFailure(db, fk);
            return loginPage("That key is not right.", 401);
        }
        return redirect(BASE, await sessionCookieHeader(request, env, "owner", "owner", await currentEpoch(db)));
    }
    if (m === "POST" && path === `${BASE}/logout`) {
        if (!sameOrigin(request)) return text("Forbidden", 403);
        return redirect(BASE, clearCookieHeader(request));
    }

    const link = /^\/client-outreach\/s\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (link) return sessionLink(request, env, link[1]);

    if (m !== "GET" && m !== "HEAD") return text("Method not allowed", 405);
    const { actor } = await authenticate(request, env);
    if (path === BASE) {
        if (actor?.role === "owner") return servePage(env, request, `${BASE}/`);
        if (actor) return redirect(`${BASE}/agent`);
        return loginPage();
    }
    if (path === `${BASE}/agent`) {
        if (actor && actor.role !== "reply-check") return servePage(env, request, `${BASE}/agent`);
        return loginPage();
    }
    return html(shell("Not found", `<h1>Not found</h1><p><a href="${BASE}">Back</a></p>`), 404);
}

async function sessionLink(request: Request, env: OutreachEnv, token: string): Promise<Response> {
    const db = env.OUTREACH_DB as D1Database;
    const hash = await sha256Hex(token);
    const row = await db.prepare("SELECT key_id, expires_at, used_at FROM session_links WHERE token_hash = ?").bind(hash).first<{ key_id: string; expires_at: string; used_at: string | null }>();
    const usable = row && !row.used_at && new Date(row.expires_at) > new Date();
    const gone = () => html(shell("Link used or expired", "<h1>This link was used or has expired</h1><p>Ask the founder for a new one.</p>"), 410);
    if (!usable) return gone();
    const key = await db.prepare("SELECT * FROM agent_keys WHERE id = ?").bind(row.key_id).first<KeyRow>();
    if (!keyIsLive(key)) return gone();
    if (request.method === "GET" || request.method === "HEAD") {
        // A button, so a link preview (a chat app unfurling the URL) cannot use the link up.
        return html(
            shell(
                "Start the agent session",
                `<h1>Agent session for ${escapeHtml(key.name)}</h1>
<p class="muted">This opens the outreach console as the agent "${escapeHtml(key.name)}" for 12 hours. The link then stops working.</p>
<form class="card" method="post"><button type="submit">Start</button></form>`,
            ),
        );
    }
    if (request.method !== "POST" || !sameOrigin(request)) return text("Forbidden", 403);
    const res = await db.prepare("UPDATE session_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(new Date().toISOString(), hash).run();
    if (!res.meta.changes) return gone();
    const actor = actorFromRow(key, "cookie");
    await db
        .prepare("INSERT INTO log (at, actor, contact_id, action, detail) VALUES (?, ?, NULL, 'browser_session', ?)")
        .bind(new Date().toISOString(), actor.name, JSON.stringify({ key: key.id }))
        .run();
    return redirect(`${BASE}/agent`, await sessionCookieHeader(request, env, "agent", key.id, await currentEpoch(db)));
}
