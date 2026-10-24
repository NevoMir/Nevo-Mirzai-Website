// The words of the stress estimate that the screen needs: what the materials are, what the estimate assumes. Kept apart
// from analysis/materials.ts on purpose: that module pulls the FEM solver into whatever imports it, and the report
// panel is part of the page. scripts/assignment/test-store.mjs pins these numbers equal to the ones the solver uses.

import type { StressPoint } from "@/assignment/analysis/types";
import type { MaterialId } from "@/assignment/shared/contract";

export interface MaterialFacts {
    label: string;
    /** One line under the picker. */
    detail: string;
    /** kg/m³ */
    density: number;
    /** GPa */
    youngGPa: number;
    /** MPa that a joint takes in tension, crushing and shear. */
    tensionMPa: number;
    compressionMPa: number;
    shearMPa: number;
    /** "Concrete blocks, mortar joints" */
    kind: string;
}

export const MATERIAL_FACTS: Record<MaterialId, MaterialFacts> = {
    concrete: {
        label: "Concrete",
        detail: "Concrete blocks, mortar joints · 2400 kg/m³ · joints take 0.2 MPa tension",
        kind: "Concrete blocks, mortar joints",
        density: 2400,
        youngGPa: 30,
        tensionMPa: 0.2,
        compressionMPa: 20,
        shearMPa: 1,
    },
    timber: {
        label: "Timber",
        detail: "Softwood blocks, glued · 500 kg/m³ · joints take 0.4 MPa tension",
        kind: "Softwood blocks, glued joints",
        density: 500,
        youngGPa: 11,
        tensionMPa: 0.4,
        compressionMPa: 2.5,
        shearMPa: 4,
    },
};

/** "Concrete blocks, mortar joints (2400 kg/m³, E 30 GPa; joints take 0.2 MPa tension, 20 MPa compression, 1 MPa shear)" */
export function materialLine(id: MaterialId): string {
    const m = MATERIAL_FACTS[id] ?? MATERIAL_FACTS.concrete;
    return `${m.kind} (${m.density} kg/m³, E ${m.youngGPa} GPa; joints take ${m.tensionMPa} MPa tension, ${m.compressionMPa} MPa compression, ${m.shearMPa} MPa shear)`;
}

/** What the estimate leaves out, the other half of "an estimate for ranking, not a certificate". */
export const STRESS_CAVEAT =
    "An estimate for ranking and comparing designs, not a certificate: no wind or people, no buckling, rigid ground. Tipping is judged by the centre-of-gravity check.";

export const STRESS_LOAD_CASE = "Load case: self-weight, blocks bonded to each other and the ground.";

/** "Solved in 12 ms in your browser with Awatif FEM (open source, MIT), one beam per shared face." */
export function solverLine(solver: { backend: "wasm" | "ts"; ms: number }): string {
    const ms = solver.ms < 1 ? "under 1 ms" : `${Math.round(solver.ms)} ms`;
    const build = solver.backend === "wasm" ? "" : " (TypeScript build of its solver)";
    return `Solved in ${ms} in your browser with Awatif FEM (open source, MIT)${build}, one beam per shared face.`;
}

const MODE_WORD = { tension: "Tension", compression: "Compression", shear: "Shear" } as const;
const cell = (c: readonly number[]): string => `(${c.join(", ")})`;

/** "Tension · joint (4, 5, 6)–(5, 5, 6) · 143 of 200 kPa": what governs at a stress point, and how close it is. */
export function pointLine(p: Pick<StressPoint, "mode" | "joint" | "cell" | "utilisation" | "allowableKPa">): string {
    const where = p.joint ? `joint ${cell(p.joint[0])}–${cell(p.joint[1])}` : `block ${cell(p.cell)}`;
    const used = Math.round(p.utilisation * p.allowableKPa);
    return `${MODE_WORD[p.mode]} · ${where} · ${used} of ${Math.round(p.allowableKPa)} kPa`;
}
