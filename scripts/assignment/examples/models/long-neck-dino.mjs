// Long-necked sauropod: pillar legs under a barrel body, a very long neck reaching far past the front legs.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ neck = 1.2, legX = -0.8, tail = 0.5, fat = 1.35, legR = 0.8 } = {}) {
    const skin = mat("#6f8f4e", { rough: 0.85 });
    const dark = mat("#566e3c", { rough: 0.9 });
    const bodyY = 4.3;
    // One continuous spine: tail tip -> hips -> chest -> neck -> head, radius and width vary along it.
    const spine = [
        [-7.6 * tail, 2.2, 0.3], [-5.8 * tail, 3.2, 0.7], [-4.6 * tail, 3.9, 0.2], [-3.4, bodyY, 0], [-1.6, bodyY + 0.12, 0], [0.4, bodyY + 0.15, 0], [1.9, bodyY + 0.45, 0],
        [3.2 * neck + 0.5, 6.0, 0], [4.7 * neck + 0.5, 7.3, 0], [6.1 * neck + 0.5, 8.3, 0], [7.4 * neck + 0.6, 8.95, 0],
    ];
    const prof = [[0, 0.16], [0.14, 0.55], [0.26, 1.15], [0.34, 1.75], [0.5, 1.85], [0.58, 1.55], [0.64, 1.0], [0.8, 0.74], [1, 0.52]];
    const body = new Part("Body", skin);
    body.sweep(spine, prof, { segments: 60, radial: 16, ovalY: (t) => (t < 0.62 ? fat : fat * 0.7 + 0.3 * (1 - (t - 0.62) / 0.38)) });
    const belly = new Part("Belly", mat("#c9c08e", { rough: 0.9 }));
    belly.ellipsoid(2.7, 0.9, 1.0 * fat * 1.45, { at: [-0.7, bodyY - 1.1, 0], w: 32, h: 16 });
    const hx = spine[spine.length - 1][0] + 0.2;
    const hy = spine[spine.length - 1][1];
    const head = new Part("Head", mat("#7a9a55", { rough: 0.8 }));
    head.ellipsoid(0.78, 0.55, 0.52, { at: [hx + 0.2, hy + 0.1, 0] });
    head.ellipsoid(0.62, 0.38, 0.42, { at: [hx + 0.95, hy - 0.08, 0] });
    const eyes = new Part("Eyes", mat("#16140f", { rough: 0.2, metal: 0.1 }));
    for (const z of [-0.42, 0.42]) eyes.sphere(0.11, { at: [hx + 0.4, hy + 0.35, z] });
    const nostrils = new Part("Nostrils", mat("#3d4a2a", { rough: 0.9 }));
    for (const z of [-0.14, 0.14]) nostrils.sphere(0.07, { at: [hx + 1.5, hy + 0.1, z], scale: [1, 0.6, 1] });

    const legs = [];
    const lz = 0.98 * fat;
    const specs = [["Front left leg", legX + 1.5, lz], ["Front right leg", legX + 1.5, -lz], ["Rear left leg", legX - 2.2, lz], ["Rear right leg", legX - 2.2, -lz]];
    for (const [name, x, z] of specs) {
        const leg = new Part(name, dark);
        leg.sweep([[x, 4.2, z * 0.85], [x + 0.05, 2.3, z], [x + 0.1, 0.35, z * 1.02]], [[0, legR * 1.25], [0.5, legR * 0.95], [1, legR * 0.8]], { segments: 8, radial: 12, roundCaps: false });
        leg.ellipsoid(legR * 1.35, 0.3, legR * 1.05, { at: [x + 0.28, 0.28, z] });
        const toes = new Part(`${name} toes`, mat("#d8cfae", { rough: 0.6 }));
        for (const dz of [-0.45, 0, 0.45]) toes.ellipsoid(0.22, 0.16, 0.16, { at: [x + legR * 1.5 + 0.2, 0.2, z + dz], w: 8, h: 6 });
        leg.list.push(...toes.list);
        legs.push(leg);
    }
    const ridge = new Part("Back ridge", mat("#4d6535", { rough: 0.9 }));
    for (let i = 0; i < 9; i++) { const x = -3.4 + i * 0.7; ridge.ellipsoid(0.24, 0.34, 0.12, { at: [x, bodyY + 1.78 - Math.abs(x + 0.4) * 0.04, 0], w: 8, h: 6 }); }
    return [body, belly, head, eyes, nostrils, ...legs, ridge];
}
