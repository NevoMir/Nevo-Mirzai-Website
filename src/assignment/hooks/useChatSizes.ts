import { useEffect, useState } from "react";

/** The chat panel's width wish, in pixels: react-resizable-panels (v2) only takes percentages. */
const CHAT_PREFERRED_PX = 340;
/** Under this the composer's model name and send button no longer fit side by side. */
const CHAT_MIN_PX = 280;
/** The widest the panel may be dragged to, in percent of the window. */
export const CHAT_MAX_PCT = 40;

export interface ChatSizes {
    /** Width the panel opens at, in percent. */
    preferred: number;
    /** Narrowest the panel may be dragged to, in percent. */
    min: number;
}

/**
 * The chat panel's default and minimum size, in percent, for a window this wide: a quarter of a wide
 * window, but never narrower than the pixels the composer needs (a quarter of 800 px is only 200).
 */
export function chatSizesFor(windowWidth: number): ChatSizes {
    const width = Math.max(windowWidth, 1);
    const half = (n: number) => Math.round(n * 2) / 2;
    const preferred = half(Math.min(CHAT_MAX_PCT, Math.max(25, (CHAT_PREFERRED_PX / width) * 100)));
    const min = half(Math.min(preferred, Math.max(18, (CHAT_MIN_PX / width) * 100)));
    return { preferred, min };
}

/** `chatSizesFor` for the live window; the identity of the result only changes when the numbers do. */
export function useChatSizes(): ChatSizes {
    const [sizes, setSizes] = useState(() => chatSizesFor(window.innerWidth));
    useEffect(() => {
        const onResize = () => {
            const next = chatSizesFor(window.innerWidth);
            setSizes((prev) => (prev.preferred === next.preferred && prev.min === next.min ? prev : next));
        };
        onResize();
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    return sizes;
}
