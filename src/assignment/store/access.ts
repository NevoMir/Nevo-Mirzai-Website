// The access-code dialog as a function: `await requestAccessCode()` from anywhere (a send, a retry,
// the Stop button, a keyboard shortcut) and it resolves true once a valid code is stored, false when
// the visitor dismisses it. The dialog itself is rendered once, by the chat panel, from `open`.

import { create } from "zustand";

import { ApiRequestError, clearAccessCode } from "@/assignment/lib/api";

let resolver: ((ok: boolean) => void) | null = null;

export const useAccessPrompt = create<{ open: boolean }>()(() => ({ open: false }));

export function requestAccessCode(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        // A newer ask supersedes one nobody answered.
        resolver?.(false);
        resolver = resolve;
        useAccessPrompt.setState({ open: true });
    });
}

/** The dialog's answer; also how the page cancels a pending ask when it goes away. */
export function settleAccessPrompt(ok: boolean): void {
    const resolve = resolver;
    resolver = null;
    useAccessPrompt.setState({ open: false });
    resolve?.(ok);
}

/**
 * Runs `work`; when the server refuses the stored access code (401) the code is forgotten, the dialog asks for a new one, and `work` runs once
 * more if one is entered. The AI calls that are not generation (a block edit, the optimizer's goal) use it as generation does.
 */
export async function withAccessRetry<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
            clearAccessCode();
            if (await requestAccessCode()) return work();
        }
        throw err;
    }
}
