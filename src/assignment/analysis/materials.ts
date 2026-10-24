// What the blocks are made of, for the stress estimate. One preset is picked in the analysis settings.
//
// The numbers are textbook values for a bonded assembly (the blocks are glued or mortared to each other and to the
// ground), in SI. They decide how much stress a joint can take, which is the weak link of a block structure:
//   jointTension  tension across a joint (mortar or glue line, or timber across the grain). Governs almost always.
//   compression   crushing of a block.
//   shear         sliding / torsion of a joint.
// Concrete is the default because its joints are the weakest relative to its weight: a 7-block arm of mortared
// concrete blocks reaches about 200 % of the allowable (it fails), while the same arm in glued timber reaches 21 %.

import type { MaterialId } from "../shared/contract.ts";
// From voxelFrame.ts, not the fem barrel: this module is imported by report.ts and the UI, which must not pull the WASM loader in.
import { MATERIALS as FEM_MATERIALS, type Material } from "./fem/voxelFrame.ts";

export const DEFAULT_MATERIAL: MaterialId = "concrete";

/** 0.734 -> "73%". Here (not in stress.ts) so the UI can format a utilisation without loading the solver. */
export const pct = (u: number): string => `${Math.round(u * 100)}%`;

/**
 * Above this share of the allowable a joint is "highly stressed" (a warning); the stabilizer aims below it.
 * 75 % sits just above a concrete arm of the allowed 4 blocks (~71 %), so the stress check agrees with the
 * cantilever rule: a 4-block arm passes, a 5-block arm (~106 %) fails.
 */
export const STRESS_WARN = 0.75;
/** Above this share the joint opens or crushes (an error). */
export const STRESS_FAIL = 1;

export interface StressMaterial {
    id: MaterialId;
    label: string; // the segmented control
    detail: string; // one line under it
    fem: Material;
}

export const STRESS_MATERIALS: Record<MaterialId, StressMaterial> = {
    concrete: {
        id: "concrete",
        label: "Concrete",
        detail: "Concrete blocks, mortar joints · 2400 kg/m³ · joints take 0.2 MPa tension",
        fem: FEM_MATERIALS.concrete,
    },
    timber: {
        id: "timber",
        label: "Timber",
        detail: "Softwood blocks, glued · 500 kg/m³ · joints take 0.4 MPa tension",
        fem: FEM_MATERIALS.timber,
    },
};

export const materialOf = (id: MaterialId): StressMaterial => STRESS_MATERIALS[id] ?? STRESS_MATERIALS[DEFAULT_MATERIAL];
