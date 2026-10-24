// Mushroom pavilion / side table: a slim flared stem under a broad domed cap (reach = 4 blocks all round: passes, just).
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ capR = 2.5, stemR = 0.36, thick = 1.5, drop = 0 } = {}) {
    const stem = new Part("Stem", mat("#efe3c8", { rough: 0.8 }));
    const s = stemR / 0.36;
    stem.lathe([[0.7 * s, 0], [0.7 * s, 0.06], [0.52 * s, 0.28], [0.38 * s, 0.75], [0.33 * s, 1.35], [0.34 * s, 1.95], [0.4 * s, 2.45]], { radial: 36 });
    const k = capR / 2.5;
    // dome (outer) from the crown down to the rim, then the underside back towards the stem
    // `thick` stretches the dome upwards from its rim, `drop` lets the whole cap hang lower over a shorter stem
    const up = (y) => 2.3 + (y - 2.3) * thick - drop;
    const outer = [[0, 3.95], [0.45 * k, 3.9], [1.1 * k, 3.72], [1.75 * k, 3.38], [2.25 * k, 2.92], [2.46 * k, 2.55], [2.5 * k, 2.38]].map(([r, y]) => [r, up(y)]);
    const under = [[2.42 * k, 2.26], [1.8 * k, 2.3], [1.0 * k, 2.4], [0.5 * k, 2.5], [0, 2.5]].map(([r, y]) => [r, y - drop]);
    const cap = new Part("Cap", mat("#c8322a", { rough: 0.42 }));
    cap.lathe([...outer, ...under], { radial: 56, crease: 70 });
    const gills = new Part("Gills", mat("#e8d9b5", { rough: 0.9 }));
    gills.lathe([[2.4 * k, 2.3], [1.8 * k, 2.34], [1.0 * k, 2.44], [0.45 * k, 2.54], [0.45 * k, 2.44], [1.0 * k, 2.34], [1.8 * k, 2.24], [2.4 * k, 2.2]], { radial: 56, crease: 70 });
    const spots = new Part("Cap spots", mat("#f6efdc", { rough: 0.6 }));
    const yAt = (r) => {
        for (let i = 1; i < outer.length; i++) if (r >= outer[outer.length - i - 1][0]) { const a = outer[outer.length - i - 1], b = outer[outer.length - i]; const u = (r - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, (b[1] - a[1]) / (b[0] - a[0])]; }
        return [outer[0][1], 0];
    };
    const rings = [[0.0, 1, 0.5], [0.95, 5, 0.34], [1.65, 7, 0.38], [2.2, 9, 0.3]];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [r, n, size] of rings) {
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + r * 1.3;
            const rr = r * k;
            const [y, slope] = yAt(rr);
            // slope of the profile (dy/dr), points inwards-up: outward normal = (-slope, 1) normalised in the (r, y) plane
            const nlen = Math.hypot(slope, 1);
            const nr = -slope / nlen, ny = 1 / nlen;
            const up = [Math.cos(a) * nr, ny, Math.sin(a) * nr];
            const sz = size * k * (0.8 + rnd() * 0.5);
            spots.sphere(1, { at: [Math.cos(a) * rr, y - 0.02, Math.sin(a) * rr], up, scale: [sz, sz * 0.32, sz], w: 10, h: 6 });
        }
    }
    return [stem, cap, gills, spots];
}
