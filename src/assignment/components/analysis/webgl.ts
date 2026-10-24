// Is WebGL missing? The viewer reads the model's triangles from its 3D scene, so when it cannot draw (its card says
// "3D needs WebGL") there is nothing to analyse, and the report must say so instead of loading for ever. The
// viewer draws with WebGL 2; this asks for the same, once, and gives the context back.

let missing: boolean | null = null;

export function webglMissing(): boolean {
    if (missing !== null) return missing;
    if (typeof document === "undefined") return (missing = false);
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        if (!gl) return (missing = true);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return (missing = false);
    } catch {
        // A probe that throws says nothing about the viewer: let the viewer speak for itself.
        return (missing = false);
    }
}

export const WEBGL_MESSAGE = "3D needs WebGL, which this browser has turned off.";
