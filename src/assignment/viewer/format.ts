// Small display helpers. No three.js.

/** 12.3 -> "12.3", 100 -> "100", 0.04 -> "0.04": up to one decimal above 10, two below. */
export function num(value: number): string {
    if (!Number.isFinite(value)) return "0";
    const digits = Math.abs(value) >= 10 ? 1 : 2;
    return String(Number(value.toFixed(digits)));
}

/** 1234 -> "1,234", 84_300 -> "84.3k", 1_250_000 -> "1.25M". */
export function formatCount(value: number): string {
    if (value >= 1_000_000) return `${num(value / 1_000_000)}M`;
    if (value >= 10_000) return `${num(value / 1000)}k`;
    return Math.round(value).toLocaleString("en-US");
}

/** A safe download file name: no path separators or control characters, never empty. */
export function safeFileName(title: string | undefined, fallback = "model"): string {
    const cleaned = (title ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\\/:*?"<>|%]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)
        .trim();
    return cleaned || fallback;
}

/** Does this title already say it is the stabilized version? ("Stabilized · {prompt}" is how the workspace names one.) */
const saysStabilized = (title: string | undefined) => /\bstabili[sz]ed\b/i.test(title ?? "");

/**
 * The stage's accessible name. A stabilized model keeps its source's prompt, so without a word of its own a screen reader
 * hears the same name for both versions.
 */
export function stageLabel(title: string | undefined, stabilized = false): string {
    const base = `3D model${title ? ` of ${title}` : ""}`;
    return stabilized && !saysStabilized(title) ? `${base} (stabilized)` : base;
}

/** The download file name (no extension) of the model on stage: the original's and the stabilized version's differ. */
export function downloadStem(title: string | undefined, stabilized = false): string {
    const stem = safeFileName(title);
    return stabilized && !saysStabilized(title) ? `${stem}-stabilized` : stem;
}

/**
 * The toolbar download's label. The host passes another file than the one on stage only for a stabilized model shown on its
 * source mesh, and that file is the stabilized block assembly: say so from the moment the toolbar is there, not once an analysis
 * has counted the added blocks (it may be late, fail, or find none). undefined: the toolbar's own "Download GLB".
 */
export function downloadLabelFor(downloadUrl: string | null | undefined, url: string | null, label?: string): string | undefined {
    return downloadUrl && downloadUrl !== url ? (label ?? "Download stabilized GLB") : undefined;
}

/** What the parts list and the hover tooltip say about a part: its own line ("12 blocks" for a role), else its triangle count. */
export function partDetail(row: { detail?: string; triangles: number }): string {
    return row.detail ?? `${formatCount(row.triangles)} triangles`;
}
