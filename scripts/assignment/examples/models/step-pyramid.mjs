// Stepped pyramid with a hilltop temple: broad base, every tier fully on the one below. Passes everything.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ tiers = 5 } = {}) {
    const lime = mat("#cbbd99", { rough: 0.95 });
    const body = new Part("Pyramid tiers", lime);
    const band = new Part("Tier trim", mat("#aa9a73", { rough: 0.95 }));
    const H = 1.2;
    let top = 0;
    for (let i = 0; i < tiers; i++) {
        const w = 9.0 - i * 1.55;
        body.rbox(w, H, w, 0.06, { at: [0, i * H + H / 2, 0] });
        band.rbox(w + 0.12, 0.16, w + 0.12, 0.03, { at: [0, i * H + 0.08, 0] });
        top = (i + 1) * H;
    }
    // central staircase on +Z: one slanted slab plus the side walls
    const stairs = new Part("Staircase", mat("#ddd0ac", { rough: 0.9 }));
    const run = (9.0 - 1.55 * (tiers - 1)) / 2;
    const frontBottom = 9.0 / 2, frontTop = run;
    const dz = frontBottom - frontTop, dy = top;
    const len = Math.hypot(dz, dy);
    const ang = (Math.atan2(dy, -dz) * 180) / Math.PI;
    for (let s = 0; s < 36; s++) {
        const u = (s + 0.5) / 36;
        const z = frontBottom - u * dz + 0.08, y = u * dy;
        stairs.box(1.7, dy / 36 + 0.02, dz / 36 + 0.12, { at: [0, y + 0.02, z] });
    }
    const rails = new Part("Stair balustrades", mat("#b6a77f", { rough: 0.9 }));
    for (const x of [-1.0, 1.0]) rails.beam([x, 0.1, frontBottom + 0.25], [x, top + 0.55, frontTop - 0.1], 0.34, 0.34, { radius: 0.05 });
    // temple
    const temple = new Part("Temple", mat("#d9ccaa", { rough: 0.9 }));
    const tw = 2.6;
    temple.rbox(tw, 1.7, tw, 0.05, { at: [0, top + 0.85, 0] });
    const door = new Part("Temple door", mat("#2a2420", { rough: 0.9 }));
    door.box(0.9, 1.2, 0.2, { at: [0, top + 0.65, tw / 2 + 0.01] });
    const roof = new Part("Temple roof", mat("#9b4a30", { rough: 0.8 }));
    roof.add(new THREE.ConeGeometry(2.2, 1.3, 4, 1, false), { at: [0, top + 1.7 + 0.65, 0], rot: [0, 45, 0] });
    roof.rbox(tw + 0.3, 0.16, tw + 0.3, 0.03, { at: [0, top + 1.78, 0] });
    const bowls = new Part("Torch bowls", mat("#4b4540", { metal: 0.6, rough: 0.5 }));
    const flames = new Part("Flames", mat("#ff9a1e", { rough: 0.4, emissive: "#ff6a00" }));
    const w4 = 9.0 - 3 * 1.55; // 4th tier top (so bowls sit on a ledge)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const px = sx * (w4 / 2 - 0.35), pz = sz * (w4 / 2 - 0.35), py = 4 * H;
        bowls.lathe([[0.14, 0], [0.14, 0.35], [0.3, 0.55], [0.34, 0.62], [0.26, 0.6], [0.0, 0.5]], { at: [px, py, pz], radial: 14 });
        flames.add(new THREE.ConeGeometry(0.18, 0.5, 8), { at: [px, py + 0.85, pz] });
    }
    return [body, band, stairs, rails, temple, door, roof, bowls, flames];
}
