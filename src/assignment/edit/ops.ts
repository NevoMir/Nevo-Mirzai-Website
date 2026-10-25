// The ops of an edit program, run on an EditState in the edit frame (mm). Each op changes the state in place and returns a few counts
// for the log. A selection that finds nothing throws MeshEditError("notfound"): "I couldn't find the <label> on this model."
//
//   stretch  p_a += amount * clamp((p_a - from) / (to - from)) * w     (w ignores axis a, so posts stay continuous)
//   move     p += vector * w            scale  p = pivot + (p - pivot) * (1 + w * (factor - 1))     rotate  by degrees * w about the axis
//   delete   removes the triangles whose vertices are mostly selected, then caps each hole with a fan from its centre (one texture coordinate per cap)
//   mirror_copy  copies the selected triangles reflected in the plane axis = mirror_at_mm (winding reversed); the copies are marked as
//                looking at a picture of their own (EditState.page), which the texture step makes real (texture.ts stackCopyPicture)
//   recolor  is texture work: the op only records the colour and where (per-vertex weights; null = the whole model)
//   add_parts  collects primitive parts (mm in this frame); the writer turns them into nodes

import { MAX_EDIT_TRIANGLES } from "../shared/contract.ts";
import type { ExecutorOp } from "../shared/meshProgram.ts";
import { countPositive, selectionWeights } from "./selection.ts";
import { MeshEditError, type EditMesh, type EditState, type OpLog } from "./types.ts";
import { weldIds } from "./weld.ts";

export const AXIS = { x: 0, y: 1, z: 2 } as const;

/** A delete that would take more than this share of the triangles is refused: it is a different model, not an edit. */
export const MAX_DELETE_SHARE = 0.6;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function makeState(mesh: EditMesh): EditState {
    return { Q: Float32Array.from(mesh.Q), uv: Float32Array.from(mesh.uv), nor: Float32Array.from(mesh.nor), idx: Uint32Array.from(mesh.idx), paints: [], parts: [], page: new Uint8Array(mesh.Q.length / 3) };
}

const notFound = (op: ExecutorOp): MeshEditError => new MeshEditError("notfound", `I couldn't find the ${op.label} on this model.`);

/** The selection of `op`; throws when it selects nothing. */
function selectOrFail(m: EditState, op: ExecutorOp, skipAxis = -1): Float32Array {
    const w = selectionWeights(m.Q, op.where, skipAxis);
    if (countPositive(w) === 0) throw notFound(op);
    return w;
}

/**
 * Inside its zone a stretch moves a point by amount * (p - from) / (to - from), so the zone is scaled by 1 + amount / (to - from). A negative
 * amount as large as the zone makes that factor zero (the zone collapses flat) and a larger one makes it negative (the zone folds through
 * itself and the surface turns inside out). The zone keeps at least this much of its height ...
 */
const MIN_SQUEEZE = 0.1;
/** ... and is widened (upward: everything above it moves by the full amount anyway) until it keeps this much. */
const SQUEEZE_ROOM = 0.2;

function opStretch(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const a = AXIS[op.axis];
    const w = selectOrFail(m, op, a);
    const lo = op.from_mm ?? 0;
    let hi = Math.max(op.to_mm ?? 0, lo + 1);
    const amount = op.amount_mm ?? 0;
    let note: string | undefined;
    if (amount < 0 && 1 + amount / (hi - lo) < MIN_SQUEEZE) {
        // Making the zone as short as the plan says would fold the mesh. Spread the same shortening over a longer stretch instead: the model
        // still ends up `amount` shorter, with the squeeze taking place a little higher up.
        hi = lo + -amount / (1 - SQUEEZE_ROOM);
        const what = op.label && op.label !== op.op ? `the ${op.label}` : "that part";
        note = `Taking ${Math.round(-amount)} mm off ${what} needed more room than the stretch the plan picked, so the change was spread over a longer one.`;
    }
    for (let v = 0; v < w.length; v++) {
        if (w[v] === 0) continue;
        const t = clamp01((m.Q[v * 3 + a] - lo) / (hi - lo));
        m.Q[v * 3 + a] += amount * t * w[v];
    }
    return { moved: countPositive(w), ...(note ? { note } : {}) };
}

function opMove(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const w = selectOrFail(m, op);
    const vec = op.vector_mm ?? [0, 0, 0];
    for (let v = 0; v < w.length; v++) for (let a = 0; a < 3; a++) m.Q[v * 3 + a] += vec[a] * w[v];
    return { moved: countPositive(w) };
}

function opScale(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const w = selectOrFail(m, op);
    const pivot = op.pivot_mm ?? [0, 0, 0];
    const factors = op.factors ?? [1, 1, 1];
    for (let v = 0; v < w.length; v++) {
        if (w[v] === 0) continue;
        for (let a = 0; a < 3; a++) m.Q[v * 3 + a] = pivot[a] + (m.Q[v * 3 + a] - pivot[a]) * (1 + w[v] * (factors[a] - 1));
    }
    return { moved: countPositive(w) };
}

function opRotate(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const w = selectOrFail(m, op);
    const axis = AXIS[op.axis];
    const pivot = op.pivot_mm ?? [0, 0, 0];
    const degrees = op.degrees ?? 0;
    // Positive degrees turn counter-clockwise seen from +axis toward the origin (right-hand rule).
    const i = (axis + 1) % 3;
    const j = (axis + 2) % 3;
    for (let v = 0; v < w.length; v++) {
        if (w[v] === 0) continue;
        const r = (degrees * w[v] * Math.PI) / 180;
        const c = Math.cos(r);
        const s = Math.sin(r);
        const di = m.Q[v * 3 + i] - pivot[i];
        const dj = m.Q[v * 3 + j] - pivot[j];
        m.Q[v * 3 + i] = pivot[i] + c * di - s * dj;
        m.Q[v * 3 + j] = pivot[j] + s * di + c * dj;
    }
    return { moved: countPositive(w) };
}

/** Keeps the per-vertex weights of the recolors in step with a mesh whose vertices were renumbered: `from[newIndex]` = the old index, or -1 for a new vertex. */
function remapPaints(m: EditState, from: Int32Array): void {
    for (const paint of m.paints) {
        if (!paint.weights) continue;
        const old = paint.weights;
        const next = new Float32Array(from.length);
        for (let v = 0; v < from.length; v++) next[v] = from[v] >= 0 ? old[from[v]] : 0;
        paint.weights = next;
    }
}

/** Triangles whose vertices are mostly selected (mean weight >= 0.5) go; the holes this leaves are capped. */
function opDelete(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const w = selectOrFail(m, op);
    const nt = m.idx.length / 3;
    const dead = new Uint8Array(nt);
    let deleted = 0;
    for (let t = 0; t < nt; t++) {
        if ((w[m.idx[t * 3]] + w[m.idx[t * 3 + 1]] + w[m.idx[t * 3 + 2]]) / 3 >= 0.5) {
            dead[t] = 1;
            deleted++;
        }
    }
    if (deleted === 0) throw notFound(op);
    if (deleted > nt * MAX_DELETE_SHARE) throw new MeshEditError("toomuch", "That would remove most of the model. Describe a smaller change, or generate the model again.");

    const { ids, count } = weldIds(m.Q);
    // The undirected edge of two welded points as one number.
    const key = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);
    const deadEdges = new Set<number>();
    for (let t = 0; t < nt; t++) {
        if (!dead[t]) continue;
        for (let k = 0; k < 3; k++) deadEdges.add(key(ids[m.idx[t * 3 + k]], ids[m.idx[t * 3 + ((k + 1) % 3)]]));
    }
    // The new boundary: edges of kept triangles that a deleted triangle shared, directed as the kept triangle runs.
    const ea: number[] = [];
    const eb: number[] = [];
    for (let t = 0; t < nt; t++) {
        if (dead[t]) continue;
        for (let k = 0; k < 3; k++) {
            const a = m.idx[t * 3 + k];
            const b = m.idx[t * 3 + ((k + 1) % 3)];
            if (deadEdges.has(key(ids[a], ids[b]))) {
                ea.push(a);
                eb.push(b);
            }
        }
    }
    const startsAt = new Map<number, number[]>();
    ea.forEach((a, e) => {
        const list = startsAt.get(ids[a]);
        if (list) list.push(e);
        else startsAt.set(ids[a], [e]);
    });
    // Chain the boundary edges into closed loops. Where a loop touches itself at a point (a pinch: the boundary passes through one welded
    // point twice), the part between the two visits is cut out as a loop of its own, so every fan is a simple ring.
    const used = new Uint8Array(ea.length);
    const loops: number[][] = [];
    for (let e0 = 0; e0 < ea.length; e0++) {
        if (used[e0]) continue;
        used[e0] = 1;
        const startWeld = ids[ea[e0]];
        const loop = [ea[e0]];
        const at = new Map<number, number>([[startWeld, 0]]);
        let curB = eb[e0];
        let closed = false;
        for (let guard = 0; guard < ea.length + 2; guard++) {
            const weld = ids[curB];
            if (weld === startWeld) {
                closed = true;
                break;
            }
            const seenAt = at.get(weld);
            if (seenAt !== undefined) {
                // The boundary came back to a point it already passed: that stretch is a closed loop by itself.
                const inner = loop.splice(seenAt + 1);
                if (inner.length >= 2) loops.push([loop[seenAt], ...inner]);
                for (const v of inner) at.delete(ids[v]);
            } else {
                at.set(weld, loop.length);
                loop.push(curB);
            }
            const next = startsAt.get(weld)?.find((e) => !used[e]);
            if (next === undefined) break;
            used[next] = 1;
            curB = eb[next];
        }
        if (closed && loop.length >= 3) loops.push(loop);
    }

    // Kept triangles, then one fan per loop from its centre (the fan runs against the kept edges).
    const n0 = m.Q.length / 3;
    let extra = 0;
    let capTris = 0;
    for (const loop of loops) {
        extra += 1 + loop.length;
        capTris += loop.length;
    }
    const total = n0 + extra;
    const Q1 = new Float32Array(total * 3);
    Q1.set(m.Q);
    const uv1 = new Float32Array(total * 2);
    uv1.set(m.uv);
    const nor1 = new Float32Array(total * 3);
    nor1.set(m.nor);
    const page1 = new Uint8Array(total);
    page1.set(m.page);
    const idx1 = new Uint32Array((nt - deleted + capTris) * 3);
    let at = 0;
    for (let t = 0; t < nt; t++) {
        if (dead[t]) continue;
        idx1[at++] = m.idx[t * 3];
        idx1[at++] = m.idx[t * 3 + 1];
        idx1[at++] = m.idx[t * 3 + 2];
    }
    let nv = n0;
    for (const loop of loops) {
        let cx = 0, cy = 0, cz = 0;
        for (const v of loop) {
            cx += m.Q[v * 3]; cy += m.Q[v * 3 + 1]; cz += m.Q[v * 3 + 2];
        }
        const L = loop.length;
        cx /= L; cy /= L; cz /= L;
        // The whole cap takes ONE texture coordinate, the one of the ring point nearest the centre: a cut can cross the picture's islands, and
        // a centre UV averaged from points of different islands (or ring points that keep their own) would smear unrelated parts of the
        // picture across the cut face. One coordinate = a flat patch of the surrounding colour.
        let near = loop[0];
        let nearDist = Infinity;
        for (const v of loop) {
            const d = (m.Q[v * 3] - cx) ** 2 + (m.Q[v * 3 + 1] - cy) ** 2 + (m.Q[v * 3 + 2] - cz) ** 2;
            if (d < nearDist) {
                nearDist = d;
                near = v;
            }
        }
        const capU = m.uv[near * 2];
        const capV = m.uv[near * 2 + 1];
        const c = nv++;
        Q1[c * 3] = cx; Q1[c * 3 + 1] = cy; Q1[c * 3 + 2] = cz;
        uv1[c * 2] = capU; uv1[c * 2 + 1] = capV;
        page1[c] = m.page[near];
        const ring = nv;
        for (const v of loop) {
            Q1[nv * 3] = m.Q[v * 3]; Q1[nv * 3 + 1] = m.Q[v * 3 + 1]; Q1[nv * 3 + 2] = m.Q[v * 3 + 2];
            uv1[nv * 2] = capU; uv1[nv * 2 + 1] = capV;
            page1[nv] = m.page[near]; // the cap takes its colour from one place, so it looks at that place's picture
            nv++;
        }
        for (let i = 0; i < L; i++) {
            idx1[at++] = c;
            idx1[at++] = ring + ((i + 1) % L);
            idx1[at++] = ring + i;
        }
    }
    // Compact: vertices only the deleted triangles used are dropped.
    const used2 = new Uint8Array(total);
    for (let i = 0; i < idx1.length; i++) used2[idx1[i]] = 1;
    const remap = new Int32Array(total).fill(-1);
    let kept = 0;
    for (let v = 0; v < total; v++) if (used2[v]) remap[v] = kept++;
    const from = new Int32Array(kept);
    const Q2 = new Float32Array(kept * 3);
    const uv2 = new Float32Array(kept * 2);
    const nor2 = new Float32Array(kept * 3);
    const page2 = new Uint8Array(kept);
    for (let v = 0; v < total; v++) {
        const r = remap[v];
        if (r < 0) continue;
        from[r] = v < n0 ? v : -1;
        page2[r] = page1[v];
        Q2[r * 3] = Q1[v * 3]; Q2[r * 3 + 1] = Q1[v * 3 + 1]; Q2[r * 3 + 2] = Q1[v * 3 + 2];
        uv2[r * 2] = uv1[v * 2]; uv2[r * 2 + 1] = uv1[v * 2 + 1];
        nor2[r * 3] = nor1[v * 3]; nor2[r * 3 + 1] = nor1[v * 3 + 1]; nor2[r * 3 + 2] = nor1[v * 3 + 2];
    }
    for (let i = 0; i < idx1.length; i++) idx1[i] = remap[idx1[i]];
    remapPaints(m, from);
    m.Q = Q2;
    m.uv = uv2;
    m.nor = nor2;
    m.idx = idx1;
    m.page = page2;
    return { deleted, capped: loops.length, triangles: idx1.length / 3 };
}

/** Copies the selected triangles mirrored about the plane `axis = mirror_at_mm` (reversed winding). */
function opMirrorCopy(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const a = AXIS[op.axis];
    const w = selectOrFail(m, op);
    const at = op.mirror_at_mm ?? 0;
    const nt = m.idx.length / 3;
    const pick: number[] = [];
    for (let t = 0; t < nt; t++) if ((w[m.idx[t * 3]] + w[m.idx[t * 3 + 1]] + w[m.idx[t * 3 + 2]]) / 3 >= 0.5) pick.push(t);
    if (pick.length === 0) throw notFound(op);
    if (nt + pick.length > MAX_EDIT_TRIANGLES) throw new MeshEditError("toobig", "The result would be too detailed to save. Describe a smaller change.");
    const n0 = m.Q.length / 3;
    const copyOf = new Map<number, number>();
    const source: number[] = [];
    for (const t of pick) {
        for (let k = 0; k < 3; k++) {
            const v = m.idx[t * 3 + k];
            if (!copyOf.has(v)) {
                copyOf.set(v, n0 + source.length);
                source.push(v);
            }
        }
    }
    const total = n0 + source.length;
    const Q2 = new Float32Array(total * 3);
    Q2.set(m.Q);
    const uv2 = new Float32Array(total * 2);
    uv2.set(m.uv);
    const nor2 = new Float32Array(total * 3);
    nor2.set(m.nor);
    const page2 = new Uint8Array(total);
    page2.set(m.page);
    source.forEach((v, i) => {
        const o = n0 + i;
        page2[o] = 1;
        for (let k = 0; k < 3; k++) {
            Q2[o * 3 + k] = m.Q[v * 3 + k];
            nor2[o * 3 + k] = m.nor[v * 3 + k];
        }
        Q2[o * 3 + a] = 2 * at - m.Q[v * 3 + a];
        nor2[o * 3 + a] = -m.nor[v * 3 + a];
        uv2[o * 2] = m.uv[v * 2];
        uv2[o * 2 + 1] = m.uv[v * 2 + 1];
    });
    const idx2 = new Uint32Array(m.idx.length + pick.length * 3);
    idx2.set(m.idx);
    pick.forEach((t, i) => {
        idx2[m.idx.length + i * 3] = copyOf.get(m.idx[t * 3]) as number;
        idx2[m.idx.length + i * 3 + 1] = copyOf.get(m.idx[t * 3 + 2]) as number;
        idx2[m.idx.length + i * 3 + 2] = copyOf.get(m.idx[t * 3 + 1]) as number;
    });
    const from = new Int32Array(total);
    for (let v = 0; v < n0; v++) from[v] = v;
    source.forEach((v, i) => (from[n0 + i] = v));
    remapPaints(m, from);
    m.Q = Q2;
    m.uv = uv2;
    m.nor = nor2;
    m.idx = idx2;
    m.page = page2;
    return { copied: pick.length };
}

/**
 * A recolor is texture work: the executor only records it (weights per vertex for a region, null for the whole model). "Everything except
 * the top" has no boxes but does have an exclude: that is a region (selectionWeights gives 1 everywhere, minus the excluded places), so the
 * whole-picture shortcut is only for a recolor with neither.
 */
function opRecolor(m: EditState, op: ExecutorOp): Partial<OpLog> {
    const whole = op.where.boxes.length === 0 && op.where.exclude.length === 0;
    const weights = whole ? null : selectOrFail(m, op);
    m.paints.push({ color: op.color ?? "#808080", strength: op.strength ?? 1, weights });
    return { whole };
}

function opAddParts(m: EditState, op: ExecutorOp): Partial<OpLog> {
    for (const part of op.parts ?? []) m.parts.push({ ...part, size: [...part.size], position: [...part.position], rotation: [...part.rotation] });
    return { added: op.parts?.length ?? 0 };
}

export const OPS: Record<ExecutorOp["op"], (m: EditState, op: ExecutorOp) => Partial<OpLog>> = {
    stretch: opStretch,
    move: opMove,
    scale: opScale,
    rotate: opRotate,
    delete: opDelete,
    recolor: opRecolor,
    add_parts: opAddParts,
    mirror_copy: opMirrorCopy,
};
