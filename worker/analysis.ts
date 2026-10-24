// Validation of the analysis summary a browser saves with PUT /models/:id/analysis (the contract's AnalysisSummary).
// The checks themselves live in shared/analysisSummary.ts (the browser validates DerivedMeta.after_summary with the
// same rules); this file adds the request-shaped parts and keeps the old import path working.

import type { AnalysisSummary } from "../src/assignment/shared/contract.ts";
import { checkAnalysisSummary } from "../src/assignment/shared/analysisSummary.ts";
import { HttpError } from "./util.ts";

export { checkAnalysisSummary, readStoredAnalysis } from "../src/assignment/shared/analysisSummary.ts";

/** Largest request body PUT /models/:id/analysis accepts (a real summary is about 500 bytes). */
export const ANALYSIS_BODY_LIMIT = 8 * 1024;

/** The request's `summary` field, validated and rebuilt; anything wrong is a 400 that says which field. */
export function parseAnalysisSummary(body: Record<string, unknown>): AnalysisSummary {
    const result = checkAnalysisSummary(body.summary, Date.now());
    if (!result.ok) throw new HttpError(400, result.error);
    return result.value;
}
