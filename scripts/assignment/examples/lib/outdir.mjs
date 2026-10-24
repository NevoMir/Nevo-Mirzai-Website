// What make-examples.mjs may delete in its output folder, kept apart so it can be tested without a build.
//
// The rule: the script removes only what an earlier run of itself could have written (the four files of an example, or the
// cover.webp an older version made) and never anything else. A folder it does not recognise is a mistake in --out, not
// something to tidy up. Names that start with "." (.DS_Store, .git, editor files) are not ours and are never listed,
// compared or removed.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

/** The files of one example. */
export const OUTPUT_FILES = new Set(["original.glb", "stabilized.glb", "cover.png", "detail.json"]);
/** Those, plus the names an earlier build used (the cover was a WebP before the build had a PNG encoder). */
const EARLIER_FILES = new Set([...OUTPUT_FILES, "cover.webp"]);

export const isHidden = (name) => name.startsWith(".");

async function entriesOf(dir) {
    try {
        return (await readdir(dir, { withFileTypes: true })).filter((e) => !isHidden(e.name));
    } catch {
        return []; // missing: nothing to list
    }
}

/** The names in a folder, minus the hidden ones, sorted; empty when the folder does not exist. */
export async function visibleNames(dir) {
    return (await entriesOf(dir)).map((e) => e.name).sort();
}

/** A folder holding nothing but files an example build writes (or no files at all): an earlier example, safe to replace. */
export async function looksLikeOutput(dir) {
    return (await entriesOf(dir)).every((e) => e.isFile() && EARLIER_FILES.has(e.name));
}

export async function hasManifest(dir) {
    try {
        return (await stat(join(dir, "manifest.json"))).isFile();
    } catch {
        return false;
    }
}

/**
 * What to do with the files already in `out` before the new ones are written.
 *   slugs     the folders this run rebuilds
 *   produced  Set of "<slug>/<file>" this run writes
 *   fullSet   the whole catalogue is being built: folders of examples that left the catalogue go too
 *   keep      names inside a slug folder that stay although this run does not write them (--originals-only keeps stabilized.glb)
 * -> { prune, foreign }: `prune` is safe to delete (earlier output); `foreign` is everything else, which is left alone
 * unless the caller was told to clean it too. Both are paths relative to `out`.
 */
export async function planClean(out, { slugs, produced, fullSet, keep = () => false }) {
    const prune = [];
    const foreign = [];
    for (const slug of slugs) {
        for (const e of await entriesOf(join(out, slug))) {
            const rel = `${slug}/${e.name}`;
            if (produced.has(rel) || keep(e.name)) continue;
            (e.isFile() && EARLIER_FILES.has(e.name) ? prune : foreign).push(rel);
        }
    }
    if (fullSet) {
        for (const e of await entriesOf(out)) {
            if (e.name === "manifest.json" || slugs.includes(e.name)) continue;
            (e.isDirectory() && (await looksLikeOutput(join(out, e.name))) ? prune : foreign).push(e.name);
        }
    }
    return { prune, foreign };
}

/**
 * Why `out` must never be an output folder, even with --force-clean: the filesystem root, the home folder, the repository
 * or a folder that contains it (a typo such as --out . or --out ~). Null when it is fine.
 */
export function unsafeOut(out, repo) {
    const target = resolve(out);
    const root = resolve(repo);
    if (target === parse(target).root) return `${target} is the root of the filesystem`;
    if (target === resolve(homedir())) return `${target} is the home folder`;
    if (target === root || root.startsWith(target + sep)) return `${target} is the repository, or a folder that contains it`;
    return null;
}
