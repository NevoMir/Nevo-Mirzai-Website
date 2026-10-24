// Module resolution hook (module.register): "react" resolves to react-hook-shim.mjs. See test-viewer.mjs.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "react") return { url: new URL("./react-hook-shim.mjs", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
}
