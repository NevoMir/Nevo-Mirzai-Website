// Reproduces vendor/lSolver.wasm from Awatif's original lSolver.wasm: enlarges the wasm stack (default 64 KiB).
//   npm i wabt && node patch-lsolver-stack.mjs <in.wasm> <out.wasm> [extraBytes=4194304]
// Method: wasm -> WAT (wabt), move __heap_base / __stack_pointer (global 0 init value H) up by `extra` bytes
// everywhere it appears (global init, 2 constants in __wasm_call_ctors / emscripten_stack_init, and the little-endian
// sbrk start stored in the data segment), WAT -> wasm. Linear memory size/growth is unchanged.
import fs from "fs";
import wabtInit from "wabt";
const [inPath, outPath, extraArg] = process.argv.slice(2);
const extra = Number(extraArg ?? 4194304);
const wabt = await wabtInit();
const mod = wabt.readWasm(fs.readFileSync(inPath), { readDebugNames: true });
mod.generateNames(); mod.applyNames();
let wat = mod.toText({ foldExprs: false, inlineExport: false });
const g = /\(global \$g0 \(mut i32\) \(i32\.const (\d+)\)\)/.exec(wat);
if (!g) throw new Error("global $g0 (stack pointer) not found");
const H = Number(g[1]), H2 = H + extra;
const consts = wat.split(`i32.const ${H}\n`).length - 1, inGlobal = wat.split(`(i32.const ${H})`).length - 1;
wat = wat.replaceAll(`i32.const ${H}\n`, `i32.const ${H2}\n`).replaceAll(`(i32.const ${H})`, `(i32.const ${H2})`);
const esc = (v) => [0, 8, 16, 24].map((s) => (v >>> s) & 255).map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : "\\" + b.toString(16).padStart(2, "0"))).join("");
const before = wat.split(esc(H)).length - 1;
wat = wat.replaceAll(esc(H), esc(H2));
console.log({ H, H2, constInstr: consts, globalInit: inGlobal, dataPatternHits: before });
if (consts < 2 || inGlobal !== 1 || before !== 1) throw new Error("unexpected layout; refusing to write");
const m2 = wabt.parseWat("x.wat", wat, { mutable_globals: true, sat_float_to_int: true, sign_extension: true, bulk_memory: true, multi_value: true, reference_types: true });
m2.resolveNames(); m2.validate();
fs.writeFileSync(outPath, Buffer.from(m2.toBinary({ log: false, write_debug_names: false }).buffer));
console.log("wrote", outPath);
