// Awatif FEM (https://github.com/madil4/awatif, MIT) linear 3D-frame solver, C++/Eigen compiled to WebAssembly.
// vendor/lSolver.js + vendor/lSolver.wasm are Awatif v3.4.0's prebuilt solver with ONE change: the wasm stack is
// 4 MiB instead of the 64 KiB emscripten default (see vendor/NOTICE.md). The unpatched binary corrupts its heap
// (stack overflow inside Eigen's SparseLU) on lattices of roughly 80+ nodes.
//
// Usage (worker or main thread):
//     import wasmUrl from "./vendor/lSolver.wasm?url";
//     const solve = await createAwatifSolver(wasmUrl);
//     const solution = solve(model);

import type { FrameModel, FrameSolution, FrameSolver } from "./types.ts";
import { FemError } from "./types.ts";
// @ts-expect-error emscripten ES module without types (see EmscriptenModule below)
import createModule from "./vendor/lSolver.js";

interface EmscriptenModule {
    HEAPF64: Float64Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    HEAPU8: Uint8Array;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    _lSolve(...args: number[]): void;
}

const STATUS_TEXT: Record<number, string> = {
    1: "sparse LU factorisation failed (singular system: a part of the structure is not supported)",
    2: "sparse LU solve failed",
    3: "a load acts on a node that no element connects to",
    4: "an element refers to a node that does not exist",
};

/**
 * Loads the module (once per call; keep the returned function). `wasmUrl` must be the URL of lSolver.wasm.
 * If the module ever aborts (emscripten "Aborted(...)"), it is dead: call createAwatifSolver again.
 */
export async function createAwatifSolver(wasmUrl?: string): Promise<FrameSolver> {
    const mod: EmscriptenModule = await createModule(wasmUrl ? { locateFile: () => wasmUrl } : undefined);

    return (model: FrameModel): FrameSolution => {
        const n = model.nodes.length / 3;
        const m = model.elems.length / 2;
        const ptrs: number[] = [];
        // The heap can GROW during any malloc, which detaches the old HEAP* views: always read the view AFTER malloc.
        const alloc = (bytes: number): number => {
            const ptr = mod._malloc(Math.max(bytes, 8));
            ptrs.push(ptr);
            return ptr;
        };
        const f64 = (a: ArrayLike<number>): number => {
            const ptr = alloc(a.length * 8);
            mod.HEAPF64.set(a, ptr / 8);
            return ptr;
        };
        const i32 = (a: ArrayLike<number>): number => {
            const ptr = alloc(a.length * 4);
            mod.HEAP32.set(a, ptr / 4);
            return ptr;
        };
        const u32 = (a: ArrayLike<number>): number => {
            const ptr = alloc(a.length * 4);
            mod.HEAPU32.set(a, ptr / 4);
            return ptr;
        };
        const u8 = (a: ArrayLike<number>): number => {
            const ptr = alloc(a.length);
            mod.HEAPU8.set(a, ptr);
            return ptr;
        };
        try {
            const nodesPtr = f64(model.nodes);
            const elemsPtr = u32(model.elems);
            const supKeys = i32(model.supportNodes);
            const supFlags = u8(new Uint8Array(model.supportNodes.length * 6).fill(1)); // fully fixed
            const loadKeys = i32(model.loadNodes);
            const loadVals = f64(model.loadVals);
            // lSolve wants one (key -> value) map per property; the same key array 0..m-1 serves all of them.
            const keys = i32(Int32Array.from({ length: m }, (_, i) => i));
            const prop = (v: number) => f64(new Float64Array(m).fill(v));
            const p = model.props;
            const E = prop(p.E), A = prop(p.A), Iz = prop(p.Iz), Iy = prop(p.Iy), G = prop(p.G), J = prop(p.J);
            const relK = i32(new Int32Array(0)); // no end releases
            const relV = u8(new Uint8Array(0));
            const out = [0, 1, 2, 3, 4].map(() => alloc(4));
            mod._lSolve(
                nodesPtr, n, elemsPtr, m,
                supKeys, supFlags, model.supportNodes.length,
                loadKeys, loadVals, model.loadNodes.length,
                keys, E, m, keys, A, m, keys, Iz, m, keys, Iy, m, keys, G, m, keys, J, m,
                relK, relV, 0,
                out[0], out[1], out[2], out[3], out[4],
            );
            const status = mod.HEAP32[out[4] / 4];
            if (status !== 0) throw new FemError(STATUS_TEXT[status] ?? `solver status ${status}`, status);
            const posPtr = mod.HEAPU32[out[0] / 4];
            const posSize = mod.HEAPU32[out[1] / 4];
            const fPtr = mod.HEAPU32[out[2] / 4];
            const fSize = mod.HEAPU32[out[3] / 4];
            const positions = new Float64Array(mod.HEAPF64.buffer, posPtr, posSize);
            const displacements = new Float64Array(posSize);
            for (let i = 0; i < posSize; i++) displacements[i] = positions[i] - model.nodes[i];
            const forces = new Float64Array(mod.HEAPF64.buffer, fPtr, fSize).slice();
            ptrs.push(posPtr);
            if (fPtr) ptrs.push(fPtr);
            for (let i = 0; i < displacements.length; i++) {
                if (!Number.isFinite(displacements[i])) throw new FemError("solver returned non-finite displacements", -1);
            }
            return { displacements, forces };
        } finally {
            for (const ptr of ptrs) mod._free(ptr);
        }
    };
}
