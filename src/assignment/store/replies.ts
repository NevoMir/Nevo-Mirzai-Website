// The assistant's one-line reply above a prompt's job cards.
//
// It is written when the prompt is sent ("Generating with X."), but the cards below it outlive that
// moment: a finished or failed run must not keep saying it is generating, in this session or after a
// reload. So the saved text is only the wording for a run in progress; what is shown follows the jobs.

import type { Job, ProviderId, ProviderInfo } from "@/assignment/shared/contract";
import { providerLabel } from "@/assignment/store/providers";

const bold = (providers: readonly ProviderInfo[] | undefined, id: ProviderId): string =>
    `**${providerLabel(providers, id)}**`;

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The text saved with the reply when a run starts. */
export function replyContent(
    providers: readonly ProviderInfo[] | undefined,
    ids: readonly ProviderId[],
    retry: boolean,
): string {
    const list = joinNames(ids.map((id) => bold(providers, id)));
    if (retry) return `Trying ${list} again.`;
    return ids.length === 1 ? `Generating with ${list}.` : `Comparing ${list} on the same prompt.`;
}

const running = (job: Job): boolean => job.status === "queued" || job.status === "running" || job.status === "finalizing";

/**
 * The line for a change of a design or a mesh, worded for how the job stands. An edit has one job, run by one model: the reply says whether
 * the model made the change, planned it (a mesh edit waits for the browser to apply it), declined it, or failed.
 */
export function editReplyLine(job: Job, providers: readonly ProviderInfo[] | undefined): string {
    const who = bold(providers, job.provider);
    if (job.status === "succeeded") {
        if (job.model) return `Changed with ${who}.`;
        const result = job.edit?.result ?? null;
        if (result && !result.applied) return `${who} could not make that change.`;
        return `${who} planned the change.`;
    }
    if (job.status === "canceled") return `Stopped ${who}.`;
    return `${who} could not make this change.`;
}

/**
 * What to show for a saved reply, given the jobs it points at (those that still exist). While any is
 * running the saved text stands; once all have ended, the line says how it went.
 */
export function replyLine(
    content: string,
    jobs: readonly Job[],
    providers: readonly ProviderInfo[] | undefined,
): string {
    if (jobs.length === 0 || jobs.some(running)) return content;
    if (jobs.length === 1 && jobs[0].kind === "edit") return editReplyLine(jobs[0], providers);
    const names = joinNames(jobs.map((job) => bold(providers, job.provider)));
    const made = jobs.filter((job) => job.status === "succeeded").length;
    if (jobs.length === 1) {
        if (made === 1) return `Generated with ${names}.`;
        return jobs[0].status === "canceled" ? `Stopped ${names}.` : `${names} could not generate this model.`;
    }
    if (made === jobs.length) return `Compared ${names} on the same prompt.`;
    if (made === 0) return `None of ${names} produced a model.`;
    return `Compared ${names}: ${made} of ${jobs.length} produced a model.`;
}
