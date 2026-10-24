// Harbour jib crane on a slender pedestal: long solid jib, small counterweight, a container hanging from thin cables.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ jib = 11.5, counter = 1.0, container = true } = {}) {
    const yellow = mat("#f1b21c", { rough: 0.5, metal: 0.15 });
    const concrete = mat("#a3a29d", { rough: 0.95 });
    const ped = new Part("Pedestal", concrete);
    ped.cyl(1.25, 1.45, 0.9, { at: [0, 0.45, 0], radial: 28 });
    ped.cyl(1.0, 1.0, 0.7, { at: [0, 1.25, 0], radial: 28 });

    const slew = new Part("Slewing ring", mat("#2c2e31", { metal: 0.8, rough: 0.4 }));
    slew.cyl(1.05, 1.05, 0.28, { at: [0, 1.74, 0], radial: 28 });

    const mast = new Part("Mast", yellow);
    mast.rbox(1.35, 6.2, 1.35, 0.1, { at: [0, 5.0, 0] });
    const bands = new Part("Hazard bands", mat("#1d1d1d", { rough: 0.6 }));
    for (const y of [2.6, 3.0, 3.4]) bands.rbox(1.4, 0.12, 1.4, 0.02, { at: [0, y, 0] });
    for (const y of [6.4, 6.8]) bands.rbox(1.4, 0.12, 1.4, 0.02, { at: [0, y, 0] });

    const cab = new Part("Operator cab", mat("#e9e4d2", { rough: 0.5 }));
    cab.rbox(1.5, 1.5, 1.5, 0.12, { at: [0.2, 7.6, 1.45] });
    const cabGlass = new Part("Cab glass", mat("#6fa6c8", { rough: 0.05, alpha: 0.55 }));
    cabGlass.box(1.1, 0.9, 0.06, { at: [0.2, 7.75, 2.22] });
    cabGlass.box(0.06, 0.9, 1.0, { at: [0.98, 7.75, 1.5] });

    // jib: tapered solid box beam seen from the side, from the counter-jib tail to the tip
    const jibPart = new Part("Jib", yellow);
    const tail = -2.4 * counter;
    const shape = new THREE.Shape();
    shape.moveTo(tail, 8.15); shape.lineTo(-0.9, 8.15); shape.lineTo(jib, 8.45); shape.lineTo(jib, 8.95); shape.lineTo(-0.9, 9.55); shape.lineTo(tail, 9.55); shape.closePath();
    jibPart.extrude(shape, 1.1, { at: [0, 0, -0.55], bevel: 0.05, crease: 30 });
    const machinery = new Part("Machinery house", mat("#d5d1c2", { rough: 0.6 }));
    machinery.rbox(2.2, 1.5, 1.5, 0.12, { at: [-0.1, 10.1, 0] });
    const cw = new Part("Counterweight", mat("#8c8b86", { rough: 0.95 }));
    cw.rbox(1.0 * counter + 0.5, 1.2, 1.3, 0.05, { at: [tail + 0.5 * counter + 0.25, 8.85, 0] });
    const rail = new Part("Jib rail", mat("#222426", { metal: 0.8, rough: 0.4 }));
    rail.box(jib + 0.9, 0.08, 0.08, { at: [(jib - 0.9) / 2, 9.35 + 0.38, 0.5] });
    rail.box(jib + 0.9, 0.08, 0.08, { at: [(jib - 0.9) / 2, 9.35 + 0.38, -0.5] });

    const pendant = new Part("Pendant ties", mat("#4a4c50", { metal: 0.9, rough: 0.35 }));
    pendant.beam([0, 10.9, 0], [jib - 0.4, 9.2, 0], 0.07, 0.07, { round: true, radial: 6 });
    pendant.beam([0, 10.9, 0], [tail + 0.3, 9.55, 0], 0.07, 0.07, { round: true, radial: 6 });
    pendant.box(0.3, 0.7, 0.3, { at: [0, 10.9, 0] });

    // hook, cable and load
    const hx = jib - 1.0;
    const cable = new Part("Hoist cable", mat("#2b2b2b", { rough: 0.6 }));
    cable.cyl(0.04, 0.04, 4.1, { at: [hx, 6.9, 0], radial: 6 });
    const hook = new Part("Hook block", mat("#1f2023", { metal: 0.7, rough: 0.4 }));
    hook.rbox(0.7, 0.9, 0.55, 0.06, { at: [hx, 4.6, 0] });
    hook.add(new THREE.TorusGeometry(0.2, 0.06, 8, 16), { at: [hx, 3.85, 0] });
    const parts = [ped, slew, mast, bands, cab, cabGlass, jibPart, machinery, cw, rail, pendant, cable, hook];
    if (container) {
        const box = new Part("Container", mat("#c4492a", { rough: 0.55, metal: 0.2 }));
        box.rbox(2.6, 1.9, 1.5, 0.05, { at: [hx, 2.55, 0] });
        const ribs = new Part("Container ribs", mat("#a63a20", { rough: 0.6 }));
        for (let i = -5; i <= 5; i++) { ribs.box(0.06, 1.7, 1.56, { at: [hx + i * 0.23, 2.55, 0] }); }
        const sling = new Part("Slings", mat("#2b2b2b", { rough: 0.6 }));
        for (const dx of [-1.2, 1.2]) for (const dz of [-0.6, 0.6]) sling.beam([hx, 3.95, 0], [hx + dx, 3.55, dz], 0.04, 0.04, { round: true, radial: 5 });
        parts.push(box, ribs, sling);
    }
    return parts;
}
