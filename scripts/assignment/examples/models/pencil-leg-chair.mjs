// Mid-century dining chair on pencil-thin splayed legs: legs thinner than a block, so the seat floats.
import { Part, mat, THREE } from "../lib/kit.mjs";

export function build({ leg = 0.0125, splay = 0.05 } = {}) {
    const wood = mat("#7b4e2c", { rough: 0.55 });
    const legs = new Part("Legs", wood);
    const W = 0.46, D = 0.44, seatY = 0.45;
    // front legs: from under the seat corner, splaying outwards
    for (const sx of [-1, 1]) {
        legs.sweep([[sx * (W / 2 - 0.03), seatY - 0.02, D / 2 - 0.03], [sx * (W / 2 - 0.03 + splay * 0.5), seatY / 2, D / 2 - 0.03 + splay * 0.5], [sx * (W / 2 - 0.03 + splay), 0.0, D / 2 - 0.03 + splay]], [[0, leg * 1.25], [1, leg * 0.8]], { segments: 10, radial: 8, roundCaps: false });
    }
    // rear legs: swept back, continuing up as the back posts
    for (const sx of [-1, 1]) {
        legs.sweep([[sx * (W / 2 - 0.03 + splay), 0.0, -D / 2 - splay * 1.4], [sx * (W / 2 - 0.03 + splay * 0.4), seatY * 0.6, -D / 2 + 0.01], [sx * (W / 2 - 0.035), seatY, -D / 2 + 0.03], [sx * (W / 2 - 0.04), 0.7, -D / 2 - 0.035], [sx * (W / 2 - 0.05), 0.9, -D / 2 - 0.085]], [[0, leg * 0.85], [0.4, leg * 1.2], [1, leg * 1.35]], { segments: 40, radial: 8 });
    }
    const frame = new Part("Seat frame", wood);
    frame.rbox(W, 0.05, D, 0.012, { at: [0, seatY - 0.045, 0] });
    const seat = new Part("Seat cushion", mat("#c46a3a", { rough: 0.85 }));
    seat.rbox(W - 0.02, 0.07, D - 0.02, 0.03, { at: [0, seatY + 0.005, 0.0], segments: 2 });
    const back = new Part("Backrest", wood);
    // a curved panel: arc-shaped strip in plan, extruded up
    const shape = new THREE.Shape();
    const bw = W / 2 - 0.045;
    shape.moveTo(-bw, 0); shape.lineTo(bw, 0); shape.lineTo(bw, 0.03); shape.quadraticCurveTo(0, 0.07, -bw, 0.03); shape.closePath();
    // plan arc (x, z) extruded upward is awkward: build as a curved slab using a lathe-less approach: stack of thin boxes
    for (let i = 0; i < 9; i++) {
        const u = i / 8, x = (u - 0.5) * 2 * bw;
        const z = -D / 2 - 0.075 + 0.03 * (x * x) / (bw * bw);
        back.box(2 * bw / 8 + 0.004, 0.2, 0.022, { at: [x, 0.76, z], rot: [-8, -x * 60, 0] });
    }
    const feet = new Part("Brass feet", mat("#c9a24a", { metal: 1, rough: 0.3 }));
    for (const sx of [-1, 1]) {
        feet.cyl(leg * 0.9, leg * 0.9, 0.012, { at: [sx * (W / 2 - 0.03 + splay), 0.006, D / 2 - 0.03 + splay], radial: 8 });
        feet.cyl(leg * 0.9, leg * 0.9, 0.012, { at: [sx * (W / 2 - 0.03 + splay), 0.006, -D / 2 - splay * 1.4], radial: 8 });
    }
    return [legs, frame, seat, back, feet];
}
