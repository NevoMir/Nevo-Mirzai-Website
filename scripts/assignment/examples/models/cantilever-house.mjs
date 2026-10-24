// Cantilever house: a 12 m long modern house whose charcoal upper floor overhangs a much shorter white ground floor.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build() {
    // Axes: X is the long axis (-6 .. +6 m), Z depth (-2.6 .. +2.6), Y up.
    const GF = { x0: -6.0, x1: -2.4, h: 2.8 }; // ground floor spans 3.6 m of the 12 m
    const UF = { x0: -6.0, x1: 6.0, y0: 2.8, y1: 5.5 };
    const D = 5.2;

    const plinth = new Part("Plinth", mat("#8d8f91", { rough: 0.9 }));
    plinth.rbox(GF.x1 - GF.x0 + 0.5, 0.3, D + 0.5, 0.04, { at: [(GF.x0 + GF.x1) / 2, 0.15, 0] });
    // entrance steps
    plinth.rbox(1.6, 0.18, 0.7, 0.03, { at: [-4.2, 0.09, D / 2 + 0.55] });
    plinth.rbox(1.6, 0.34, 0.45, 0.03, { at: [-4.2, 0.17, D / 2 + 0.35] });

    const ground = new Part("Ground floor", mat("#ece8e1", { rough: 0.85 }));
    ground.rbox(GF.x1 - GF.x0, GF.h - 0.3, D, 0.05, { at: [(GF.x0 + GF.x1) / 2, 0.3 + (GF.h - 0.3) / 2, 0] });

    const upper = new Part("Upper floor", mat("#2e3033", { rough: 0.7 }));
    upper.rbox(UF.x1 - UF.x0, UF.y1 - UF.y0, D, 0.06, { at: [(UF.x0 + UF.x1) / 2, (UF.y0 + UF.y1) / 2, 0] });

    // vertical timber battens on the long faces of the upper floor
    const battens = new Part("Timber battens", mat("#7a5233", { rough: 0.75 }));
    for (let x = UF.x0 + 0.5; x < UF.x1 - 0.4; x += 0.42) {
        for (const z of [D / 2 + 0.03, -D / 2 - 0.03]) battens.box(0.12, UF.y1 - UF.y0 - 0.5, 0.07, { at: [x, (UF.y0 + UF.y1) / 2 - 0.05, z] });
    }

    // roof: thin mono-pitch slab with overhang, parapet-like fascia
    const roof = new Part("Roof", mat("#6f7479", { metal: 0.6, rough: 0.45 }));
    roof.rbox(UF.x1 - UF.x0 + 0.9, 0.22, D + 0.9, 0.05, { at: [0, UF.y1 + 0.2, 0], rot: [0, 0, -1.2] });

    // glazing: ground floor ribbon + big glazed east gable of the upper floor
    const glass = new Part("Glazing", mat("#7fb6d6", { rough: 0.05, metal: 0.1, alpha: 0.45 }));
    glass.box(2.8, 1.5, 0.05, { at: [-3.6, 1.55, D / 2 + 0.01] });
    glass.box(1.2, 1.2, 0.05, { at: [-5.2, 1.5, -D / 2 - 0.01] });
    glass.box(0.05, 1.7, 3.8, { at: [UF.x1 + 0.01, 3.95, 0] });
    for (const x of [-3.6, 0, 3.0]) glass.box(2.6, 1.4, 0.05, { at: [x + 0.4, 4.0, D / 2 + 0.02] });
    const frames = new Part("Window frames", mat("#1b1c1e", { metal: 0.7, rough: 0.35 }));
    const frame = (cx, cy, cz, w, h, t, axis) => {
        const bar = (dx, dy, w2, h2) => (axis === "z" ? frames.box(w2, h2, 0.09, { at: [cx + dx, cy + dy, cz] }) : frames.box(0.09, h2, w2, { at: [cx, cy + dy, cz + dx] }));
        bar(0, h / 2, w + t, t); bar(0, -h / 2, w + t, t); bar(-w / 2, 0, t, h); bar(w / 2, 0, t, h); bar(0, 0, t * 0.6, h);
    };
    frame(-3.6, 1.55, D / 2 + 0.02, 2.8, 1.5, 0.08, "z");
    for (const x of [-3.6, 0, 3.0]) frame(x + 0.4, 4.0, D / 2 + 0.03, 2.6, 1.4, 0.08, "z");
    frame(UF.x1 + 0.02, 3.95, 0, 3.8, 1.7, 0.08, "x");

    const door = new Part("Front door", mat("#a8672f", { rough: 0.55 }));
    door.rbox(1.0, 2.1, 0.08, 0.02, { at: [-4.7, 1.35, D / 2 + 0.03] });
    const handle = new Part("Door handle", mat("#d8d8d8", { metal: 1, rough: 0.25 }));
    handle.cyl(0.02, 0.02, 0.35, { at: [-4.35, 1.3, D / 2 + 0.12] });

    // brick chimney
    const chimney = new Part("Chimney", mat("#9a4a36", { rough: 0.95 }));
    chimney.rbox(0.8, 1.6, 0.8, 0.03, { at: [-4.6, UF.y1 + 0.8, -1.3] });
    chimney.rbox(1.0, 0.12, 1.0, 0.02, { at: [-4.6, UF.y1 + 1.64, -1.3] });

    // terrace glass balustrade on the cantilever tip (the upper floor extends 0.9 m as an open deck)
    const deck = new Part("Terrace deck", mat("#b58b5e", { rough: 0.8 }));
    deck.rbox(1.6, 0.14, D + 0.2, 0.02, { at: [UF.x1 + 0.8, UF.y0 + 0.08, 0] });
    const rail = new Part("Glass balustrade", mat("#a9d4e6", { rough: 0.05, alpha: 0.4 }));
    rail.box(0.04, 1.0, D + 0.2, { at: [UF.x1 + 1.58, UF.y0 + 0.65, 0] });
    rail.box(1.6, 1.0, 0.04, { at: [UF.x1 + 0.8, UF.y0 + 0.65, D / 2 + 0.08] });
    rail.box(1.6, 1.0, 0.04, { at: [UF.x1 + 0.8, UF.y0 + 0.65, -D / 2 - 0.08] });
    const handrail = new Part("Handrail", mat("#202224", { metal: 0.9, rough: 0.3 }));
    handrail.box(0.06, 0.05, D + 0.2, { at: [UF.x1 + 1.58, UF.y0 + 1.17, 0] });
    handrail.box(1.6, 0.05, 0.06, { at: [UF.x1 + 0.8, UF.y0 + 1.17, D / 2 + 0.08] });
    handrail.box(1.6, 0.05, 0.06, { at: [UF.x1 + 0.8, UF.y0 + 1.17, -D / 2 - 0.08] });

    return [plinth, ground, upper, battens, roof, glass, frames, door, handle, chimney, deck, rail, handrail];
}
