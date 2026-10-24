// Colours and icons the analysis report shares: the tone of a verdict or a row, the swatches of the legend
// and the icon of each kind of issue. Class names are written out in full so Tailwind finds them.

import {
    Activity,
    ArrowRightFromLine,
    CircleCheck,
    CircleX,
    Flame,
    Info,
    Package,
    PackageOpen,
    Ruler,
    Scale,
    TriangleAlert,
    Unplug,
    type LucideIcon,
} from "lucide-react";

import type { IssueKind } from "@/assignment/analysis/types";
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

export const VERDICT_TONE: Record<VerdictKind, Tone> = { pass: "pass", warn: "warn", fail: "fail" };
export const VERDICT_ICON: Record<VerdictKind, LucideIcon> = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX };

export const CHECK_ICON: Record<"pass" | "fail" | "info", LucideIcon> = { pass: CircleCheck, fail: CircleX, info: Info };
export const CHECK_TONE: Record<"pass" | "fail" | "info", Tone> = { pass: "pass", fail: "fail", info: "info" };

export const ISSUE_ICON: Record<IssueKind, LucideIcon> = {
    empty: PackageOpen,
    "cog-outside": Scale,
    "cantilever-too-long": ArrowRightFromLine,
    floating: Unplug,
    "too-many-blocks": Package,
    "thin-features": Ruler,
    overstressed: Flame,
    "highly-stressed": Activity,
};
