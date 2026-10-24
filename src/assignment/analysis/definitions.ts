// The rules behind the numbers, in plain words. Shown in the app ("How is this computed?") and copied into the
// exported report so a reader can follow the analysis without reading the code.

export interface Definition {
    key: string;
    title: string;
    text: string;
}

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
];
