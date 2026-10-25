// The rules behind the numbers. DEFINITIONS are the technical statement of each rule: shown in the app ("How is this computed?",
// under "The rules in detail") and copied into the exported report, so a reader can follow the analysis without reading the code.
// They keep the technical terms (cantilever, centre of gravity, utilisation) on purpose. HOW_IT_WORKS and SCREEN_DEFINITIONS are
// the plain-language parts of the info page and are not part of the report.

import { STRESS_FAIL, STRESS_MATERIALS, STRESS_WARN, pct as pc } from "./materials.ts";

const mpa = (pa: number): string => `${Math.round(pa / 1e5) / 10}`;
const strengths = (id: "concrete" | "timber"): string => {
    const m = STRESS_MATERIALS[id].fem;
    return `${mpa(m.jointTension)} / ${mpa(m.compression)} / ${mpa(m.shear)} MPa`;
};

export interface Definition {
    key: string;
    title: string;
    text: string;
}

/** The short story of the analysis in four steps, for the top of the "How is this computed?" page. Plain words, no jargon. */
export const HOW_IT_WORKS: ReadonlyArray<{ title: string; text: string }> = [
    {
        title: "Scale it",
        text: "The model is scaled so its longest side is 1 m, and set on the ground. Its shape does not change.",
    },
    {
        title: "Build it from blocks",
        text: "It is rebuilt from 100 mm blocks. A block is used where the model fills enough of it (the fill threshold in Settings).",
    },
    {
        title: "Check the rules",
        text: "Balance (does the weight sit over the base, or does it tip?), overhangs (does any arm stick out further than the limit?), floating parts, and the block budget if you set one.",
    },
    {
        title: "Estimate the strength",
        text: "The model's own weight is applied to a simple beam model of the blocks. For every joint it works out how much of its strength is used: 100% is where it would open or crush.",
    },
];

/** What only the screen needs (the report does not list these): how to read directions and "how far an overhang reaches". */
export const SCREEN_DEFINITIONS: Definition[] = [
    {
        key: "directions",
        title: "Directions",
        text: "Right, left, front and back are as the Front view shows them: the front is the side that faces you. The Front, Right and Top buttons in the 3D view show each side. (In the exported report these are +X for right, -X for left, -Y for front, +Y for back, and +Z is up.)",
    },
    {
        key: "reach-unit",
        title: "How far an overhang reaches",
        text: "Counted in block steps along the structure from the nearest support, not in a straight line. A step to a neighbouring block, sideways or across a corner, counts as one; going up or down is free. A straight arm or a plate therefore never reaches further than the model is wide, but a winding arm can. (Technical term: reach of a cantilever.)",
    },
];

export const DEFINITIONS: Definition[] = [
    {
        key: "scale",
        title: "Scaling",
        text: "The model is scaled uniformly so that its longest side is 1000 mm, centred in X and Y inside a 1000 x 1000 mm footprint, with its lowest point on the ground (z = 0). The aspect ratio never changes.",
    },
    {
        key: "voxelization",
        title: "Blocks",
        text: "Space is divided into a 10 x 10 x 10 grid of 100 mm blocks, addressed by (i, j, k) counted from 0; layer 1 is the one on the ground (k = 0). Each block is split into 12 x 12 x 12 small cells (8.3 mm). A small cell is solid when the model's surface touches it or when it is enclosed by the surface. A block's fill is the share of its small cells that are solid; the block is used when its fill reaches the fill threshold (10% by default). Surface cells are counted generously, so thin parts are slightly fattened rather than lost, and a block's fill is an estimate of its volume share that errs high by up to 8 points per exposed face, not a measurement. One layer of small cells is 8.3% of a block, below the lowest threshold, so a face that only grazes a neighbouring block never makes it a component.",
    },
    {
        key: "supported",
        title: "Supported block",
        text: "A block on the ground (layer 1), or a block whose block directly below is supported. In other words: an unbroken column of blocks that reaches the ground.",
    },
    {
        key: "body",
        title: "Connected structure",
        text: "Blocks are connected when they share a face (touching only along an edge or a corner does not hold anything). A structure that contains a block on the ground is grounded; any other structure is floating and would fall.",
    },
    {
        key: "cantilever",
        title: "Cantilevered block",
        text: "A block of a grounded structure that is not supported, i.e. it has no unbroken column under it and hangs on the rest of the structure sideways. Its reach is the smallest number of horizontal block steps to a supported block. A step goes to a block that shares a face, or diagonally across a corner (still one step) when at least one of the two blocks beside that corner exists, so a plate or a table top is measured by how far it overhangs its support, not by a staircase to its corner. Moving up or down is free, so a block hanging under or standing on an overhang has the same reach as the overhang. Reach 1 to the limit is a cantilever, more than the limit is an overreach. A cantilever run is a group of connected cantilevered blocks (one arm, bridge, cap or hanging part); its length is the largest reach in it.",
    },
    {
        key: "cog",
        title: "Centre of gravity",
        text: "Each connected structure that touches the ground is judged on its own, because structures that share no face do not hold each other up. Its centre of gravity is the average position of its blocks, every block weighing the same (uniform density); floating blocks are left out. Its support base is the convex hull (the outline of a rubber band) of its own blocks on the ground. If the centre of gravity, projected straight down, lies outside the base the structure tips over, about the nearest point of the base; the margin is the distance to the nearest edge of the base. The weakest structure (smallest margin) is the one reported, and a margin under 1 mm counts as balanced on the edge, which is flagged as a warning.",
    },
    {
        key: "components",
        title: "Components",
        text: "The number of blocks used. If a budget is set, using more blocks than the budget is a violation.",
    },
    {
        key: "stress",
        title: "Joint stress",
        text: `The structure's own weight (no wind, no people) is applied to a 3D beam model of it: every block is a node at its centre, every two blocks that share a face are joined by a 100 mm square beam, and the blocks on the ground are held fixed. Awatif FEM, an open-source (MIT) solver built on the Eigen library (MPL-2.0), solves it in your browser. At each joint its forces give the tension across the joint (the pull of the normal force plus the bending), the crushing of the block and the shear, and the joint's utilisation is the largest of these as a share of what the material allows. Only blocks connected to the ground carry load: a floating part has no load path and is left out. This is a linear elastic estimate for perfectly bonded blocks on an infinitely stiff ground, not a certificate: no buckling, no sliding of loose blocks, no wind. It ranks where the structure is most stressed and how much a change helps. Tipping is judged by the centre-of-gravity check.`,
    },
    {
        key: "utilisation",
        title: "Utilisation",
        text: `A joint's stress as a share of what the material allows: 0% is unloaded, 100% is where the joint opens or crushes. A block takes the worst utilisation of its joints. Above ${pc(STRESS_WARN)} a joint is highly stressed (a warning), above ${pc(STRESS_FAIL)} it is overstressed (an error); ${pc(STRESS_WARN)} is just above a cantilever of the allowed 4 concrete blocks, so the stress check agrees with the cantilever rule. Allowed joint tension / compression / shear: concrete blocks with mortar joints ${strengths("concrete")}, timber blocks glued ${strengths("timber")} (the weak values across the grain govern a joint).`,
    },
    {
        key: "stabilizer",
        title: "Stabilizer",
        text: `Adds blocks to a model until its checks pass and no joint is above ${pc(STRESS_WARN)} of the allowable stress. It never removes or moves a block of the original, which is kept as it is. Each step adds one kind of support: a column (a vertical run under a block down to the first supported block or the ground), a footing (ground blocks beside the base), a bracket (a one or two block knee under an arm, next to its support), a bridge (the shortest run of blocks that joins a floating part to the structure) or reinforcement (blocks beside a highly stressed joint to thicken it). It tries many candidates and keeps the one that lowers a cost made of the problems left, the stress and the blocks added; the same input always gives the same result. The new blocks sit on the same 100 mm lattice, and the stabilized model is saved next to the original.`,
    },
];

/** What the stress estimate does not do, one line each: the report lists them and the stress section's disclosure can too. */
export const STRESS_ASSUMPTIONS: readonly string[] = [
    "Load case: the blocks' own weight only (no wind, no people).",
    "Blocks are bonded to each other and to the ground; the ground is infinitely stiff.",
    "Linear elastic beams, one per shared face: no buckling, no sliding of loose blocks, no cracking.",
    "Floating parts have no load path and are not analysed.",
    "An estimate for ranking and comparing designs, not a structural certificate. Tipping is judged by the centre-of-gravity check.",
];
