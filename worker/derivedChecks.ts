// Facts about an uploaded stabilized model that the server can work out from its blocks, set against what the stabilizer's
// log says about them (POST /models/:sourceId/derived, worker/derived.ts). The stress numbers in the log are the client's
// claims and stay that way; counts of blocks are not, because they cost one pass over the cells.
// A file of its own, with nothing from the Workers runtime in it, so a Node script can run it too.

import { BLOCK_ROLES, type AddedRole, type DerivedMeta } from "../src/assignment/shared/contract.ts";
import { CELL_STRIDE, type AssemblyDescriptor } from "../src/assignment/shared/assembly.ts";

// "user" blocks come from edits, never from the stabilizer (checkDerivedMeta cannot list them); one inside this run's steps fails the counts below.
const ADDED_ROLES = BLOCK_ROLES.filter((r): r is AddedRole => r !== "original" && r !== "user");

/**
 * An error message when the log disagrees with the blocks, else null. checkDerivedMeta has already made the log add up on
 * its own (steps and roles sum to added_blocks, after.blocks = before.blocks + added_blocks); this ties it to the cells.
 *
 * "Added by this run" is not "not original": a model stabilized a second time keeps the roles and steps of the first run
 * (the earlier additions are blocks of the model being analysed), and this run's steps are numbered after them. So the
 * blocks of this run are those with a step above `highest step - number of logged steps`. `firstRun` is true when the
 * source is a mesh (representationOf(source) === "mesh": generated, example, edited design or mesh): it has no steps of its own, so
 * every added block belongs to this run and the offset is 0. Every other source is a block assembly (stabilized, edited blocks,
 * optimized) whose blocks keep their roles and steps: firstRun is false and this run's steps come after the highest one it has.
 */
export function crossCheckDerived(descriptor: Pick<AssemblyDescriptor, "cells">, meta: DerivedMeta, firstRun: boolean): string | null {
    const cells = descriptor.cells;
    const blocks = cells.length / CELL_STRIDE;
    if (meta.after.blocks !== blocks) return `The stabilizer's log counts ${meta.after.blocks} blocks, the file has ${blocks}.`;
    if (meta.after_summary.blocks !== blocks) return `The analysis in the stabilizer's log counts ${meta.after_summary.blocks} blocks, the file has ${blocks}.`;
    const logged = meta.steps.length;
    let highest = 0;
    for (let n = 4; n < cells.length; n += CELL_STRIDE) if (cells[n] > highest) highest = cells[n];
    if (firstRun && highest !== logged) return `The blocks were added in ${highest} ${highest === 1 ? "step" : "steps"}, the stabilizer's log has ${logged}.`;
    const offset = highest - logged;
    if (offset < 0) return "The stabilizer's log has more steps than the blocks were added in.";

    const perStep: number[] = Array.from({ length: logged }, () => 0);
    const perRole = new Map<AddedRole, number>();
    let added = 0;
    for (let n = 0; n < cells.length; n += CELL_STRIDE) {
        const step = cells[n + 4];
        if (step <= offset) continue;
        added++;
        perStep[step - offset - 1]++;
        const role = BLOCK_ROLES[cells[n + 3]] as AddedRole; // a step above 0 is never an original (parseAssemblyDescriptor)
        perRole.set(role, (perRole.get(role) ?? 0) + 1);
    }
    if (added !== meta.added_blocks) return `The stabilizer's log says ${meta.added_blocks} blocks were added, the file has ${added}.`;
    for (const role of ADDED_ROLES) {
        if ((perRole.get(role) ?? 0) !== (meta.added_by_role[role] ?? 0)) return `The stabilizer's log counts the ${role} blocks differently from the file.`;
    }
    for (let i = 0; i < logged; i++) {
        if (perStep[i] !== meta.steps[i].added) return `Step ${i + 1} of the stabilizer's log does not match the blocks it added.`;
    }
    return null;
}
