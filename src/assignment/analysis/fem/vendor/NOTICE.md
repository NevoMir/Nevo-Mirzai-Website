# Vendored: Awatif FEM linear solver (MIT) and what is compiled into it

- Source: https://github.com/madil4/awatif, tag/commit "Release awatif v3.4.0" (2026-10-06),
  files components/analysis/l-solver/cpp/built/lSolver.js and lSolver.wasm (+ the C++ in .../cpp/lSolver.cpp).
- License: MIT, (c) 2025 Mohamed Adil (see LICENSE-awatif-MIT.txt). Keep this file and the license next to the binary.
- lSolver.js is unmodified. It is the glue code Emscripten generated for the build (Emscripten is MIT / NCSA licensed; the generated glue
  carries no separate notice).
- lSolver.wasm is MODIFIED: the linear-memory stack was enlarged from emscripten's default
  64 KiB to 4 MiB (+4194304 bytes) by moving __heap_base / __stack_pointer from 97248 to 4291552 (4 constants +
  the sbrk start in the data segment). Reason: the upstream build (`em++ ... -O3 -s ASSERTIONS -s ALLOW_MEMORY_GROWTH`,
  no -sSTACK_SIZE) overflows its 64 KiB stack inside Eigen::SparseLU on lattices of ~80+ nodes, corrupting the heap
  (free() aborts / "memory access out of bounds"). Reproduce with ../patch-lsolver-stack.mjs.
- Proper fix (needs emscripten): rebuild with `-s STACK_SIZE=4MB` (and without -s ASSERTIONS), same sources.

## Eigen (MPL-2.0), statically linked into lSolver.wasm

lSolver.wasm contains compiled code from **Eigen**, the C++ template library for linear algebra (the sparse LU factorisation that
solves the frame equations, `Eigen/src/SparseCore`, `Eigen/src/SparseLU`, `Eigen/src/Core`). Eigen is licensed under the
Mozilla Public License 2.0 (the full text is in LICENSE-eigen-MPL-2.0.txt, or https://www.mozilla.org/MPL/2.0/).

- This binary is the "Executable Form" of that code. No Eigen source file is part of this repository, and nothing in Eigen was
  changed here (the stack patch above edits constants of the compiled module only).
- The Eigen **source code** is available, free of charge, from https://gitlab.com/libeigen/eigen.
  Awatif built the module from a local checkout of Eigen whose version is not recorded in the binary; Awatif's repository
  (https://github.com/madil4/awatif, folder components/analysis/l-solver/cpp) holds the C++ that was compiled, and an Eigen
  release from https://gitlab.com/libeigen/eigen can be used to rebuild an equivalent module from it.
- The MIT licence of Awatif applies to Awatif's own code (lSolver.cpp and the wrapper); it does not replace Eigen's licence for the
  Eigen code inside the binary.
