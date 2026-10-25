// Colours and icons the analysis report shares: the tone of a verdict or a row, and the mark of a figure. Class names are written out in full so Tailwind finds them.

import { Check, CircleCheck, CircleX, Dot, TriangleAlert, X, type LucideIcon } from "lucide-react";

import type { Mark } from "@/assignment/store/analysisBrief";
import type { VerdictKind } from "@/assignment/store/analysisLogic";

export type Tone = "pass" | "warn" | "fail" | "info" | "muted";

export interface ToneStyle {
    /** Readable text on the panel in both themes. */
    text: string;
    /** The colour of an icon or a dot (may be lighter than text). */
    icon: string;
    /** A faint wash behind a banner or a chip. */
    soft: string;
    border: string;
    /** A solid fill (stripes, segments). */
    solid: string;
}

export const TONE: Record<Tone, ToneStyle> = {
    pass: {
        text: "text-green-700 dark:text-green-400",
        icon: "text-success",
        soft: "bg-success/10",
        border: "border-success/35",
        solid: "bg-success",
    },
    warn: {
        text: "text-amber-700 dark:text-amber-400",
        icon: "text-warning",
        soft: "bg-warning/10",
        border: "border-warning/45",
        solid: "bg-warning",
    },
    fail: {
        text: "text-red-700 dark:text-red-400",
        icon: "text-destructive",
        soft: "bg-destructive/10",
        border: "border-destructive/40",
        solid: "bg-destructive",
    },
    info: {
        text: "text-primary",
        icon: "text-primary",
        soft: "bg-primary/10",
        border: "border-primary/30",
        solid: "bg-primary",
    },
    muted: {
        text: "text-muted-foreground",
        icon: "text-muted-foreground",
        soft: "bg-muted",
        border: "border-border",
        solid: "bg-muted-foreground/50",
    },
};

/**
 * What a figure or a row says about itself, as a symbol and a word as well as a colour: a tick, a cross, a warning triangle or
 * a quiet dot (no pass or fail to speak of). Never colour alone.
 */
export type { Mark };
export const MARK_ICON: Record<Mark, LucideIcon> = { pass: Check, warn: TriangleAlert, fail: X, none: Dot };
export const MARK_TONE: Record<Mark, Tone> = { pass: "pass", warn: "warn", fail: "fail", none: "muted" };
/** The word a screen reader hears for a mark ("Balance: fails"). */
export const MARK_WORD: Record<Mark, string> = { pass: "passes", warn: "needs a look", fail: "fails", none: "for information" };

export const VERDICT_TONE: Record<VerdictKind, Tone> = { pass: "pass", warn: "warn", fail: "fail" };
export const VERDICT_ICON: Record<VerdictKind, LucideIcon> = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX };
