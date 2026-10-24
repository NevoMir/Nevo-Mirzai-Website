// Leaning watchtower: a stone shaft that flares into a heavy timber belfry, the whole thing sheared sideways.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ leanDeg = 22, girth = 1.25 } = {}) {
    const stone = mat("#a89f8e", { rough: 0.95 });
    const shaft = new Part("Tower shaft", stone);
    // r(y) profile, bottom to top (closed on the axis automatically)
    shaft.lathe([[1.05, 0], [1.05, 0.3], [0.9, 0.6], [0.84, 0.75], [0.8, 1.2], [1.0, 8.6], [1.0, 8.75]], { radial: 36, crease: 35 });
    const corbels = new Part("Corbelled gallery", mat("#8f8677", { rough: 0.95 }));
    corbels.lathe([[1.0, 8.6], [1.2, 9.0], [1.7, 9.35], [2.2, 9.55], [2.25, 9.95], [1.95, 10.05]], { radial: 36, crease: 35 });
    const bands = new Part("Stone bands", mat("#c9c1b0", { rough: 0.9 }));
    for (const y of [2.2, 3.9, 5.6, 7.3]) bands.add(new THREE.TorusGeometry(0.8 + (y - 1.2) * 0.0270, 0.07, 6, 28), { at: [0, y, 0], rot: [90, 0, 0] });
    const belfry = new Part("Timber belfry", mat("#8a5a3a", { rough: 0.8 }));
    belfry.cyl(1.9, 1.9, 2.0, { at: [0, 11.05, 0], radial: 32 });
    belfry.cyl(2.05, 2.05, 0.18, { at: [0, 10.14, 0], radial: 32 });
    const openings = new Part("Belfry openings", mat("#1d1a18", { rough: 0.9 }));
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        openings.box(0.6, 1.05, 0.2, { at: [Math.cos(a) * 1.87, 11.0, Math.sin(a) * 1.87], rot: [0, (-a * 180) / Math.PI + 90, 0] });
    }
    const roof = new Part("Roof", mat("#b2432f", { rough: 0.7 }));
    roof.lathe([[2.6, 11.95], [2.35, 12.25], [1.8, 12.95], [1.15, 13.8], [0.55, 14.55], [0, 15.4]], { radial: 36, crease: 60 });
    const finial = new Part("Finial", mat("#d9b24a", { metal: 1, rough: 0.3 }));
    finial.sphere(0.16, { at: [0, 15.3, 0] });
    finial.cyl(0.0, 0.07, 0.7, { at: [0, 15.75, 0] });
    const door = new Part("Door", mat("#5b3a22", { rough: 0.7 }));
    door.rbox(0.8, 1.6, 0.3, 0.05, { at: [0, 1.0, 0.88] });
    const slits = new Part("Arrow slits", mat("#1d1a18", { rough: 0.9 }));
    for (const y of [3.0, 4.8, 6.6]) slits.box(0.22, 0.9, 0.3, { at: [0, y, 0.8 + (y - 1.2) * 0.0270 + 0.03] });
    const parts = [shaft, corbels, bands, belfry, openings, roof, finial, door, slits];
    const t = Math.tan((leanDeg * Math.PI) / 180);
    const shear = new THREE.Matrix4().makeShear(0, 0, t, 0, 0, 0); // x' = x + t * y
    const widen = new THREE.Matrix4().makeScale(girth, 1, girth);
    const m = shear.clone().multiply(widen);
    for (const p of parts) p.xform(m);
    return parts;
}
