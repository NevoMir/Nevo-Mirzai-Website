// Stone arch footbridge: abutments, one segmental arch, parapets. Every block sits on an unbroken column or on the arch: passes.
import { Part, mat, THREE } from "../lib/kit.mjs";

const RISE = 3.0;
export function build({ span = 3.6 } = {}) {
    const L = 6.0; // half length
    const deckY = (x) => 4.0 + 0.9 * (1 - (x / L) * (x / L)); // humped deck: 4.0 at the ends, 4.9 at the crown
    const archY = (x) => RISE * Math.sqrt(Math.max(0, 1 - (x / span) * (x / span))); // half-ellipse opening
    const stone = new Part("Bridge body", mat("#a8a193", { rough: 0.95 }));
    const outline = new THREE.Shape();
    outline.moveTo(-L, 0);
    outline.lineTo(-span, 0);
    for (let i = 1; i < 40; i++) { const x = -span + (i / 40) * 2 * span; outline.lineTo(x, archY(x)); }
    outline.lineTo(span, 0);
    outline.lineTo(L, 0);
    for (let i = 0; i <= 28; i++) { const x = L - (i / 28) * 2 * L; outline.lineTo(x, deckY(x)); }
    outline.closePath();
    stone.extrude(outline, 2.8, { at: [0, 0, -1.4], crease: 25, curveSegments: 8 });

    // arch ring: lighter voussoir band around the opening, slightly proud of both faces
    const ring = new Part("Arch ring", mat("#c7bda4", { rough: 0.9 }));
    const rs = new THREE.Shape();
    const t = 0.4, rise = RISE;
    for (let i = 0; i <= 40; i++) { const a = Math.PI - (i / 40) * Math.PI; const x = Math.cos(a) * (span + t), y = Math.sin(a) * (rise + t); if (i === 0) rs.moveTo(x, 0); else rs.lineTo(x, y); }
    for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI; rs.lineTo(Math.cos(a) * span, Math.sin(a) * rise); }
    rs.closePath();
    ring.extrude(rs, 3.0, { at: [0, 0, -1.5], crease: 25, curveSegments: 8 });

    // deck and parapets follow the hump
    const deck = new Part("Cobbled deck", mat("#8a8479", { rough: 1 }));
    const ds = new THREE.Shape();
    ds.moveTo(-L, 3.9);
    for (let i = 0; i <= 28; i++) { const x = -L + (i / 28) * 2 * L; ds.lineTo(x, deckY(x) + 0.12); }
    ds.lineTo(L, 3.9); ds.closePath();
    deck.extrude(ds, 2.1, { at: [0, 0, -1.05], crease: 25, curveSegments: 4 });
    const parapet = new Part("Parapets", mat("#b7ae9b", { rough: 0.95 }));
    const ps = new THREE.Shape();
    ps.moveTo(-L - 0.15, deckY(-L) - 0.1);
    for (let i = 0; i <= 28; i++) { const x = -L - 0.15 + (i / 28) * (2 * L + 0.3); ps.lineTo(x, deckY(Math.max(-L, Math.min(L, x))) + 0.95); }
    for (let i = 28; i >= 0; i--) { const x = -L - 0.15 + (i / 28) * (2 * L + 0.3); ps.lineTo(x, deckY(Math.max(-L, Math.min(L, x))) - 0.1); }
    for (const z of [-1.2, 1.2]) parapet.extrude(ps, 0.4, { at: [0, 0, z - 0.2], crease: 25, curveSegments: 4 });
    const caps = new Part("Parapet coping", mat("#d1c9b5", { rough: 0.85 }));
    for (const z of [-1.2, 1.2]) for (let i = 0; i < 12; i++) { const x = -L + 0.5 + i * ((2 * L - 1) / 11); caps.rbox(0.9, 0.12, 0.52, 0.03, { at: [x, deckY(x) + 1.0, z] }); }
    return [stone, ring, deck, parapet, caps];
}
