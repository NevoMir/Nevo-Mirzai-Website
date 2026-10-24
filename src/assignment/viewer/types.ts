// Shared types for the GLB viewer. Type-only (no runtime code), so the React side can
// import them without pulling three.js into the main bundle.

export type Vec3 = [number, number, number];

/** The stage's theme: light follows the --background token, dark is Cably's 3D grey gradient. */
export type ViewTheme = "light" | "dark";

/** "fit" = the last preset's direction, framed on everything shown. */
export type ViewPreset = "fit" | "iso" | "top" | "front" | "right";

export interface CameraState {
    position: Vec3;
    target: Vec3;
}

/** Pixels of the stage covered by floating UI (the top bar, the chat panel...). */
export interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/** A point in client (viewport) pixels. */
export interface Px {
    x: number;
    y: number;
}

/** A part as the parts list and the selection card say it. */
export interface PartRow {
    /** Its pick id ("p1".. for glTF parts, "s1".. for split pieces). */
    id: string;
    /** Display name, already de-duplicated ("Gear", "Gear · 2"). */
    name: string;
    triangles: number;
    /** Size in mm along X, Y, Z of the Z-up scene (the longest side of the whole model is ~100 mm). */
    size: Vec3 | null;
}

/** What the scene is told to show: hover, selection, hidden parts and isolation. */
export interface LookPatch {
    hover?: string | null;
    selected?: readonly string[];
    hidden?: readonly string[];
    isolated?: readonly string[] | null;
}
