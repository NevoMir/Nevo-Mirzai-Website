// An in-process stand-in for the Worker's bindings, so the Worker's own code (worker/derived.ts, worker/versions.ts, worker/db.ts) can run in Node
// against the REAL migrations and the REAL SQL (SQLite via node:sqlite), with no wrangler: used by test-versions-backend.mjs.
//
//   const { env, sql, r2 } = createEnv();   // migrations 0001 to 0006 applied to an empty in-memory database
//
// DB follows the part of the D1 API the Worker uses: prepare(sql).bind(...).first() / all() / run() / raw(), and batch([...]) as one transaction
// (rolled back when a statement fails). FILES follows R2's put / get / head / delete (one key or a list) and records every delete.
// What it does NOT model: D1's network, its row limits, or two requests running at the same moment (statements here run one after another, as
// D1 runs them; a race between requests is therefore tested by the smoke test against wrangler dev, and by a stale-read stand-in here).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

class Statement {
    constructor(db, text, params = []) {
        this.db = db;
        this.text = text;
        this.params = params;
    }
    bind(...values) {
        return new Statement(this.db, this.text, values.map((v) => (v === undefined ? null : v)));
    }
    exec() {
        const stmt = this.db.prepare(this.text);
        const rows = stmt.all(...this.params).map((r) => ({ ...r }));
        const changes = this.db.prepare("SELECT changes() AS c").get().c;
        return { rows, changes };
    }
    async first(column) {
        const { rows } = this.exec();
        if (rows.length === 0) return null;
        return column ? rows[0][column] : rows[0];
    }
    async all() {
        const { rows, changes } = this.exec();
        return { results: rows, success: true, meta: { changes, rows_read: rows.length } };
    }
    async run() {
        const { rows, changes } = this.exec();
        return { results: rows, success: true, meta: { changes } };
    }
    async raw() {
        const { rows } = this.exec();
        return rows.map((r) => Object.values(r));
    }
}

class FakeD1 {
    constructor(db) {
        this.db = db;
        this.statements = 0;
        this.log = [];
    }
    prepare(text) {
        this.statements++;
        this.log.push(text);
        return new Statement(this.db, text);
    }
    async batch(statements) {
        const out = [];
        this.db.exec("BEGIN");
        try {
            for (const s of statements) out.push(await s.all());
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        return out;
    }
}

class FakeR2 {
    constructor() {
        this.objects = new Map();
        this.deleted = [];
        this.puts = [];
    }
    async put(key, body, options) {
        const bytes = body instanceof Uint8Array ? body.slice() : new Uint8Array(await new Response(body).arrayBuffer());
        this.objects.set(key, { bytes, options });
        this.puts.push(key);
        return { key, size: bytes.byteLength };
    }
    async get(key) {
        const o = this.objects.get(key);
        return o ? { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength), size: o.bytes.byteLength, httpMetadata: o.options?.httpMetadata } : null;
    }
    async head(key) {
        const o = this.objects.get(key);
        return o ? { size: o.bytes.byteLength, key } : null;
    }
    async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            this.deleted.push(key);
            this.objects.delete(key);
        }
    }
}

/** A fresh database with every migration applied. `vars` are extra Env fields (DAILY_DERIVED_LIMIT, ...). */
export function createEnv(vars = {}) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(resolve(ROOT, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of migrations) db.exec(readFileSync(resolve(ROOT, "migrations", file), "utf8"));
    const d1 = new FakeD1(db);
    const r2 = new FakeR2();
    const env = { DB: d1, FILES: r2, ...vars };
    return {
        env,
        db,
        r2,
        d1,
        migrations,
        /** Runs SQL directly: the rows of a SELECT, [] otherwise. */
        sql(text, ...params) {
            return db.prepare(text).all(...params).map((r) => ({ ...r }));
        },
    };
}
