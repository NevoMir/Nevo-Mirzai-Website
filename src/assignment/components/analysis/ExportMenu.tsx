import { useState } from "react";
import { Box, Ellipsis, FileJson, Loader2, Table2 } from "lucide-react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { downloadReport } from "@/assignment/components/analysis/reportDownload";
import { useUnsavedGlb } from "@/assignment/components/analysis/useUnsavedGlb";
import { Button } from "@/assignment/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import { toast } from "@/assignment/components/ui/sonner";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";

/**
 * The panel's downloads behind one "..." button: the report (JSON, with the technical terms), the blocks (CSV) and, while a
 * stabilizer run has an unsaved result, its model (GLB). A spinner replaces the dots while a file is being made.
 */
export function ExportMenu({ model, result, className }: { model: ModelAsset | null; result: AnalysisResult | null; className?: string }) {
    const [busy, setBusy] = useState<"json" | "csv" | null>(null);
    const glb = useUnsavedGlb();
    const ready = result !== null && model !== null;

    const download = async (kind: "json" | "csv") => {
        if (!result || !model || busy) return;
        setBusy(kind);
        try {
            await downloadReport(kind, result, model);
        } catch {
            toast.error("Could not create the file");
        } finally {
            setBusy(null);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn("h-11 w-11 text-muted-foreground hover:bg-secondary hover:text-foreground md:h-7 md:w-7", className)}
                    disabled={!ready && !glb}
                    aria-label="Export"
                    title="Export"
                    data-testid="export-menu"
                >
                    {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Ellipsis />}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem className="min-h-11 md:min-h-0" disabled={!ready || busy !== null} onSelect={() => void download("json")} data-testid="download-json" aria-label="Download report (JSON)">
                    <FileJson className="mr-2 h-4 w-4" aria-hidden />
                    Report (JSON)
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-11 md:min-h-0" disabled={!ready || busy !== null} onSelect={() => void download("csv")} data-testid="download-csv" aria-label="Download blocks (CSV)">
                    <Table2 className="mr-2 h-4 w-4" aria-hidden />
                    Blocks (CSV)
                </DropdownMenuItem>
                {glb && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onSelect={glb.download} data-testid="download-glb" aria-label="Download the stabilized model (GLB)">
                            <Box className="mr-2 h-4 w-4" aria-hidden />
                            Stabilized model (GLB)
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
