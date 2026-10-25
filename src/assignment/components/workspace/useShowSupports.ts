import { useCallback, useState } from "react";

/** The "Show added supports" choice outlives the page's remounts (leaving the workspace and coming back) but not the browser tab. */
export const SHOW_SUPPORTS_KEY = "assembly-studio-show-supports";

/** Stored text -> the choice; anything but an explicit "0" means on (the default). */
export function parseShowSupports(raw: string | null | undefined): boolean {
    return raw !== "0";
}

function read(): boolean {
    try {
        return parseShowSupports(window.sessionStorage.getItem(SHOW_SUPPORTS_KEY));
    } catch {
        // Storage can be blocked (private windows, embedded frames): the choice then lasts as long as the page.
        return true;
    }
}

function write(value: boolean): void {
    try {
        window.sessionStorage.setItem(SHOW_SUPPORTS_KEY, value ? "1" : "0");
    } catch {
        // See read().
    }
}

/** The viewer's "Show added supports" toggle: on by default, kept for the browser session. */
export function useShowSupports(): [boolean, (value: boolean) => void] {
    const [value, setValue] = useState(read);
    const set = useCallback((next: boolean) => {
        setValue(next);
        write(next);
    }, []);
    return [value, set];
}
