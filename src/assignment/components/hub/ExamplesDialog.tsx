import { ExampleGallery } from "@/assignment/components/chat/ExampleGallery";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/assignment/components/ui/dialog";

/**
 * "From example…": the ready-made projects as a grid. Picking one creates the project and opens it on the Analysis
 * tab, which takes the visitor out of the hub, so the dialog closes with it.
 */
export function ExamplesDialog({
    open,
    onOpenChange,
    tagId = null,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** File the new project under this tag (the hub's tag page). */
    tagId?: string | null;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-testid="examples-dialog"
                // Tall lists scroll inside the dialog, not the page behind it.
                className="flex max-h-[88dvh] w-[calc(100%-1.5rem)] max-w-4xl flex-col gap-4 overflow-hidden p-0 sm:rounded-2xl"
            >
                <DialogHeader className="px-5 pb-0 pr-12 pt-5">
                    <DialogTitle>Start from an example</DialogTitle>
                    <DialogDescription>
                        Ready-made projects with a generated model that has structural problems, and its stabilized
                        version. Nothing is generated, so it costs nothing.
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                    <ExampleGallery variant="grid" tagId={tagId} onOpened={() => onOpenChange(false)} />
                </div>
            </DialogContent>
        </Dialog>
    );
}
