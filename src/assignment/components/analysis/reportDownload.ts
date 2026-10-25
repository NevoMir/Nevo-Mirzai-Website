// The report files of the analysis (JSON and the blocks as CSV), for the panel's "..." export menu.

import type { AnalysisResult } from "@/assignment/analysis/types";
import { downloadText } from "@/assignment/components/analysis/download";
import { modelFileName } from "@/assignment/components/workspace/format";
import type { ModelAsset } from "@/assignment/shared/contract";
import { reportStem } from "@/assignment/store/analysisLogic";

/** Build one report file for `model` from its analysis and hand it to the visitor. The builders load on first use. */
export async function downloadReport(kind: "json" | "csv", result: AnalysisResult, model: ModelAsset): Promise<void> {
    const report = await import("@/assignment/analysis/report");
    const stem = reportStem(modelFileName(model));
    if (kind === "json") {
        const meta = { modelId: model.id, modelUrl: model.glb_url, prompt: model.prompt, provider: model.provider, derived: model.derived };
        downloadText(`${stem}.json`, "application/json", report.buildReportJson(result, meta));
    } else {
        downloadText(`${stem}-blocks.csv`, "text/csv", report.buildBlocksCsv(result));
    }
}
