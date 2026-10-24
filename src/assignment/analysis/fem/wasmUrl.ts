// Where Awatif's WebAssembly binary is, as a URL the solver can load from.
//
// `new URL("<literal>", import.meta.url)` is the one spelling that works in both places this code runs: Vite sees the
// literal, copies the file into the build as a hashed asset and rewrites the URL (in the page and in the analysis
// worker alike), and Node resolves it to a file: URL that the emscripten loader reads from disk (the test suites).
// A `?url` import would only work under Vite.
export const AWATIF_WASM_URL: string = new URL("./vendor/lSolver.wasm", import.meta.url).href;
