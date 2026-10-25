// The pure rules of changing the blocks by words (store/voxelEdit.ts runs the flow; components/analysis/EditBlocksCard.tsx shows it): what a
// verdict change reads like, how a proposal's counts are worded, the text that names a model to the AI editor, the chips, and the draft that
// survives a reload. No React, no stores, nothing that needs a browser, so scripts/assignment/test-voxel-edit-store.mjs imports it as it is.

import type { AnalysisResult, Issue } from "@/assignment/analysis/types";
import type { ModelAsset } from "@/assignment/shared/contract";
import { MAX_VOXEL_EDITS_PER_VERSION } from "@/assignment/shared/contract";
import type { SceneIssue } from "@/assignment/shared/voxelEdit/scene";
import type { VoxelEditEntry } from "@/assignment/shared/voxelEdit/ops";
import { fixOfIssues, plural, verdictOf, type Verdict } from "@/assignment/store/analysisLogic";

/** Examples the field offers as chips: each one was run against the AI editor and gave a sensible answer. */
export const EDIT_CHIPS: readonly string[] = ["Make the base wider", "Hollow it out", "Make it taller"];
export const EDIT_PLACEHOLDER = "e.g. “add a shelf under the seat”";

// ---------- verdicts ----------

/** The verdict an analysis states, counted from its issue list so it always matches the problem list (the same rule as the Stability tab's). */
export function verdictOfAnalysis(result: AnalysisResult): Verdict {
    let errors = 0;
    let warnings = 0;
    for (const issue of result.issues) {
        if (issue.severity === "error") errors++;
        else warnings++;
    }
    return verdictOf(
        {
            errors,
            warnings,
            blocks: result.stats.blockCount,
            cantilever_limit: result.settings.cantileverLimit,
            fill_threshold: result.settings.fillThreshold,
            material: result.settings.material,
            fix: fixOfIssues(result.issues),
        },
        result.settings.maxBlocks,
    ) as Verdict;
}

export type ChangeTone = "same" | "better" | "worse";

export interface VerdictChange {
    tone: ChangeTone;
    /** "Stable → 4 problems", "Still stable", "3 problems → Stable". */
    text: string;
    /** Problems the edit caused that the model did not have (the titles of the issues), at most 3. */
    broke: string[];
    /** Problems the edit solved, at most 3. */
    fixed: string[];
}

const weight = (v: Pick<Verdict, "errors" | "warnings">): number => v.errors * 1000 + v.warnings;
/** The kind of problem a title names, without its numbers: "Arm too long: 6 blocks (max 4)" and "Arm too long: 7 blocks (max 4)" are the same problem. */
const headOf = (title: string): string => title.split(":")[0].trim();

/**
 * What an edit did to the verdict. Two issues are the same problem when their titles say the same thing before the colon (the numbers and the
 * blocks they point at change with an edit).
 */
export function verdictChange(
    before: Verdict,
    after: Verdict,
    beforeIssues: readonly Pick<Issue, "title" | "kind">[] = [],
    afterIssues: readonly Pick<Issue, "title" | "kind">[] = [],
): VerdictChange {
    const a = weight(before);
    const b = weight(after);
    const tone: ChangeTone = b > a ? "worse" : b < a ? "better" : "same";
    const text = a === b && before.kind === after.kind ? (after.kind === "pass" ? "Still stable" : `Still ${after.short.toLowerCase()}`) : `${before.short} → ${after.short}`;
    const was = new Set(beforeIssues.map((i) => headOf(i.title)));
    const is = new Set(afterIssues.map((i) => headOf(i.title)));
    const unique = (list: string[]): string[] => [...new Set(list)];
    return {
        tone,
        text,
        broke: unique(afterIssues.filter((i) => !was.has(headOf(i.title))).map((i) => i.title)).slice(0, 3),
        fixed: unique(beforeIssues.filter((i) => !is.has(headOf(i.title))).map((i) => i.title)).slice(0, 3),
    };
}

/** The issues of an analysis as the scene text wants them: severity, title and the cells they point at. */
export function sceneIssuesOf(result: Pick<AnalysisResult, "issues" | "blocks">): SceneIssue[] {
    return result.issues.map((issue) => ({
        severity: issue.severity,
        title: issue.title,
        cells: issue.blocks.flatMap((b) => {
            const block = result.blocks[b];
            return block ? [[block.cell[0], block.cell[1], block.cell[2]] as const] : [];
        }),
    }));
}

// ---------- words ----------

/** "+14 blocks · −0 · 6 moved": what a proposal does, in numbers. */
export function countsLine(c: { added: number; removed: number; moved: number }): string {
    const parts = [`+${plural(c.added, "block")}`, `−${c.removed}`];
    if (c.moved > 0) parts.push(`${c.moved} moved`);
    return parts.join(" · ");
}

/** "2 changes, not saved". */
export const draftLine = (count: number): string => `${plural(count, "change")}, not saved`;

/** The kind of a version in the words a person uses, for the model's name in the scene text and for the chat. */
export function versionWord(model: Pick<ModelAsset, "kind" | "edit" | "optimization">): string {
    switch (model.kind) {
        case "stabilized":
            return "stabilized version";
        case "edited":
            return model.edit?.target === "voxel" ? "edited version" : "original";
        case "optimized":
            return "optimized version";
        default:
            return "original blocks, not stabilized";
    }
}

/** The label of the model in the scene text: its prompt, trimmed, and what version of it this is. Never instructions: the scene says so. */
export function sceneNameOf(model: Pick<ModelAsset, "prompt" | "kind" | "edit" | "optimization">): string {
    // eslint-disable-next-line no-control-regex
    const prompt = model.prompt.replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${prompt || "model"} (${versionWord(model)})`;
}

/** Another change can be added to a draft that has `count` changes whose first one starts after `baseSteps`; else the words that say why not. */
export function canAddChange(count: number, baseSteps: number): string | null {
    if (count >= MAX_VOXEL_EDITS_PER_VERSION) return `One version holds up to ${MAX_VOXEL_EDITS_PER_VERSION} changes. Save this one first, then go on.`;
    if (baseSteps + count + 1 > 255) return "This model has been changed too many times to go on. Save this version first.";
    return null;
}

// ---------- the draft that survives a reload ----------

/** What is kept of a draft (in sessionStorage): the model it started from and the changes it applied. The blocks are replayed from them. */
export interface SavedDraft {
    v: 1;
    projectId: string;
    modelId: string;
    baseSteps: number;
    entries: VoxelEditEntry[];
}

export const DRAFT_STORAGE_KEY = "assembly-studio-block-draft";

/** Reads the kept draft; null when there is none or it is not a draft this version of the app wrote. */
export function parseSavedDraft(raw: string | null): SavedDraft | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null) return null;
        const d = value as Partial<SavedDraft>;
        if (d.v !== 1 || typeof d.projectId !== "string" || typeof d.modelId !== "string" || typeof d.baseSteps !== "number" || !Array.isArray(d.entries)) return null;
        if (d.entries.length < 1 || d.entries.length > MAX_VOXEL_EDITS_PER_VERSION) return null;
        for (const [n, e] of (d.entries as unknown[]).entries()) {
            if (typeof e !== "object" || e === null) return null;
            const entry = e as Partial<VoxelEditEntry>;
            if (entry.n !== n + 1 || typeof entry.instruction !== "string" || !Array.isArray(entry.ops)) return null;
        }
        return d as SavedDraft;
    } catch {
        return null;
    }
}

export function loadSavedDraft(storage: Pick<Storage, "getItem"> | null = safeStorage()): SavedDraft | null {
    try {
        return parseSavedDraft(storage ? storage.getItem(DRAFT_STORAGE_KEY) : null);
    } catch {
        return null;
    }
}

/** Keeps the draft (null removes it). A blocked or full storage just means the draft will not survive a reload. */
export function keepDraft(draft: SavedDraft | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): void {
    try {
        if (!storage) return;
        if (draft === null) storage.removeItem(DRAFT_STORAGE_KEY);
        else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
        // Nothing to do: see above.
    }
}

function safeStorage(): Storage | null {
    try {
        return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
        return null;
    }
}
