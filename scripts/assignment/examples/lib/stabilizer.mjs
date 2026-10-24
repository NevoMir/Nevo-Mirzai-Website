// The one place that knows how to call the app's stabilizer (src/assignment/analysis/stabilize/stabilize.ts) from Node.
// Its contract is stabilize/types.ts: stabilize(input, sourceDepth, run) is a pure function of (cells, settings, options)
// that returns the descriptor, the log and the GLB; `run` hosts it (the stress solver). If the entry point's name or arguments
// change, this file is the only thing to adjust.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { REPO } from "./engine.mjs";

const DEFAULT_MODULE = "src/assignment/analysis/stabilize/stabilize.ts";
const typesMod = await import(pathToFileURL(resolve(REPO, "src/assignment/analysis/stabilize/types.ts")).href);
export const { DEFAULT_STABILIZE_OPTIONS } = typesMod;

/** The stabilizer function: `stabilize(input, sourceDepth, run)`, from `modulePath` (a path under the repo, or absolute) or the app's own. */
export async function loadStabilizer(modulePath = DEFAULT_MODULE) {
    const file = resolve(REPO, modulePath);
    let mod;
    try {
        mod = await import(pathToFileURL(file).href);
    } catch (error) {
        throw new Error(`The stabilizer could not be loaded from ${file} (${error?.message ?? error}). Run with --originals-only until it exists.`);
    }
    const fn = mod.stabilize ?? mod.runStabilizer ?? mod.default;
    if (typeof fn !== "function") throw new Error(`${file} exports no stabilize() function.`);
    return fn;
}

/**
 * Runs it on a model's cells. `settings` are the analysis settings in force; `solver` the SolverHandle of analysis/stress.ts;
 * `sourceDepth` 0 for a generated model. Resolves to StabilizeResult { descriptor, meta, glb, before, after, stop, complete, addedByRole }.
 */
export async function runStabilizer(stabilize, { cells, settings, solver, sourceDepth = 0, options = {} }) {
    const input = {
        cells,
        settings,
        options: { ...DEFAULT_STABILIZE_OPTIONS, maxBlocks: settings.maxBlocks ?? 1000, ...options },
    };
    return await stabilize(input, sourceDepth, { solver });
}
