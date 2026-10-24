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
