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
 * What to show for a saved reply, given the jobs it points at (those that still exist). While any is
 * running the saved text stands; once all have ended, the line says how it went.
 */
export function replyLine(
    content: string,
    jobs: readonly Job[],
    providers: readonly ProviderInfo[] | undefined,
): string {
    if (jobs.length === 0 || jobs.some(running)) return content;
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
