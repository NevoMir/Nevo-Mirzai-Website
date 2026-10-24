// BufferGeometry parts -> GLB via @gltf-transform/core (no DOM shims; GLTFExporter would need FileReader/Blob).
import { Document, NodeIO } from "@gltf-transform/core";

export function buildDocument({ name, parts, copyright = "Procedurally generated for Assembly Studio. Contains no third-party assets.", extras = {} }) {
    const doc = new Document();
    const root = doc.getRoot();
    root.getAsset().generator = "Assembly Studio examples (three.js geometry, glTF-Transform)";
    root.getAsset().copyright = copyright;
    const buffer = doc.createBuffer();
    const scene = doc.createScene(name);
    scene.setExtras({ ...extras });
    const materials = new Map();
    for (const part of parts) {
        const g = part.geometry();
        const pos = g.attributes.position.array;
        const nor = g.attributes.normal.array;
        const idx = g.index.array;
        const key = JSON.stringify(part.material);
        let material = materials.get(key);
        if (!material) {
            const m = part.material;
            material = doc.createMaterial(m.name ?? part.name).setBaseColorFactor(m.color).setMetallicFactor(m.metal).setRoughnessFactor(m.rough).setDoubleSided(Boolean(m.doubleSided));
            if (m.emissive) material.setEmissiveFactor(m.emissive);
            if (m.alpha < 1) material.setAlphaMode("BLEND");
            materials.set(key, material);
        }
        const position = doc.createAccessor(`${part.name} positions`).setType("VEC3").setBuffer(buffer).setArray(new Float32Array(pos));
        const normal = doc.createAccessor(`${part.name} normals`).setType("VEC3").setBuffer(buffer).setArray(new Float32Array(nor));
        const indices = doc.createAccessor(`${part.name} indices`).setType("SCALAR").setBuffer(buffer).setArray(g.attributes.position.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx));
        const prim = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setIndices(indices).setMaterial(material);
        const mesh = doc.createMesh(part.name).addPrimitive(prim);
        scene.addChild(doc.createNode(part.name).setMesh(mesh).setExtras({ part: part.name }));
    }
    return doc;
}

/** The GLB bytes of a document. glTF-Transform writes the same bytes for the same document (no timestamps, no ids). */
export async function glbBytes(doc) {
    return new NodeIO().writeBinary(doc);
}
