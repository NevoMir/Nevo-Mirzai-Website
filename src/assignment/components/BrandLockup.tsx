import { Boxes } from "lucide-react";

import { SERIF } from "@/assignment/lib/fonts";

/**
 * The brand lockup: the "Assembly Studio" wordmark with its Boxes mark.
 *
 * Same API as Cably's lockup so every call site ports unchanged: the word sits over
 * the mark everywhere the brand appears with its name (the chat hero, the chat
 * header), and `layout="row"` puts them side by side (the hub sidebar). Unlike
 * Cably's artwork, the mark is a lucide icon in the accent colour, so it needs no
 * light/dark variant; `dark` is accepted for call-site compatibility and ignored.
 */
const SIZES = {
    /** Chat header. */
    sm: { word: "text-[18px]", icon: "h-4 w-4", gap: "gap-0.5" },
    /** A larger header lockup. */
    md: { word: "text-[20px] lg:text-[22px]", icon: "h-4 w-4 lg:h-5 lg:w-5", gap: "gap-0.5" },
    /** The new-chat hero. */
    lg: { word: "text-[40px]", icon: "h-9 w-9", gap: "gap-2" },
} as const;

/** Side by side: the mark to the left of the word; it is taller here than in the
 *  stack, where the word carries the height. */
const ROW_SIZES = {
    sm: { word: "text-[18px]", icon: "h-5 w-5", gap: "gap-1.5" },
    md: { word: "text-[22px] lg:text-[24px]", icon: "h-6 w-6 lg:h-7 lg:w-7", gap: "gap-2" },
    lg: { word: "text-[40px]", icon: "h-10 w-10", gap: "gap-3" },
} as const;

interface BrandLockupProps {
    size: keyof typeof SIZES;
    /** "stack" (default) puts the word over the mark; "row" puts the mark to its left. */
    layout?: "stack" | "row";
    /** Unused (the mark is theme-neutral); kept so Cably's call sites compile unchanged. */
    dark?: boolean;
    className?: string;
    /** Overrides the default `text-foreground`. */
    wordColor?: string;
}

export function BrandLockup({ size, layout = "stack", className = "", wordColor }: BrandLockupProps) {
    const row = layout === "row";
    const { word, icon, gap } = (row ? ROW_SIZES : SIZES)[size];
    return (
        <span
            data-layout={layout}
            className={`flex max-w-full items-center ${row ? "flex-row-reverse" : "flex-col"} ${gap} ${className}`}
        >
            <span
                className={`${word} whitespace-nowrap leading-none text-foreground`}
                style={{ fontFamily: SERIF, fontWeight: 600, color: wordColor }}
            >
                Assembly Studio
            </span>
            {/* Decorative: the word beside it is the name. */}
            <Boxes className={`${icon} shrink-0 text-accent`} strokeWidth={1.75} aria-hidden />
        </span>
    );
}
