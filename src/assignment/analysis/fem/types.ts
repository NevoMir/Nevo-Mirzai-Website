// Shared types of the FEM layer. SI units everywhere inside this folder: metres, newtons, pascals.
// Z is up (the same frame as src/assignment/analysis: cell (i, j, k), k = 0 on the ground).

export interface FrameProps {
    E: number; // Young's modulus [Pa]
    G: number; // shear modulus [Pa]
    A: number; // area [m^2]
    Iy: number; // second moment of area [m^4] (equal to Iz for a square)
    Iz: number;
    J: number; // St Venant torsion constant [m^4]
    /**
     * Shear correction factor (5/6 for a solid square). Used ONLY by solveFrameTs: when set, the beam is
     * Timoshenko (shear-deformable); when undefined it is Euler-Bernoulli exactly like Awatif's WASM solver.
     * Matters here because an element is one block long (L/h = 1): Euler-Bernoulli over-estimates its stiffness.
     */
    kappa?: number;
}

/** A 3D frame: 6 DOF per node, two-node Euler-Bernoulli beam elements (Awatif's formulation). */
export interface FrameModel {
    nodes: Float64Array; // 3 per node: x, y, z [m]
    elems: Uint32Array; // 2 per element: node indices
    /** Nodes that are fully fixed (all 6 DOF). */
    supportNodes: Int32Array;
    /** Nodal loads: loadNodes[i] gets loadVals[6i..6i+5] = Fx, Fy, Fz, Mx, My, Mz [N, N m]. */
    loadNodes: Int32Array;
    loadVals: Float64Array;
    props: FrameProps; // one section/material for every element
}

/**
 * What a solver returns. `forces` has the layout of Awatif's lSolve: 13 doubles per element,
 *   [elementIndex, N0, N1, Vy0, Vy1, Vz0, Vz1, Mx0, Mx1, My0, My1, Mz0, Mz1]
 * (suffix 0 = start node, 1 = end node of the element; local axes x along the member, y horizontal,
 *  z = x cross y; vertical members: x = +-Z, y = Y). N is POSITIVE IN COMPRESSION (measured:
 *  a hanging bar gives N < 0). Moments/shears have Awatif's "sagging negative" sign convention;
 *  for stress checks only their magnitudes matter.
 */
export interface FrameSolution {
    /** 3 translations per node [m] (dx, dy, dz). */
    displacements: Float64Array;
    forces: Float64Array;
}

export type FrameSolver = (model: FrameModel) => FrameSolution;

export class FemError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "FemError";
        this.status = status;
    }
}
