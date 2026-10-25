// What the parts list says about a stabilized model. Its GLB has one node per role (shared/assemblyGlb.ts), named like
// ROLE_NODE_NAMES (the file keeps those names); the list says each role in the panel's words ("Footings", "Thicker joints"), with its
// colour and block count. Pure: no three.js.
import { ROLE_WORDS } from "../components/analysis/vocabulary.ts";
import { BLOCK_ROLES, type BlockRole } from "../shared/contract.ts";
import { CELL_STRIDE, ROLE_HEX, ROLE_NODE_NAMES, STABILIZATION_EXTRAS_KEY, roleCounts, type AssemblyDescriptor } from "../shared/assembly.ts";
import type { PartRow } from "./types.ts";

const ROLE_OF_NODE = new Map<string, BlockRole>(BLOCK_ROLES.map((role) => [ROLE_NODE_NAMES[role], role]));

/** The role a part row is, by the name of its node; undefined for a part that is not a role (a model that is not an assembly). */
export function roleOfPart(name: string): BlockRole | undefined {
    return ROLE_OF_NODE.get(name);
}

/** Rows named in the panel's words, with the role's colour and "12 blocks" in place of a triangle count. Rows that are not roles stay as they are. */
export function decorateAssemblyRows(rows: readonly PartRow[], assembly: AssemblyDescriptor | null): readonly PartRow[] {
    if (!assembly) return rows;
    const counts = roleCounts(assembly);
    return rows.map((row) => {
        const role = roleOfPart(row.name);
        if (!role) return row;
        const n = counts[BLOCK_ROLES.indexOf(role)];
        return { ...row, name: ROLE_WORDS[role], swatch: ROLE_HEX[role], detail: `${n} ${n === 1 ? "block" : "blocks"}` };
    });
}

/** Blocks of the model it started from, and blocks the stabilizer added. */
export function assemblyCounts(assembly: AssemblyDescriptor): { original: number; added: number } {
    const counts = roleCounts(assembly);
    const total = counts.reduce((sum, n) => sum + n, 0);
    return { original: counts[0], added: total - counts[0] };
}

/** The highest stabilizer step in an assembly (0 when nothing was added). */
export function topStep(assembly: Pick<AssemblyDescriptor, "cells">): number {
    let top = 0;
    for (let n = 4; n < assembly.cells.length; n += CELL_STRIDE) top = Math.max(top, assembly.cells[n]);
    return top;
}

/**
 * The steps a stabilized model carries from earlier runs. The descriptor numbers a re-stabilized model's steps on from the
 * model it was made from, while the log stored with it (scenes[0].extras) lists only its own run from 1: the difference is
 * what its tooltips subtract, so a block says "step 3" where the timeline does. 0 for a first run, and for a file without a
 * log (nothing says how its steps were numbered). `extras`: the scene's userData, which is where GLTFLoader leaves them.
 */
export function earlierSteps(extras: Readonly<Record<string, unknown>> | undefined, assembly: Pick<AssemblyDescriptor, "cells">): number {
    const log = extras?.[STABILIZATION_EXTRAS_KEY];
    const steps = typeof log === "object" && log !== null ? (log as { steps?: unknown }).steps : undefined;
    if (!Array.isArray(steps)) return 0;
    return stepsBeforeOwnRun(topStep(assembly), steps.length);
}

/**
 * The steps a model carries from earlier runs, given its top step and how many steps its own log lists. This is earlierSteps
 * for a host that has the log's length but not the GLB it came from (a stabilized model shown on its source mesh: the viewer
 * loads the source, which has no log). 0 without a log (null / undefined), and never negative.
 */
export function stepsBeforeOwnRun(top: number, ownSteps: number | null | undefined): number {
    if (typeof ownSteps !== "number" || !Number.isFinite(ownSteps)) return 0;
    return Math.max(0, top - ownSteps);
}

/**
 * The steps the tooltips of the model on stage leave out when they number its run from 1.
 *  - no assembly behind the stage (a plain mesh): 0;
 *  - the stabilizer's preview: it continues from the model's top step;
 *  - `hosted`, when the host gives one: a stabilized model shown on its source mesh (the mesh carries no log, so only the host
 *    knows how many of the model's steps are its own);
 *  - else `earlier`: what the loaded assembly's own log says (see earlierSteps).
 * A `hosted` that is not a count (NaN, negative) is ignored.
 */
export function stageStepOffset(opts: { assembly: Pick<AssemblyDescriptor, "cells"> | null; previewing: boolean; hosted?: number | null; earlier: number }): number {
    const { assembly, previewing, hosted, earlier } = opts;
    if (!assembly) return 0;
    if (previewing) return topStep(assembly);
    return typeof hosted === "number" && Number.isFinite(hosted) && hosted >= 0 ? Math.floor(hosted) : earlier;
}
