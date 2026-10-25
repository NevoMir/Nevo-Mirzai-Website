// The way from a model's triangles to its parts. The analysis reads a model through a LoadedModel handle (loadedModel.ts), which gives
// one triangle soup for the whole model; labelling the blocks by part (analysis/partLabels.ts) needs one soup per glTF part. The scene
// that cut the soup remembers how to cut it per part: whoever holds the soup can ask for the parts, with no help from the code that
// created the handle. Plain data, no three import: the scene is loaded lazily and this is not.

import type { PartSoup } from "../analysis/partLabels.ts";

const sources = new WeakMap<Float32Array, () => PartSoup[]>();

/** Called by the scene each time it hands out a soup: `parts` yields the same model cut into its glTF parts (empty once the scene is gone). */
export function rememberPartSoups(soup: Float32Array, parts: () => PartSoup[]): void {
    sources.set(soup, parts);
}

/** The parts of the model `soup` was extracted from, or null when the soup is not one a viewer scene handed out. */
export function partSoupsOf(soup: Float32Array): PartSoup[] | null {
    return sources.get(soup)?.() ?? null;
}
