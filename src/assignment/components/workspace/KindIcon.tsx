import { Blocks, Box, PencilLine, SlidersHorizontal } from "lucide-react";

import { cn } from "@/assignment/lib/utils";
import type { ModelKind } from "@/assignment/shared/contract";

/** The glyph of a kind of model: a box for an original, a pencil for a change by words, blocks for a stabilized one, sliders for an optimized one. */
export function KindIcon({ kind, className }: { kind: ModelKind; className?: string }) {
    const cls = cn("h-3.5 w-3.5 shrink-0", className);
    switch (kind) {
        case "edited":
            return <PencilLine className={cls} aria-hidden />;
        case "stabilized":
            return <Blocks className={cls} aria-hidden />;
        case "optimized":
            return <SlidersHorizontal className={cls} aria-hidden />;
        default:
            return <Box className={cls} aria-hidden />;
    }
}

/** The indent of the deepest tree row that is drawn with its own step; deeper rows share the last one (a chain of 12 must not push its text away). */
export const TREE_INDENT_CAP = 5;

/**
 * The connector lines of a tree row: a vertical line for every ancestor that has later siblings, then the elbow into the row. `lines` and
 * `last` come from `treeRows`. Each step is `cell` px wide.
 */
export function TreeConnector({ depth, lines, last, cell = 16, className }: { depth: number; lines: readonly boolean[]; last: boolean; cell?: number; className?: string }) {
    if (depth === 0) return null;
    const shown = Math.min(depth, TREE_INDENT_CAP);
    const ancestors = lines.slice(Math.max(0, lines.length - (shown - 1)));
    return (
        <span aria-hidden className={cn("flex shrink-0 self-stretch", className)} style={{ width: shown * cell }} data-testid="tree-connector" data-depth={depth}>
            {ancestors.map((line, n) => (
                <span key={n} className="relative" style={{ width: cell }}>
                    {line && <span className="absolute inset-y-0 left-1/2 w-px bg-border" />}
                </span>
            ))}
            <span className="relative" style={{ width: cell }}>
                <span className="absolute left-1/2 top-0 h-1/2 w-px bg-border" />
                {!last && <span className="absolute bottom-0 left-1/2 top-1/2 w-px bg-border" />}
                <span className="absolute left-1/2 top-1/2 h-px w-1/2 bg-border" />
            </span>
        </span>
    );
}
