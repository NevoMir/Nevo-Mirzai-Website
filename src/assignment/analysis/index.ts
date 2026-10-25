// Public surface of the analysis engine. The viewer and the report panel import from here (or from the
// individual modules); nothing in this barrel touches the DOM until runAnalysis starts a worker.

export * from "./types.ts";
export { analyze, analyzeGrid, toAnalysisMm, toModelSpace } from "./analyze.ts";
export { runAnalysis, abortError, clearAnalysisCache, EmptyModelError } from "./runAnalysis.ts";
export type { AnalysisProgress, RunOptions, SoupSource } from "./runAnalysis.ts";
export { buildBlocksCsv, buildReport, buildReportJson } from "./report.ts";
export type { ReportDocument, ReportMeta } from "./report.ts";
export { DEFINITIONS } from "./definitions.ts";
export type { Definition } from "./definitions.ts";
export { normalizeSettings } from "./settings.ts";
export { placementForBounds, transformForBounds } from "./voxelize.ts";
export { analyzeAssembly, annotateRoles, boundsOf, cellsOf, gridFromAssembly, originalOf, parseBounds, parseSize, parseTransform, settingsForAssembly, soupBoundsOf, sourcePlacementOf, sourceTransformOf } from "./assembly.ts";
export type { Bounds } from "./assembly.ts";
export { applyStress, computeStress, loadSolver, stressUnavailable, STRESS_UNAVAILABLE } from "./stress.ts";
export type { SolverHandle } from "./stress.ts";
export { analyzeAssemblyWithStress, resetSharedSolver, sharedSolver, withStress } from "./withStress.ts";
export type { StressOptions } from "./withStress.ts";
export { DEFAULT_MATERIAL, STRESS_FAIL, STRESS_MATERIALS, STRESS_WARN, materialOf } from "./materials.ts";
export { STRESS_ASSUMPTIONS } from "./definitions.ts";
