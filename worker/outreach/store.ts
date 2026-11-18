// D1 access for the client-outreach routes. Writes go through applyPatches: one atomic batch of a fixed number of statements,
// whatever the number of people, because the free plan allows 50 queries per request and 100 bound values per statement
// (the ids and patches travel as one JSON value and are unpacked with json_each).

import type { Contact, LawRule, Messages, Settings, StatusDoc } from "../../src/client-outreach/shared/core.ts";

/** The parts of the research the API needs, stored as meta/research at upload. */
export interface Research {
    law: LawRule[];
    messages: Messages;
    /** playbook.law.checklist: what every email must have. */
    checklist?: string[];
    /** playbook.email.cadence: the sending rhythm and when to stop. */
    cadence?: string[];
}

export async function metaJson<T>(db: D1Database, key: string): Promise<T | null> {
    const row = await db.prepare("SELECT data FROM meta WHERE key = ?").bind(key).first<{ data: string }>();
    if (!row) return null;
    try {
        return JSON.parse(row.data) as T;
    } catch {
        return null;
    }
}

export async function settingsOf(db: D1Database): Promise<Settings> {
    return (await metaJson<Settings>(db, "settings")) || {};
}

export async function researchOf(db: D1Database): Promise<Research | null> {
    const r = await metaJson<Research>(db, "research");
    return r && Array.isArray(r.law) && r.messages && r.messages.emails ? r : null;
}

/** Statements that bump the global revision and replace one meta document. */
export function metaWrite(db: D1Database, key: string, data: unknown, actor: string, now: string): D1PreparedStatement[] {
    return [
        db.prepare("UPDATE counter SET value = value + 1 WHERE name = 'rev'"),
        db
            .prepare(
                `INSERT INTO meta (key, data, rev, updated_at, updated_by) VALUES (?1, ?2, (SELECT value FROM counter WHERE name = 'rev'), ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            )
            .bind(key, JSON.stringify(data), now, actor),
    ];
}

export const logStatement = (db: D1Database, now: string, actor: string, contactId: string | null, action: string, detail: unknown): D1PreparedStatement =>
    db.prepare("INSERT INTO log (at, actor, contact_id, action, detail) VALUES (?, ?, ?, ?, ?)").bind(now, actor, contactId, action, detail === undefined ? null : JSON.stringify(detail));

export interface PatchItem {
    id: string;
    patch: Partial<StatusDoc>;
    /** A short note for the log: never an address or email text. */
    detail?: unknown;
    /** Apply only if the document is still at this version (0 = it did not exist): for read-modify-write fields. */
    version?: number;
}

/**
 * Merges patches into the status documents in one atomic batch. A field set to null is removed; an object field (custom,
 * meeting, lastReply) is replaced whole, not merged, the way the claude.ai page's database worked.
 */
export function patchStatements(db: D1Database, items: PatchItem[], actor: string, action: string, now: string): D1PreparedStatement[] {
    if (!items.length) return [];
    const payload = JSON.stringify(
        items.map((it) => {
            const nulls: Record<string, null> = {};
            for (const [k, v] of Object.entries(it.patch)) if (v && typeof v === "object" && !Array.isArray(v)) nulls[k] = null;
            return { id: it.id, nulls, patch: it.patch, v: it.version ?? null, detail: it.detail === undefined ? null : JSON.stringify(it.detail) };
        }),
    );
    return [
        db.prepare("UPDATE counter SET value = value + 1 WHERE name = 'rev'"),
        db.prepare("INSERT OR IGNORE INTO status (id, data, version, rev, updated_at, updated_by) SELECT value->>'$.id', '{}', 0, 0, ?1, ?2 FROM json_each(?3)").bind(now, actor, payload),
        db
            .prepare(
                `UPDATE status SET data = json_patch(json_patch(status.data, j.nulls), j.patch), version = status.version + 1,
                   rev = (SELECT value FROM counter WHERE name = 'rev'), updated_at = ?1, updated_by = ?2
                 FROM (SELECT value->>'$.id' AS id, value->>'$.nulls' AS nulls, value->>'$.patch' AS patch, value->>'$.v' AS v FROM json_each(?3)) AS j
                 WHERE status.id = j.id AND (j.v IS NULL OR status.version = j.v)`,
            )
            .bind(now, actor, payload),
        db.prepare("INSERT INTO log (at, actor, contact_id, action, detail) SELECT ?1, ?2, value->>'$.id', ?4, value->>'$.detail' FROM json_each(?3)").bind(now, actor, payload, action),
    ];
}

/**
 * One conditional UPDATE per document, for read-modify-write fields (the replies list): each applies only if the document is
 * still at the version it was read at, and the batch result of each statement says exactly which ones won. At most 40 items,
 * because the free plan allows 50 queries per request. Returns the statements and the index of the first UPDATE.
 */
export function pinnedStatements(db: D1Database, items: (PatchItem & { version: number })[], actor: string, now: string): { statements: D1PreparedStatement[]; first: number } {
    if (items.length > 40) throw new Error("pinnedStatements: at most 40 items");
    const ids = JSON.stringify(items.map((it) => ({ id: it.id })));
    const statements: D1PreparedStatement[] = [
        db.prepare("UPDATE counter SET value = value + 1 WHERE name = 'rev'"),
        db.prepare("INSERT OR IGNORE INTO status (id, data, version, rev, updated_at, updated_by) SELECT value->>'$.id', '{}', 0, 0, ?1, ?2 FROM json_each(?3)").bind(now, actor, ids),
    ];
    const first = statements.length;
    for (const it of items) {
        const nulls: Record<string, null> = {};
        for (const [k, v] of Object.entries(it.patch)) if (v && typeof v === "object" && !Array.isArray(v)) nulls[k] = null;
        statements.push(
            db
                .prepare(
                    `UPDATE status SET data = json_patch(json_patch(data, ?1), ?2), version = version + 1, rev = (SELECT value FROM counter WHERE name = 'rev'),
                       updated_at = ?3, updated_by = ?4 WHERE id = ?5 AND version = ?6`,
                )
                .bind(JSON.stringify(nulls), JSON.stringify(it.patch), now, actor, it.id, it.version),
        );
    }
    return { statements, first };
}

export interface StoredDoc {
    doc: StatusDoc;
    version: number;
}

export async function readDocs(db: D1Database, ids: string[]): Promise<Map<string, StoredDoc>> {
    const out = new Map<string, StoredDoc>();
    if (!ids.length) return out;
    const { results } = await db.prepare("SELECT id, data, version FROM status WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ id: string; data: string; version: number }>();
    for (const r of results) out.set(r.id, { doc: parseDoc(r.data), version: r.version });
    return out;
}

export function parseDoc(text: string | null | undefined): StatusDoc {
    if (!text) return {};
    try {
        const d = JSON.parse(text);
        return d && typeof d === "object" && !Array.isArray(d) ? d : {};
    } catch {
        return {};
    }
}

export interface ContactRow {
    id: string;
    company_id: string;
    country: string;
    law_level: string;
    is_primary: number;
    has_address: number;
    mail: string;
    erased_at: string | null;
}

/** The compact contact (the fields an email is composed from), with the status document when asked. */
export interface Person {
    c: Contact;
    row: ContactRow;
    st: StatusDoc;
    version: number;
}

export async function readPeople(db: D1Database, ids: string[]): Promise<Map<string, Person>> {
    const out = new Map<string, Person>();
    if (!ids.length) return out;
    const { results } = await db
        .prepare(
            `SELECT c.id, c.company_id, c.country, c.law_level, c.is_primary, c.has_address, c.mail, c.erased_at, s.data AS st, s.version AS version
             FROM contacts c LEFT JOIN status s ON s.id = c.id WHERE c.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(ids))
        .all<ContactRow & { st: string | null; version: number | null }>();
    for (const r of results) out.set(r.id, { c: JSON.parse(r.mail) as Contact, row: r, st: parseDoc(r.st), version: r.version ?? 0 });
    return out;
}

/**
 * Everyone at these companies, with their status: the company-level rules need the colleagues. Erased people count too
 * (only their status is left), so a stop request keeps protecting the rest of the company after the person is erased.
 */
export async function readCompanies(db: D1Database, companyIds: string[]): Promise<Map<string, Person[]>> {
    const out = new Map<string, Person[]>();
    if (!companyIds.length) return out;
    const { results } = await db
        .prepare(
            `SELECT c.id, c.company_id, c.country, c.law_level, c.is_primary, c.has_address, c.mail, c.erased_at, s.data AS st, s.version AS version
             FROM contacts c LEFT JOIN status s ON s.id = c.id
             WHERE c.company_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify([...new Set(companyIds)]))
        .all<ContactRow & { st: string | null; version: number | null }>();
    for (const r of results) {
        const c = JSON.parse(r.mail) as Contact;
        if (r.erased_at) Object.assign(c, { name: "someone (erased at their request)", company_id: r.company_id, country: r.country });
        const p: Person = { c, row: r, st: parseDoc(r.st), version: r.version ?? 0 };
        const list = out.get(r.company_id) || [];
        list.push(p);
        out.set(r.company_id, list);
    }
    return out;
}

export async function currentRev(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT value FROM counter WHERE name = 'rev'").first<{ value: number }>();
    return row ? row.value : 0;
}

/**
 * What changed since revision `since`, as JSON text built from the stored documents without parsing them:
 * {"rev":N,"status":{"<id>":{"doc":{...},"v":3,"by":"you","at":"..."}},"meta":{"settings":{...}},"claims":[...],"erased":[{id, company_id}]}.
 * Erased people keep their company, so the page still holds the rest of the company back after a stop request.
 */
export async function stateText(db: D1Database, since: number): Promise<string> {
    const [rev, docs, metas, claims, erased] = await db.batch<Record<string, unknown>>([
        db.prepare("SELECT value FROM counter WHERE name = 'rev'"),
        db.prepare("SELECT id, data, version, updated_by, updated_at FROM status WHERE rev > ?").bind(since),
        db.prepare("SELECT key, data FROM meta WHERE rev > ? AND key IN ('settings', 'sync', 'data')").bind(since),
        db.prepare("SELECT contact_id, agent, which, state, until, created_at FROM claims WHERE state IN ('active', 'drafted')"),
        db.prepare("SELECT id, company_id FROM contacts WHERE erased_at IS NOT NULL"),
    ]);
    const revValue = Number((rev.results[0] as { value?: number } | undefined)?.value ?? 0);
    const statusParts = (docs.results as { id: string; data: string; version: number; updated_by: string; updated_at: string }[]).map(
        (r) => `${JSON.stringify(r.id)}:{"doc":${r.data},"v":${r.version},"by":${JSON.stringify(r.updated_by)},"at":${JSON.stringify(r.updated_at)}}`,
    );
    const metaParts = (metas.results as { key: string; data: string }[]).map((r) => `${JSON.stringify(r.key)}:${r.data}`);
    return (
        `{"rev":${revValue},"since":${since},"status":{${statusParts.join(",")}},"meta":{${metaParts.join(",")}},` +
        `"claims":${JSON.stringify(claims.results)},"erased":${JSON.stringify(erased.results)}}`
    );
}

/** The newest log rows; `actor` limits them to one caller (an agent sees only what it did itself). */
export async function logRows(db: D1Database, limit: number, before: number | null, actor: string | null = null): Promise<unknown[]> {
    const stmt = db
        .prepare("SELECT seq, at, actor, contact_id, action, detail FROM log WHERE (?1 IS NULL OR seq < ?1) AND (?2 IS NULL OR actor = ?2) ORDER BY seq DESC LIMIT ?3")
        .bind(before, actor, limit);
    const { results } = await stmt.all<{ seq: number; at: string; actor: string; contact_id: string | null; action: string; detail: string | null }>();
    return results.map((r) => ({ ...r, detail: r.detail ? safeParse(r.detail) : null }));
}

const safeParse = (s: string): unknown => {
    try {
        return JSON.parse(s);
    } catch {
        return s;
    }
};

/** Keeps the log to its last 20,000 rows (checked now and then, never on reads). */
export function pruneLogStatement(db: D1Database): D1PreparedStatement {
    return db.prepare("DELETE FROM log WHERE seq < (SELECT MAX(seq) FROM log) - 20000");
}
