// HTML labels pinned to points of the 3D scene: the block tooltip, the dimension labels, the COG note and the
// callout of a focused issue. They are DOM, not sprites, so the text stays crisp and follows the theme. The
// layer moves them imperatively after every rendered frame (a React render per camera move would be far too
// much), and creates them with the same Tailwind classes the rest of the UI uses.
//
// No three.js: the viewer hands in a projector (world point -> stage px). Labels never take pointer events.
//
// The layer sits over the whole stage, but the floating UI (top bar, report dock, chat panel, toolbar) covers
// parts of it and is drawn above the labels. `setInsets` tells the layer how much of each side is covered, and
// the labels that are kept in view (clamp) are kept inside the part that is left, flipping to the other side of
// their anchor when there is no room, instead of sliding under the UI.
import type { BlockInfo, LabelTone, SceneLabel } from "./analysisGeometry.ts";
import type { Insets, Vec3 } from "./types.ts";

export type Projector = (point: Vec3) => { x: number; y: number; visible: boolean };
export type Placement = "above" | "below" | "left" | "right" | "center";

interface Item {
    anchor: Vec3;
    el: HTMLElement;
    placement: Placement;
    offset: number;
    /** Kept inside the stage (a tooltip), or left to hang over its edge. */
    clamp: boolean;
    /** Identifies the content, so an unchanged label is not rebuilt (it only moves). */
    key: string;
    width: number;
    height: number;
    measured: boolean;
    /** Set while the callout bubble has no room on the right. */
    flip: boolean;
    /** Set while it has no room above its marker. */
    vflip: boolean;
}

export interface LabelLayer {
    /** Creates or replaces a label. */
    set(id: string, spec: { anchor: Vec3; el: () => HTMLElement; key: string; placement?: Placement; offset?: number; clamp?: boolean }): void;
    has(id: string): boolean;
    remove(id: string): void;
    /** Drops every label whose id is not in `keep`. */
    retain(keep: ReadonlySet<string>): void;
    /** The px covered by floating UI on each side; labels that are kept in view stay out of them. null: the whole stage is free. */
    setInsets(insets: Insets | null): void;
    /** Repositions everything for the camera as it is now. */
    update(): void;
    dispose(): void;
}

const EDGE_PX = 6;
/** A free rect smaller than this is not worth honouring (a tiny window): the whole stage is used instead. */
const MIN_FREE_PX = { width: 120, height: 80 };
/** Where a callout's bubble sits: this far beside its marker, and this far above (or below) it. */
const BUBBLE_SIDE_PX = 12;
const BUBBLE_RISE_PX = 28;

interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** The part of a host `width` x `height` the insets leave free; the whole host when they leave too little. */
export function freeRect(width: number, height: number, insets: Insets | null): Rect {
    const whole = { x0: 0, y0: 0, x1: width, y1: height };
    if (!insets) return whole;
    const rect = { x0: Math.max(0, insets.left), y0: Math.max(0, insets.top), x1: width - Math.max(0, insets.right), y1: height - Math.max(0, insets.bottom) };
    return rect.x1 - rect.x0 < MIN_FREE_PX.width || rect.y1 - rect.y0 < MIN_FREE_PX.height ? whole : rect;
}

export function createLabelLayer(host: HTMLElement, project: Projector): LabelLayer {
    const items = new Map<string, Item>();
    let insets: Insets | null = null;

    const place = (item: Item, r: Rect) => {
        const p = project(item.anchor);
        if (!p.visible || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            item.el.style.visibility = "hidden";
            return;
        }
        if (!item.measured) {
            item.width = item.el.offsetWidth;
            item.height = item.el.offsetHeight;
            item.measured = item.width > 0 || item.height > 0 || item.el.dataset.bubble !== undefined;
        }
        const { width: w, height: h } = item;
        let placement = item.placement;
        const o = item.offset;
        if (item.clamp) {
            // Out of room on one side of the anchor: the other, when that fits.
            if (placement === "above" && p.y - h - o < r.y0 + EDGE_PX) placement = "below";
            else if (placement === "below" && p.y + h + o > r.y1 - EDGE_PX) placement = "above";
            else if (placement === "left" && p.x - w - o < r.x0 + EDGE_PX && p.x + o + w <= r.x1 - EDGE_PX) placement = "right";
            else if (placement === "right" && p.x + o + w > r.x1 - EDGE_PX && p.x - w - o >= r.x0 + EDGE_PX) placement = "left";
        }
        let x = p.x;
        let y = p.y;
        if (placement === "above") [x, y] = [p.x - w / 2, p.y - h - o];
        else if (placement === "below") [x, y] = [p.x - w / 2, p.y + o];
        else if (placement === "right") [x, y] = [p.x + o, p.y - h / 2];
        else if (placement === "left") [x, y] = [p.x - w - o, p.y - h / 2];
        else [x, y] = [p.x - w / 2, p.y - h / 2];
        if (item.clamp) {
            x = Math.min(Math.max(x, r.x0 + EDGE_PX), Math.max(r.x0 + EDGE_PX, r.x1 - w - EDGE_PX));
            y = Math.min(Math.max(y, r.y0 + EDGE_PX), Math.max(r.y0 + EDGE_PX, r.y1 - h - EDGE_PX));
        }
        item.el.style.visibility = "visible";
        item.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        // The callout's bubble swings to the other side of its marker (and below it) near the edges of the free part.
        const body = item.el.dataset.bubble === "true" ? item.el.querySelector<HTMLElement>("[data-bubble-body]") : null;
        if (body) {
            const roomRight = r.x1 - EDGE_PX - (p.x + BUBBLE_SIDE_PX);
            const roomLeft = p.x - BUBBLE_SIDE_PX - (r.x0 + EDGE_PX);
            const flip = body.offsetWidth > roomRight && roomLeft > roomRight;
            const vflip = body.offsetHeight + BUBBLE_RISE_PX > p.y - (r.y0 + EDGE_PX) && r.y1 - EDGE_PX - p.y > p.y - (r.y0 + EDGE_PX);
            if (flip !== item.flip) {
                item.flip = flip;
                item.el.dataset.flip = flip ? "true" : "false";
            }
            if (vflip !== item.vflip) {
                item.vflip = vflip;
                item.el.dataset.vflip = vflip ? "true" : "false";
            }
        }
    };

    return {
        set(id, spec) {
            const existing = items.get(id);
            if (existing && existing.key === spec.key) {
                existing.anchor = spec.anchor;
                if (spec.placement) existing.placement = spec.placement;
                return;
            }
            existing?.el.remove();
            const el = spec.el();
            el.style.position = "absolute";
            el.style.left = "0";
            el.style.top = "0";
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
            el.style.willChange = "transform";
            host.appendChild(el);
            items.set(id, { anchor: spec.anchor, el, placement: spec.placement ?? "above", offset: spec.offset ?? 8, clamp: spec.clamp ?? false, key: spec.key, width: 0, height: 0, measured: false, flip: false, vflip: false });
        },
        has: (id) => items.has(id),
        remove(id) {
            items.get(id)?.el.remove();
            items.delete(id);
        },
        retain(keep) {
            for (const id of [...items.keys()]) {
                if (keep.has(id)) continue;
                items.get(id)?.el.remove();
                items.delete(id);
            }
        },
        setInsets(next) {
            insets = next;
        },
        update() {
            if (!items.size) return;
            const rect = freeRect(host.clientWidth, host.clientHeight, insets);
            for (const item of items.values()) place(item, rect);
        },
        dispose() {
            for (const item of items.values()) item.el.remove();
            items.clear();
        },
    };
}

// ---------- builders ----------

const make = (tag: string, className: string, text?: string): HTMLElement => {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
};

const TONE_TEXT: Record<LabelTone, string> = {
    neutral: "text-muted-foreground",
    ok: "text-emerald-600 dark:text-emerald-400",
    bad: "text-red-600 dark:text-red-400",
    accent: "text-primary",
};

const FADE = "animate-in fade-in-0 duration-150 motion-reduce:animate-none";
const PANEL = "rounded-lg border border-border bg-popover text-popover-foreground shadow-md";

/** The hover tooltip of a block: where it is, and what state it is in and why. `color` is the block's colour. */
export function blockTooltip(info: BlockInfo, color: string): HTMLElement {
    const el = make("div", `${PANEL} ${FADE} w-max max-w-[18rem] px-2.5 py-1.5 text-xs`);
    el.setAttribute("role", "tooltip");
    const head = make("div", "flex items-baseline justify-between gap-3");
    head.append(make("span", "font-medium", info.title), make("span", "tabular-nums text-muted-foreground", info.zRange));
    const status = make("div", "mt-0.5 flex items-center gap-1.5");
    const swatch = make("span", "inline-block h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-black/20");
    swatch.style.background = color;
    const text = make("span", "");
    text.append(make("span", "font-medium", info.statusLabel), document.createTextNode(` · ${info.detail}`));
    status.append(swatch, text);
    el.append(head, status);
    return el;
}

/** A label of the scene itself (dimension, centre of gravity, tip direction, layer cut). */
export function sceneLabelElement(label: SceneLabel): HTMLElement {
    if (label.kind === "dimension") return make("div", "rounded bg-background/80 px-1 py-px font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur-sm", label.text);
    if (label.kind === "tip") return make("div", "rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white shadow", label.text);
    if (label.kind === "cut") {
        const el = make("div", "rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground shadow");
        el.append(document.createTextNode(label.text));
        if (label.sub) el.append(make("span", "ml-1 font-normal opacity-80", label.sub));
        return el;
    }
    const el = make("div", `${PANEL} px-2 py-1 text-xs`);
    const head = make("div", "flex items-center gap-1.5 font-medium");
    const dot = make("span", "inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white/70");
    dot.style.background = "#ce5222";
    head.append(dot, document.createTextNode(label.text));
    el.append(head);
    if (label.sub) el.append(make("div", `text-[11px] ${TONE_TEXT[label.tone]}`, label.sub));
    if (label.note) el.append(make("div", "text-[11px] text-muted-foreground", label.note));
    return el;
}

/**
 * The callout of a focused issue: a ringed marker on the point and a bubble up and to the right of it, joined to
 * it by a short stem (to the left near the right edge of the free part of the stage, below the marker near the
 * top). The bubble stands 28 px clear of the marker so it does not cover the COG label, which the marker shares a
 * point with when the centre of gravity is the issue. The element's origin is the marker's centre; the layer sets
 * `data-flip` and `data-vflip` on it.
 */
export function calloutElement(text: string | undefined): HTMLElement {
    const el = make("div", "group h-0 w-0");
    el.dataset.bubble = text ? "true" : "false";
    el.dataset.flip = "false";
    el.dataset.vflip = "false";
    const ring = make("span", "absolute -left-3 -top-3 h-6 w-6 rounded-full border-2 border-white bg-red-500/25 shadow ring-1 ring-black/30");
    const ping = make("span", "absolute -left-3 -top-3 h-6 w-6 rounded-full bg-red-500/40 motion-safe:animate-ping");
    el.append(ping, ring);
    if (text) {
        // The corner on the marker's side is square, so the bubble points at it.
        const bubble = make(
            "div",
            [
                FADE,
                "absolute bottom-7 left-3 w-max max-w-[16rem] rounded-xl bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg",
                "group-data-[flip=true]:left-auto group-data-[flip=true]:right-3 group-data-[vflip=true]:bottom-auto group-data-[vflip=true]:top-7",
                "group-data-[flip=false]:group-data-[vflip=false]:rounded-bl-none group-data-[flip=true]:group-data-[vflip=false]:rounded-br-none",
                "group-data-[flip=false]:group-data-[vflip=true]:rounded-tl-none group-data-[flip=true]:group-data-[vflip=true]:rounded-tr-none",
            ].join(" "),
            text,
        );
        bubble.dataset.bubbleBody = "";
        // From the bubble's square corner to the marker's ring (the bubble stands 28 px off the centre, the ring reaches 12).
        bubble.append(make("span", "absolute left-0 top-full h-4 w-0.5 bg-foreground group-data-[flip=true]:left-auto group-data-[flip=true]:right-0 group-data-[vflip=true]:bottom-full group-data-[vflip=true]:top-auto"));
        el.append(bubble);
    }
    return el;
}
