// The pure rules of the edit store (store/edit.ts): what each stage says, how a failure reads, which models go with an undo, what the
// "generate it again" prompt is. No stores and no DOM, so the tests run it directly.

import { ApiRequestError } from "@/assignment/lib/api";
import { MeshEditError } from "@/assignment/edit/types";
import type { EditResult, Job, ModelAsset } from "@/assignment/shared/contract";

export type EditStatus = "describing" | "planning" | "refining" | "applying" | "saving" | "saved" | "noop" | "error";

/** Why an edit stopped, for the card: what to offer next follows from it. */
export type EditErrorKind = "start" | "plan" | "unsupported" | "notfound" | "toomuch" | "toobig" | "apply" | "save";

export const MB = 1024 * 1024;

/** "15 MB" / "27.8 MB". */
export function megabytes(bytes: number): string {
    const mb = bytes / MB;
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** The words of the stage a mesh run is in (spec 6.2). `step`: the op being applied. */
export function stageWords(status: EditStatus, detail: { step?: { index: number; total: number; label: string } | null; stage?: "texture" | "writing" | null; bytes?: number | null } = {}): string {
    switch (status) {
        case "describing":
            return "Looking at the model";
        case "planning":
            return "Planning the edit";
        case "refining":
            return "Looking closer at the part";
        case "applying":
            if (detail.stage === "texture") return "Repainting";
            if (detail.stage === "writing") return "Building the new model";
            return detail.step && detail.step.total > 1 ? `Applying the edit (${detail.step.index} of ${detail.step.total})` : "Applying the edit";
        case "saving":
            return detail.bytes ? `Saving ${megabytes(detail.bytes)}` : "Saving";
        case "saved":
            return "Done";
        case "noop":
            return "Nothing to change";
        case "error":
            return "Could not finish";
    }
}

/** A design edit's stage from the job (the server writes it: "Designing the change" while the model works, then "Building the 3D model"). */
export function designStageWords(job: Pick<Job, "stage" | "progress">): string {
    const words = (job.stage ?? "").replace(/\s*(?:…|\.{3})\s*$/, "").trim();
    if (words && words !== "Queued") return words;
    return job.progress >= 60 ? "Building the 3D model" : "Designing the change";
}

export interface EditFailure {
    kind: EditErrorKind;
    message: string;
}

/** A failure of the editor or the server as the card shows it. */
export function failureOf(error: unknown, fallbackKind: EditErrorKind): EditFailure {
    if (error instanceof MeshEditError) {
        const kind: EditErrorKind = error.code === "unsupported" ? "unsupported" : error.code === "notfound" ? "notfound" : error.code === "toomuch" ? "toomuch" : error.code === "toobig" ? "toobig" : fallbackKind;
        return { kind, message: error.message };
    }
    if (error instanceof ApiRequestError) {
        if (error.status === 429) return { kind: fallbackKind, message: error.message };
        if (error.status === 401) return { kind: fallbackKind, message: "Enter the access code to edit models." };
        return { kind: fallbackKind, message: error.message };
    }
    return { kind: fallbackKind, message: error instanceof Error && error.message ? error.message : "Something went wrong. Please try again." };
}

/** The card's title for a failure. Only a start that never got a job "could not start"; a job that failed after it began "did not work". */
export function errorTitle(kind: EditErrorKind, hasJob: boolean): string {
    switch (kind) {
        case "start":
            return hasJob ? "The edit did not work" : "Could not start the edit";
        case "plan":
            return "Could not plan the edit";
        case "unsupported":
            return "This model can't be edited here";
        case "notfound":
            return "Could not find that part";
        case "toomuch":
            return "That would change too much";
        case "toobig":
            return "The result would be too big";
        case "apply":
            return "Could not apply the edit";
        case "save":
            return "Could not save the edit";
    }
}

/**
 * "This model's format can't be edited here (quantised geometry)." -> the plain sentence, and the technical reason for a tooltip. The words
 * in the brackets are for people who know the file format; nobody else can use them.
 */
export function splitTechnical(message: string): { plain: string; detail: string | null } {
    const m = /^(.*?can't be edited here)\s*\((.+)\)\.?$/s.exec(message.trim());
    return m ? { plain: `${m[1]}.`, detail: m[2] } : { plain: message, detail: null };
}

/** Does this failure make "generate it again with Hunyuan" a reasonable next step? (The edit itself cannot work on this model.) */
export function offersRegenerate(kind: EditErrorKind): boolean {
    return kind === "unsupported" || kind === "notfound" || kind === "toomuch" || kind === "toobig" || kind === "apply";
}

/** Does this failure make "try again" (the words back in the box) a reasonable next step? The edit itself was fine, the attempt was not. */
export function offersTryAgain(kind: EditErrorKind): boolean {
    return kind === "start" || kind === "plan";
}

/** What the card says where Undo would be, when versions were made from the edit (`later` of them): Undo would delete them with it. */
export function undoBlockedText(later: number): string {
    return `${later === 1 ? "Another version was" : `${later} other versions were`} made from this one, so Undo is off. To remove it, delete it in the Models tab, which removes ${later === 1 ? "that version" : "those versions"} too.`;
}

/** The model and everything made from it (any depth), through source_model_id. */
export function familyOf(models: readonly Pick<ModelAsset, "id" | "source_model_id">[], id: string): string[] {
    const out = [id];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
        for (const m of models) {
            if (m.source_model_id === out[i] && !seen.has(m.id)) {
                seen.add(m.id);
                out.push(m.id);
            }
        }
    }
    return out;
}

/** What "generate it again" starts from: the plan's rewrite of the original prompt, else the original prompt and the change. At most 1000 characters (Hunyuan takes 1024). */
export function regeneratePrompt(source: Pick<ModelAsset, "prompt">, instruction: string, result: Pick<EditResult, "regen_prompt"> | null): string {
    const planned = result?.regen_prompt?.replace(/\s+/g, " ").trim();
    if (planned) return planned.slice(0, 1000);
    const change = instruction.replace(/\s+/g, " ").trim();
    const base = source.prompt.replace(/\s+/g, " ").trim();
    const joined = base ? `${base.slice(0, Math.max(0, 1000 - change.length - 2)).trimEnd()}, ${change}` : change;
    return joined.slice(0, 1000);
}

/** The job's stored plan when it is one that can be applied: a mesh job that succeeded, said it could do the edit, and has ops. */
export function applicablePlan(job: Job): EditResult | null {
    const result = job.edit?.result ?? null;
    if (job.kind !== "edit" || job.edit?.target !== "mesh" || job.status !== "succeeded" || !result?.applied || !result.program || result.program.ops.length === 0) return null;
    return result;
}

/** "Plan ready, apply?": a mesh edit that was planned but whose model was never saved (the page was closed mid-run). */
export const isPlanReady = (job: Job): boolean => job.model === null && applicablePlan(job) !== null;

/** Did the edit make the structural verdict worse (more problems than its source)? Only when both have been checked. */
export function verdictWorse(source: Pick<ModelAsset, "analysis"> | undefined, edited: Pick<ModelAsset, "analysis">): boolean {
    if (!source?.analysis || !edited.analysis) return false;
    return edited.analysis.errors > source.analysis.errors;
}

/** A line for the chat after a saved mesh edit. */
export function savedLine(summary: string): string {
    const text = summary.replace(/\s+/g, " ").trim();
    return text ? (/[.!?]$/.test(text) ? text : `${text}.`) : "Edited the model.";
}

// ---------- what the card shows ----------

/** The run the card may know about (store/edit.ts EditRun), reduced to what the card reads. */
export interface RunView {
    key: string;
    jobId: string | null;
    sourceModelId: string;
    instruction: string;
    target: "design" | "mesh";
    status: EditStatus;
    startedAt: number;
    step: { index: number; total: number; label: string } | null;
    stage: "texture" | "writing" | null;
    summary: string | null;
    notes: string[];
    errorKind: EditErrorKind | null;
    error: string | null;
    savedModelId: string | null;
    regenPrompt: string | null;
    resultBytes: number | null;
    hasLocalResult: boolean;
}

export type CardState =
    /** Under way. `canStop`: the Stop button is offered. */
    | { kind: "working"; words: string; startedAt: number | null; canStop: boolean; stageIndex: number }
    /** Done: the new version exists and is in the project. */
    | { kind: "done"; model: ModelAsset; source: ModelAsset | null; summary: string; notes: string[] }
    /** The version was taken away: by Undo here ("undone") or otherwise ("gone"). */
    | { kind: "undone" }
    | { kind: "gone" }
    /** The model said it cannot do this (or nothing changed): no new version. */
    | { kind: "noop"; summary: string; notes: string[] }
    /** A mesh plan that was made but never run (the page was closed in between). */
    | { kind: "plan-ready"; summary: string; notes: string[] }
    | { kind: "error"; errorKind: EditErrorKind; message: string; hasLocalResult: boolean }
    | { kind: "canceled" };

const RUNNING: readonly Job["status"][] = ["queued", "running", "finalizing"];

/** Which of the card's states an edit is in, from its job, its local run (if this page has one) and the project's models. */
export function cardStateOf(input: { job: Job | null; run: RunView | undefined; models: readonly ModelAsset[]; undone: Record<string, true> }): CardState {
    const { job, run, models, undone } = input;
    const modelState = (id: string, summary: string, notes: string[]): CardState => {
        const model = models.find((m) => m.id === id);
        if (!model) return undone[id] ? { kind: "undone" } : { kind: "gone" };
        const source = models.find((m) => m.id === model.source_model_id) ?? null;
        return { kind: "done", model, source, summary: model.edit?.summary || summary, notes: model.edit?.notes.length ? model.edit.notes : notes };
    };
    if (run) {
        if (run.status === "saved" && run.savedModelId) return modelState(run.savedModelId, run.summary ?? "", run.notes);
        if (run.status === "noop") return { kind: "noop", summary: run.summary ?? "This edit could not be done.", notes: run.notes };
        if (run.status === "error") return { kind: "error", errorKind: run.errorKind ?? "apply", message: run.error ?? "The edit could not be finished.", hasLocalResult: run.hasLocalResult };
        const words = stageWords(run.status, { step: run.step, stage: run.stage, bytes: run.resultBytes });
        return { kind: "working", words, startedAt: run.startedAt, canStop: run.status !== "saving", stageIndex: ["describing", "planning", "refining", "applying", "saving"].indexOf(run.status) };
    }
    if (!job) return { kind: "gone" };
    const startedAt = Date.parse(job.created_at);
    const started = Number.isFinite(startedAt) ? startedAt : null;
    if (RUNNING.includes(job.status)) {
        const words = job.edit?.target === "design" ? designStageWords(job) : "Planning the edit";
        return { kind: "working", words, startedAt: started, canStop: true, stageIndex: job.progress >= 60 ? 3 : 1 };
    }
    if (job.status === "canceled") return { kind: "canceled" };
    if (job.status === "failed") return { kind: "error", errorKind: job.edit?.target === "mesh" ? "plan" : "start", message: job.error || "The edit could not be made.", hasLocalResult: false };
    // succeeded
    const result = job.edit?.result ?? null;
    if (job.model) return modelState(job.model.id, result?.summary ?? "", result?.notes ?? []);
    if (isPlanReady(job)) return { kind: "plan-ready", summary: result?.summary ?? "", notes: result?.notes ?? [] };
    // The project payload carries the stored result only for a job that has no model (db.ts toJob): a succeeded job with neither is one whose
    // version was deleted (its model_id column is still set), after an Undo made on another screen or before a reload.
    if (!job.edit) return { kind: "error", errorKind: "plan", message: "The edit finished, but its result is not available.", hasLocalResult: false };
    if (!result) return { kind: "gone" };
    if (job.edit?.target === "design" || !result.applied) return { kind: "noop", summary: result.summary || "Nothing was changed.", notes: result.notes };
    return { kind: "error", errorKind: "plan", message: "The edit finished, but its result is not available.", hasLocalResult: false };
}

/** The model that "generate it as a new model" uses: the parts designer when the edited model came from it (it costs nothing), else Hunyuan. */
export function generationProviderFor(source: Pick<ModelAsset, "provider"> | null): "muse" | "hunyuan" {
    return source?.provider === "muse" ? "muse" : "hunyuan";
}
