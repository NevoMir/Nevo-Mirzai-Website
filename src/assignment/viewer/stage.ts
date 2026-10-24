// Stage colours, shared by the viewer (grid, thumbnail) and the React side (CSS background).
// No three.js here, so the React side can import it statically.
import type { ViewTheme } from "./types.ts";

/** Dark stage and thumbnail grey: a 3D-specific mid-grey gradient, because the dark token (#141414) gives mid-grey parts too little contrast (Cably's choice). */
const GREY_GRADIENT = { top: "#8a8f98", bottom: "#787d86" };

/**
 * The stage background. Light follows the theme's --background token; dark is the grey gradient. The
 * renderer clears transparent over this CSS background.
 */
export const STAGE_BACKGROUND: Record<ViewTheme, { top: string; bottom: string } | "token"> = {
    light: "token",
    dark: GREY_GRADIENT,
};

/** The CSS `background` for the stage element. */
export function stageBackgroundCss(theme: ViewTheme): string {
    const stops = STAGE_BACKGROUND[theme];
    return stops === "token" ? "hsl(var(--background))" : `linear-gradient(180deg, ${stops.top} 0%, ${stops.bottom} 100%)`;
}

/** Ground grid colours: 10 mm minor lines, 50 mm major lines. */
export const GRID_COLORS: Record<ViewTheme, { minor: string; major: string }> = {
    light: { minor: "#e3e5e9", major: "#c9cdd3" },
    dark: { minor: "#959aa3", major: "#a8adb5" },
};

/**
 * Paints a project cover's background onto a 2D canvas (the thumbnail render is transparent). Always the
 * same neutral grey, whatever the theme is when the cover is made: it is stored once per project and
 * shown on a dark hub and a light one, and the light stage colour (near white) would look blank there.
 */
export function paintThumbnailBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, GREY_GRADIENT.top);
    gradient.addColorStop(1, GREY_GRADIENT.bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
}
