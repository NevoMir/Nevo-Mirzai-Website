// Uploading the research (founder only; scripts/outreach/upload-data.mjs drives it with the owner key):
//   PUT  /api/outreach/admin/blob/<file>?version=V   one research file, streamed into KV as data/V/<file> (never parsed here)
//   POST /api/outreach/admin/contacts                 up to 25 research records per call into D1 (full record + compact projection)
//   POST /api/outreach/admin/commit                   switch the live data to version V and store the law rules and templates
//   GET  /api/outreach/admin/erased                   the people the founder erased, so the script leaves them out of the files
// Statuses, sends, claims and the log are never touched by an upload.

import { HttpError, isRecord, readJsonObject } from "../util.ts";
import type { Actor } from "./auth.ts";
import { apiError, json } from "./http.ts";
import { logStatement, metaWrite } from "./store.ts";
import type { OutreachEnv } from "./types.ts";

const FILES = new Set(["contacts.json", "messages.json", "playbook.json"]);
const VERSION_RE = /^[a-z0-9-]{6,64}$/;
const MAX_FILE = 16 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;

/** The fields an email is composed from, plus what a compact list shows. Everything else stays in `data`. */
const MAIL_FIELDS = [
    "id", "name", "first_name", "salutation", "role", "company", "company_short", "company_id", "company_url", "kind", "segment",
    "region", "country", "city", "sector", "lang", "email", "generic_email", "email_status", "email_source_url", "email_evidence",
    "hook", "angle", "subject", "batch", "rank", "is_primary", "notes", "channel_note", "best_channel", "role_confidence",
    "linkedin_url", "contact_form_url", "switchboard", "fit", "hardware_level", "summary",
];

export async function handleAdmin(request: Request, env: OutreachEnv, actor: Actor, path: string): Promise<Response> {
    const db = env.OUTREACH_DB as D1Database;
    const url = new URL(request.url);
    const now = new Date().toISOString();

    if (request.method === "PUT" && path.startsWith("/blob/")) {
        const name = path.slice("/blob/".length);
        const version = url.searchParams.get("version") || "";
        if (!FILES.has(name)) return apiError(400, "Unknown file");
        if (!VERSION_RE.test(version)) return apiError(400, "version must be 6 to 64 lowercase letters, digits or dashes");
        if (!env.OUTREACH_KV) return apiError(503, "The KV namespace OUTREACH_KV is not bound.");
        const size = Number(request.headers.get("Content-Length"));
        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE) return apiError(413, "Send the file with a Content-Length of at most 16 MB.");
        if (!request.body) return apiError(400, "Empty body");
        await env.OUTREACH_KV.put(`data/${version}/${name}`, request.body);
        return json({ stored: `data/${version}/${name}`, bytes: size });
    }

    if (request.method === "GET" && path === "/erased") {
        const { results } = await db.prepare("SELECT id FROM contacts WHERE erased_at IS NOT NULL").all<{ id: string }>();
        return json({ erased: results.map((r) => r.id) });
    }

    if (request.method === "POST" && path === "/contacts") {
        const body = await readJsonObject(request, 1024 * 1024);
        const version = String(body.version || "");
        if (!VERSION_RE.test(version)) throw new HttpError(400, "Invalid version");
        const law = isRecord(body.law) ? (body.law as Record<string, string>) : {};
        const list = Array.isArray(body.contacts) ? body.contacts : [];
        if (!list.length || list.length > 25) throw new HttpError(400, "Send 1 to 25 contacts per call");
        const rows = list.map((c) => {
            if (!isRecord(c) || typeof c.id !== "string" || !ID_RE.test(c.id) || typeof c.company_id !== "string" || typeof c.country !== "string")
                throw new HttpError(400, "Each contact needs id, company_id and country");
            const mail: Record<string, unknown> = {};
            for (const k of MAIL_FIELDS) if (c[k] !== undefined) mail[k] = c[k];
            if (isRecord(c.check)) mail.check = { role_status: c.check.role_status };
            const level = law[c.country as string];
            return {
                id: c.id,
                rank: Number(c.rank) || 0,
                batch: Number(c.batch) || 0,
                company_id: c.company_id,
                country: c.country,
                is_primary: c.is_primary ? 1 : 0,
                has_address: c.email || c.generic_email ? 1 : 0,
                // A country the law research has not covered is treated with caution: agents leave it to the founder.
                law_level: level === "ok" || level === "consent" || level === "caution" ? level : "caution",
                mail: JSON.stringify(mail),
                data: JSON.stringify(c),
            };
        });
        const res = await db
            .prepare(
                `INSERT INTO contacts (id, rank, batch, company_id, country, is_primary, has_address, law_level, mail, data, data_version)
                 SELECT value->>'$.id', value->>'$.rank', value->>'$.batch', value->>'$.company_id', value->>'$.country', value->>'$.is_primary',
                        value->>'$.has_address', value->>'$.law_level', value->>'$.mail', value->>'$.data', ?1
                 FROM json_each(?2) WHERE true
                 ON CONFLICT(id) DO UPDATE SET rank = excluded.rank, batch = excluded.batch, company_id = excluded.company_id, country = excluded.country,
                   is_primary = excluded.is_primary, has_address = excluded.has_address, law_level = excluded.law_level, mail = excluded.mail,
                   data = excluded.data, data_version = excluded.data_version
                 WHERE contacts.erased_at IS NULL`,
            )
            .bind(version, JSON.stringify(rows))
            .run();
        return json({ upserted: res.meta.changes ?? 0 });
    }

    if (request.method === "POST" && path === "/commit") {
        const body = await readJsonObject(request, 1024 * 1024);
        const version = String(body.version || "");
        if (!VERSION_RE.test(version)) throw new HttpError(400, "Invalid version");
        const research = body.research;
        if (!isRecord(research) || !Array.isArray(research.law) || !isRecord(research.messages) || !isRecord(research.messages.emails))
            throw new HttpError(400, "research must hold law (the law rules) and messages (messages.json)");
        if (env.OUTREACH_KV) {
            for (const f of FILES) {
                const head = await env.OUTREACH_KV.get(`data/${version}/${f}`, "stream");
                if (!head) return apiError(409, `Upload data/${version}/${f} before committing.`);
                await head.cancel();
            }
        }
        const counts = await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE data_version = ? AND erased_at IS NULL").bind(version).first<{ n: number }>();
        const stale = await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE data_version != ? AND erased_at IS NULL").bind(version).first<{ n: number }>();
        await db.batch([
            // People no longer in the research leave the list; their status stays, in case they come back.
            db.prepare("DELETE FROM contacts WHERE data_version != ? AND erased_at IS NULL").bind(version),
            ...metaWrite(db, "research", { law: research.law, messages: research.messages, checklist: research.checklist ?? [], cadence: research.cadence ?? [] }, actor.name, now),
            ...metaWrite(db, "data", { version, count: counts?.n ?? 0, uploaded_at: now }, actor.name, now),
            logStatement(db, now, actor.name, null, "data_upload", { version, people: counts?.n ?? 0, removed: stale?.n ?? 0 }),
        ]);
        // Older uploads go, so an erased person or an old address does not linger in storage.
        let deleted = 0;
        if (env.OUTREACH_KV) {
            let cursor: string | undefined;
            do {
                const page: KVNamespaceListResult<unknown> = await env.OUTREACH_KV.list({ prefix: "data/", cursor });
                for (const k of page.keys) {
                    if (!k.name.startsWith(`data/${version}/`)) {
                        await env.OUTREACH_KV.delete(k.name);
                        deleted++;
                    }
                }
                cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor && deleted < 300);
        }
        return json({ live: version, people: counts?.n ?? 0, removed_from_list: stale?.n ?? 0, old_files_deleted: deleted });
    }

    return apiError(404, "No such admin endpoint.");
}
