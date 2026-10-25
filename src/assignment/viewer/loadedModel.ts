// The handle the viewer gives the workspace for analysing the model on stage (LoadedModel).
//
// A handle is good for as long as the model it names is on stage and no longer. Once the model is replaced, the
// viewer is torn down or the component goes away, the handle is retired and reading it THROWS: an empty triangle
// soup would look like a valid (empty) model, and the analysis of it, "No blocks", would be cached and saved as if
// it were the model's verdict.
import type { PartSoup } from "../analysis/partLabels.ts";
import type { LoadedModel } from "../analysis/types.ts";
import type { AssemblyDescriptor } from "../shared/assembly.ts";
import { partSoupsOf } from "./partSoups.ts";

export interface ModelHandle {
    model: LoadedModel;
    /** Retires the handle; true when it was still good (so the owner reports the retirement once). */
    retire(): boolean;
}

/** `assembly`: the block assembly the GLB declares (a stabilized model), else null; the analysis then reads its cells instead of voxelising the triangles. */
export function createModelHandle(url: string, read: () => Float32Array | null, assembly: AssemblyDescriptor | null = null): ModelHandle {
    let retired = false;
    const gone = () => new Error("The model is no longer shown in the viewer, so it cannot be analysed.");
    return {
        model: {
            url,
            assembly,
            extractTriangles: () => {
                if (retired) throw gone();
                // A scene that was freed under the handle reads as nothing at all.
                const positions = read();
                if (!positions || positions.length === 0) throw gone();
                return { positions };
            },
        },
        retire() {
            const was = !retired;
            retired = true;
            return was;
        },
    };
}

/**
 * The model cut into its glTF parts (one triangle soup each, in the same frame as extractTriangles), for labelling the blocks by part
 * (analysis/partLabels.ts). Null when the handle was not made over a viewer scene. Reads the model like extractTriangles does: it THROWS
 * once the handle is retired.
 */
export function partSoupsOfModel(model: LoadedModel): PartSoup[] | null {
    return partSoupsOf(model.extractTriangles().positions);
}
