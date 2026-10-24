// Tests for the projects hub's logic and markup (src/assignment/lib/hub/*, components/hub/*).
//
//   node scripts/assignment/test-hub.mjs
//
// Two halves:
//   1. the pure modules, imported as .ts (Node strips the types) through a tiny "@/" alias hook;
//   2. a few real components, bundled with esbuild and server-rendered with react-dom/server, for the
//      regressions that only show up in markup (a tag icon that crashes React, row semantics).
// Nothing here needs a browser, a Worker or the network.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Node < 22.18 only strips types behind a flag; run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = `${ROOT}src/`;

// "@/assignment/..." -> src/assignment/....ts, the way tsconfig and Vite resolve it.
const hookSource = `
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
const SRC = ${JSON.stringify(SRC)};
export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
        const base = SRC + specifier.slice(2);
        for (const candidate of [base + ".ts", base + ".tsx", base + "/index.ts", base]) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return nextResolve(pathToFileURL(candidate).href, context);
        }
    }
    return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`);

const hub = (name) => import(`../../src/assignment/lib/hub/${name}.ts`);
const tagIcons = await hub("tagIcons");
const hubClient = await hub("hubClient");
const { hubViewFor } = await hub("hubView");
const { withoutIds, applyRowClick, EMPTY_SELECTION } = await hub("rowSelection");
const { createLoadGate } = await hub("loadGate");
const { focusHeirOf } = await hub("focusRescue");
const { isImeKey } = await hub("ime");
const paths = await import("../../src/assignment/lib/projectPath.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}

const project = (id, over = {}) => ({
    id,
    name: id,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    archived_at: null,
    pinned: false,
    thumbnail_url: null,
    tag_ids: [],
    model_count: 0,
    ...over,
});
const names = (rows) => rows.map((r) => r.id).join(",");

// ---------- tag icons ----------

console.log("tag icons");

// Every member of Object.prototype, plus the names a lookup could mistake for one.
const PROTO_KEYS = [...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"];

await test("tagIcon falls back to Folder for every Object.prototype member (anonymous POST /tags icon:\"constructor\")", () => {
    const folder = tagIcons.tagIcon("Folder");
    for (const key of PROTO_KEYS) {
        assert.equal(tagIcons.tagIcon(key), folder, key);
        assert.equal(tagIcons.isTagIconName(key), false, key);
    }
});

await test("tagIcon: null, undefined, empty and unknown names are Folder; real names are themselves", () => {
    const folder = tagIcons.tagIcon("Folder");
    for (const bad of [null, undefined, "", "NotAnIcon", "star"]) assert.equal(tagIcons.tagIcon(bad), folder, String(bad));
    assert.equal(tagIcons.TAG_ICON_NAMES.length, 185);
    for (const name of tagIcons.TAG_ICON_NAMES) {
        assert.equal(tagIcons.isTagIconName(name), true, name);
        assert.equal(tagIcons.tagIcon(name), tagIcons.TAG_ICONS[name], name);
    }
});

await test("every swatch has a spoken name; a custom colour answers with its hex", () => {
    const spoken = tagIcons.TAG_COLORS.map(tagIcons.tagColorName);
    assert.equal(new Set(spoken).size, tagIcons.TAG_COLORS.length, "names are distinct");
    for (const [i, name] of spoken.entries()) assert.match(name, /^[A-Z][a-z]+$/, tagIcons.TAG_COLORS[i]);
    assert.equal(tagIcons.tagColorName("#EF4444"), "Red");
    assert.equal(tagIcons.tagColorName("#123456"), "#123456");
    assert.equal(tagIcons.tagColorName("constructor"), "constructor");
});

await test("chip text colour reaches WCAG AA (4.5:1) for every swatch on every surface, both themes", () => {
    const css = tagIcons.tagTextColor("#eab308");
    const share = Number(/#eab308 (\d+)%/.exec(css)?.[1]);
    assert.ok(share > 0 && share < 100, css);
    const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const grey = (pct) => Array(3).fill((pct / 100) * 255);
    // --foreground, and the surfaces a chip sits on (--card, --background, --secondary): assignment/index.css.
    const themes = { light: [15, [100, 97, 92]], dark: [90, [13, 8, 16]] };
    for (const [theme, [fg, surfaces]] of Object.entries(themes)) {
        for (const surface of surfaces) {
            for (const color of tagIcons.TAG_COLORS) {
                const text = mix(hex(color), grey(fg), share / 100);
                const chip = mix(hex(color), grey(surface), 0x22 / 255);
                const ratio = contrast(text, chip);
                assert.ok(ratio >= 4.5, `${theme} ${color} on ${surface}%: ${ratio.toFixed(2)}`);
            }
        }
    }
});

// ---------- ordering ----------

console.log("ordering");

const T = "2026-03-01T00:00:00.000Z";

await test("sortProjects is stable for equal timestamps: re-sorting never flips a tied group", () => {
    // Created in the same order the server returns them; one bulk write gave all four one modified_at.
    let rows = ["a", "b", "c", "d"].map((id, i) => project(id, { modified_at: T, created_at: `2026-01-0${4 - i}T00:00:00.000Z` }));
    const once = names(hubClient.sortProjects(rows));
    for (let i = 0; i < 5; i += 1) {
        rows = hubClient.sortProjects(rows);
        assert.equal(names(rows), once, `pass ${i}`);
    }
    // Even when the ties have nothing else to separate them, the id decides, the same way every time.
    const bare = ["d", "b", "a", "c"].map((id) => project(id, { modified_at: T }));
    assert.equal(names(hubClient.sortProjects(bare)), "a,b,c,d");
    assert.equal(names(hubClient.sortProjects(hubClient.sortProjects(bare))), "a,b,c,d");
});

await test("sortProjects: pinned first, then newest modified, then newest created", () => {
    const rows = [
        project("old", { modified_at: "2026-01-01T00:00:00.000Z" }),
        project("pin", { pinned: true, modified_at: "2025-01-01T00:00:00.000Z" }),
        project("new", { modified_at: "2026-02-01T00:00:00.000Z" }),
        project("tieB", { modified_at: "2026-01-15T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" }),
        project("tieA", { modified_at: "2026-01-15T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" }),
    ];
    assert.equal(names(hubClient.sortProjects(rows)), "pin,new,tieA,tieB,old");
});

await test("compareByModified and compareByDeleted are total orders (antisymmetric, 0 only for the same row)", () => {
    const rows = ["a", "b", "c"].map((id) => project(id, { modified_at: T, deleted_at: T }));
    for (const cmp of [hubClient.compareByModified, hubClient.compareByDeleted]) {
        for (const x of rows) {
            for (const y of rows) {
                assert.equal(Math.sign(cmp(x, y)) + Math.sign(cmp(y, x)), 0, `${x.id}/${y.id}`);
                assert.equal(cmp(x, y) === 0, x === y);
            }
        }
    }
    assert.equal(hubClient.compareByModified(rows[0], { ...rows[0] }), 0);
});

await test("the bin and Recent keep their order across repeated sorts (the cases ProjectsHub sorts itself)", () => {
    const trashed = ["a", "b", "c", "d", "e"].map((id) => project(id, { modified_at: T, deleted_at: "2026-03-02T00:00:00.000Z" }));
    const first = names([...trashed].sort(hubClient.compareByDeleted));
    let rows = [...trashed].sort(hubClient.compareByDeleted);
    for (let i = 0; i < 4; i += 1) rows = [...rows].sort(hubClient.compareByDeleted);
    assert.equal(names(rows), first);
    // Newest binned first, ties by modified.
    const mixed = [
        project("x", { deleted_at: "2026-03-01T00:00:00.000Z" }),
        project("y", { deleted_at: "2026-03-03T00:00:00.000Z" }),
        project("z", { deleted_at: "2026-03-02T00:00:00.000Z" }),
    ];
    assert.equal(names([...mixed].sort(hubClient.compareByDeleted)), "y,z,x");
    const recent = ["a", "b", "c", "d"].map((id) => project(id, { modified_at: T }));
    assert.equal(names([...recent].sort(hubClient.compareByModified)), names([...recent].reverse().sort(hubClient.compareByModified)));
});

// ---------- routing ----------

console.log("routing");

await test("hubViewFor: a trailing slash is the same view", () => {
    assert.equal(hubViewFor("/app/deleted"), "deleted");
    assert.equal(hubViewFor("/app/deleted/"), "deleted");
    assert.equal(hubViewFor("/app/archived"), "archived");
    assert.equal(hubViewFor("/app/archived//"), "archived");
    assert.equal(hubViewFor("/app"), "all");
    assert.equal(hubViewFor("/app/"), "all");
    assert.deepEqual(hubViewFor("/app/tag/abc", "abc"), { tag: "abc" });
});

await test("normalizePath and the path tests agree about slashes", () => {
    assert.equal(paths.normalizePath("/app/deleted/"), "/app/deleted");
    assert.equal(paths.normalizePath("/"), "/");
    assert.equal(paths.normalizePath("///"), "/");
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(paths.isProjectPath(`/app/${id}`), true);
    assert.equal(paths.isProjectPath(`/app/${id}/`), true);
    assert.equal(paths.isProjectPath("/app/new"), false);
    assert.equal(paths.isTagPath(`/app/tag/${id}/`), true);
    assert.equal(paths.isTagPath("/app/tag/uncategorized"), true);
});

// ---------- selection ----------

console.log("selection");

await test("withoutIds removes only the rows an action handled", () => {
    const order = ["a", "b", "c", "d"];
    let sel = applyRowClick(EMPTY_SELECTION, order, "a");
    sel = applyRowClick(sel, order, "c");
    const after = withoutIds(sel, ["d"]);
    assert.equal(after, sel, "nothing of it selected: same object");
    const one = withoutIds(sel, ["a", "d"]);
    assert.deepEqual([...one.selected], ["c"]);
    assert.equal(one.anchor, "c", "the anchor survives while it is selected");
    assert.equal(withoutIds(one, ["c"]), EMPTY_SELECTION, "nothing left: the empty selection");
    const gone = withoutIds(sel, ["c"]);
    assert.deepEqual([...gone.selected], ["a"]);
    assert.equal(gone.anchor, null, "the anchor row was handled: the next shift-click starts afresh");
    // Input is never mutated.
    assert.deepEqual([...sel.selected].sort(), ["a", "c"]);
});

// ---------- focus ----------

console.log("focus");

await test("focusHeirOf: the next surviving row, else the previous, else the heading", () => {
    const order = ["a", "b", "c", "d"];
    assert.equal(focusHeirOf(order, new Set(["b"]), true), "c");
    assert.equal(focusHeirOf(order, new Set(["b", "c"]), true), "d");
    assert.equal(focusHeirOf(order, new Set(["c", "d"]), true), "b");
    assert.equal(focusHeirOf(order, new Set(order), true), null);
    assert.equal(focusHeirOf(order, new Set(["zzz"]), true), null, "not on screen (an Undo): the heading");
    assert.equal(focusHeirOf(order, new Set(["c", "b"]), false), "b", "rows that stay: the first acted row");
    assert.equal(focusHeirOf([], new Set(["a"]), false), null);
});

// ---------- IME ----------

console.log("ime");

await test("isImeKey: composing Enter (and Safari's keyCode 229) is not a submit", () => {
    assert.equal(isImeKey({ nativeEvent: { isComposing: true }, keyCode: 13 }), true);
    assert.equal(isImeKey({ nativeEvent: { isComposing: false }, keyCode: 229 }), true);
    assert.equal(isImeKey({ nativeEvent: { isComposing: false }, keyCode: 13 }), false);
});

// ---------- read ordering ----------

console.log("load gate");

await test("a background read never overtakes an initial read: no ticket while one is in flight", () => {
    const gate = createLoadGate();
    const initial = gate.begin("initial");
    assert.ok(initial);
    assert.equal(gate.begin("background"), null, "the focus refresh yields");
    assert.equal(gate.judge(initial), "land", "so the slow initial read still lands");
    gate.end(initial);
    assert.ok(gate.begin("background"), "once it is done, refreshes run again");
});

await test("a refresh that began before a sync read cannot invalidate it, and is itself dropped", () => {
    const gate = createLoadGate();
    const background = gate.begin("background");
    const sync = gate.begin("sync");
    assert.equal(gate.judge(sync), "land");
    assert.equal(gate.judge(background), "drop", "predates the sync read");
    gate.end(sync);
});

await test("a failed read that was superseded is told so (no error for an answer nobody wants)", () => {
    const gate = createLoadGate();
    const first = gate.begin("initial");
    const second = gate.begin("initial");
    assert.equal(gate.superseded(first), true);
    assert.equal(gate.superseded(second), false);
    gate.end(first);
    gate.end(second);
});

await test("only the newest background read lands", () => {
    const gate = createLoadGate();
    const one = gate.begin("background");
    const two = gate.begin("background");
    assert.equal(gate.judge(one), "drop");
    assert.equal(gate.judge(two), "land");
});

await test("a background read that overlaps a write, or an edit made while it travelled, is dropped", () => {
    const gate = createLoadGate();
    const during = gate.begin("background");
    gate.writeBegan();
    assert.equal(gate.judge(during), "drop", "write in flight");
    gate.writeEnded();
    assert.equal(gate.judge(during), "drop", "write came and went: the answer predates it");
    assert.equal(gate.judge(gate.begin("background")), "land", "a fresh one is fine");
});

await test("a resync that a write overtook is read again once writes settle, never applied over the edit", () => {
    const gate = createLoadGate();
    const sync = gate.begin("sync");
    gate.writeBegan(); // the user ticks another tag while the resync travels
    assert.equal(gate.judge(sync), "wait", "must not land on top of the optimistic edit");
    gate.end(sync);
    assert.equal(gate.writeEnded(), true, "the last write settling asks for the read");
    const again = gate.begin("sync");
    assert.equal(gate.judge(again), "land");
    gate.end(again);
});

await test("a resync that a whole write overtook is read again straight away", () => {
    const gate = createLoadGate();
    const sync = gate.begin("sync");
    gate.writeBegan();
    gate.writeEnded();
    assert.equal(gate.judge(sync), "again");
    gate.end(sync);
});

await test("with two writes in flight the read waits for the last one", () => {
    const gate = createLoadGate();
    const sync = gate.begin("sync");
    gate.writeBegan();
    gate.writeBegan();
    assert.equal(gate.judge(sync), "wait");
    assert.equal(gate.writeEnded(), false, "one still running");
    assert.equal(gate.writeEnded(), true);
});

await test("a quiet resync lands; nothing is queued when no read was held back", () => {
    const gate = createLoadGate();
    const sync = gate.begin("sync");
    assert.equal(gate.judge(sync), "land");
    gate.end(sync);
    gate.writeBegan();
    assert.equal(gate.writeEnded(), false);
});

// ---------- markup ----------

console.log("markup");

const dir = mkdtempSync(join(tmpdir(), "assignment-hub-test-"));
let ssr;
try {
    const esbuild = await import("esbuild");
    const built = await esbuild.build({
        stdin: {
            contents: `
                import React from "react";
                import { renderToStaticMarkup } from "react-dom/server";
                import { TagMark } from "@/assignment/components/hub/TagMark";
                import { TagChips } from "@/assignment/components/hub/TagChips";
                import { HubSidebar } from "@/assignment/components/hub/HubSidebar";
                import { ProjectRow } from "@/assignment/components/hub/ProjectRow";
                import { BulkBar } from "@/assignment/components/hub/BulkBar";
                import { InlineName } from "@/assignment/components/hub/InlineName";
                export { React, renderToStaticMarkup, TagMark, TagChips, HubSidebar, ProjectRow, BulkBar, InlineName };
            `,
            resolveDir: ROOT,
            loader: "tsx",
        },
        alias: { "@": SRC.replace(/\/$/, "") },
        bundle: true,
        platform: "node",
        format: "cjs",
        jsx: "automatic",
        write: false,
        logLevel: "silent",
        define: { "process.env.NODE_ENV": '"production"' },
    });
    const file = join(dir, "hub-ssr.cjs");
    writeFileSync(file, built.outputFiles[0].text);
    ssr = createRequire(import.meta.url)(file);
} catch (error) {
    failures.push("bundle the hub components for server rendering");
    console.log(`  FAIL bundle the hub components for server rendering\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
}

if (ssr) {
    const { React, renderToStaticMarkup } = ssr;
    const h = React.createElement;
    const render = (el) => renderToStaticMarkup(el);
    const tag = (over = {}) => ({ id: "t1", name: "Parts", icon: null, color: "#eab308", created_at: T, ...over });
    const noop = () => {};

    await test("a tag whose stored icon is an Object.prototype member renders (as a folder) everywhere it is drawn", () => {
        for (const icon of PROTO_KEYS) {
            const bad = tag({ icon });
            assert.match(render(h(ssr.TagMark, { tag: bad })), /<svg/, `TagMark ${icon}`);
            const p = project("p1", { tag_ids: ["t1"] });
            const chips = render(h(ssr.TagChips, { project: p, tags: [bad], projectTags: ["t1"] }));
            assert.match(chips, /<svg/, `TagChips ${icon}`);
            const sidebar = render(
                h(ssr.HubSidebar, {
                    view: "all",
                    tags: [bad],
                    tagCounts: { t1: 1 },
                    uncategorizedCount: 0,
                    deletedCount: 0,
                    onNavigate: noop,
                    onNewProject: noop,
                    onNewTag: noop,
                    onEditTag: noop,
                    onDeleteTag: noop,
                    showSettings: false,
                }),
            );
            assert.match(sidebar, /hub-tag-mark-t1/, `HubSidebar ${icon}`);
            assert.doesNotMatch(sidebar, /\[object /, icon);
        }
    });

    await test("a chip's name is drawn in a readable mix; its mark keeps the pure tag colour", () => {
        const p = project("p1", { tag_ids: ["t1"] });
        const html = render(h(ssr.TagChips, { project: p, tags: [tag({ icon: "Star" })], projectTags: ["t1"] }));
        assert.match(html, /color:color-mix\(in srgb, ?#eab308 35%, ?hsl\(var\(--foreground\)\)\)/);
        assert.match(html, /<svg[^>]*style="color:#eab308"/);
    });

    await test("the chip's × is hidden on coarse pointers, and ⋯, the checkbox and the bulk bar grow there", () => {
        const p = project("p1", { tag_ids: ["t1"] });
        const chips = render(h(ssr.TagChips, { project: p, tags: [tag()], projectTags: ["t1"], onRemoveTag: noop, onOpenTag: noop }));
        assert.match(/<button[^>]*Remove tag[^>]*>/.exec(chips)?.[0] ?? "", /\[@media\(pointer:coarse\)\]:hidden/);
        const row = render(h(ssr.ProjectRow, { project: p, onOpen: noop, onSelect: noop, selectionActive: true, onTogglePin: noop }));
        assert.match(/<input[^>]*type="checkbox"[^>]*>/.exec(row)?.[0] ?? "", /\[@media\(pointer:coarse\)\]:h-6/);
        assert.match(/<button[^>]*Options for[^>]*>/.exec(row)?.[0] ?? "", /\[@media\(pointer:coarse\)\]:h-9/);
        const bar = render(
            h(ssr.BulkBar, {
                mode: "live", count: 2, tags: [], selectedTags: [],
                onAddTag: noop, onRemoveTag: noop, onNewTag: noop, onArchive: noop, onUnarchive: noop,
                onTrash: noop, onRestore: noop, onDeleteForever: noop, onClear: noop,
            }),
        );
        assert.match(bar, /role="status"[^>]*>2 selected/);
        assert.match(/<button[^>]*>(?:(?!<\/button>).)*Archive/.exec(bar)?.[0] ?? "", /\[@media\(pointer:coarse\)\]:h-9/);
    });

    await test("a plain row is a button that opens; only while selecting is it a toggle", () => {
        const p = project("p1", { name: "Chair", model_count: 3 });
        const plain = render(h(ssr.ProjectRow, { project: p, onOpen: noop, onSelect: noop, selected: false, selectionActive: false }));
        const open = /<div[^>]*role="button"[^>]*>/.exec(plain)?.[0] ?? "";
        assert.match(open, /aria-label="Open Chair"/);
        assert.doesNotMatch(open, /aria-pressed/, "not a toggle button while nothing is selected");
        const describedBy = /aria-describedby="([^"]+)"/.exec(open)?.[1];
        assert.ok(describedBy, "the stamp and model count are its description");
        assert.match(plain, new RegExp(`id="${describedBy.replace(/[:]/g, "\\:")}"[^>]*>(?:(?!</div>).)*3 models`));

        const selecting = render(h(ssr.ProjectRow, { project: p, onOpen: noop, onSelect: noop, selected: true, selectionActive: true }));
        const toggle = /<div[^>]*role="button"[^>]*>/.exec(selecting)?.[0] ?? "";
        assert.match(toggle, /aria-pressed="true"/);
        assert.doesNotMatch(toggle, /aria-label="Open /, "a click no longer opens");
    });
}

await test("every text field on the hub is 16px on a phone (iOS Safari zooms the page on anything smaller)", () => {
    for (const file of ["pages/ProjectsHub.tsx", "components/hub/TagDialog.tsx"]) {
        const source = readFileSync(`${SRC}assignment/${file}`, "utf8");
        const inputs = source.match(/<Input\b[\s\S]*?\/>/g) ?? [];
        assert.ok(inputs.length > 0, file);
        for (const input of inputs) {
            const classes = /className="([^"]*)"/.exec(input)?.[1] ?? "";
            // No className at all keeps the Input default (text-base md:text-sm), which is fine.
            if (!classes) continue;
            assert.match(classes, /(^| )text-base( |$)/, `${file}: ${input.slice(0, 60)}`);
            assert.doesNotMatch(classes, /(^| )text-(xs|sm)( |$)/, `${file}: ${input.slice(0, 60)}`);
        }
    }
});

if (ssr) {
    const { React, renderToStaticMarkup } = ssr;
    await test("the inline rename field is 16px on a phone even when its label class says text-sm", () => {
        const html = renderToStaticMarkup(
            React.createElement(ssr.InlineName, {
                value: "Chair", editing: true, onCommit() {}, onCancel() {}, className: "truncate text-sm font-medium text-foreground",
            }),
        );
        const classes = /<input[^>]*class="([^"]*)"/.exec(html)?.[1].split(/\s+/) ?? [];
        assert.ok(classes.includes("text-base") && classes.includes("md:text-sm"), classes.join(" "));
        assert.ok(!classes.includes("text-sm"), "a bare text-sm would win on a phone");
        assert.ok(classes.includes("text-foreground") && classes.includes("font-medium"), "colour and weight stay");
    });
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
