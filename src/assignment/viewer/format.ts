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
