import { Trash2 } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/assignment/components/ui/alert-dialog";
import type { ModelAsset } from "@/assignment/shared/contract";
import { subtreeIds, versionTitle } from "@/assignment/shared/versionTree";

/**
 * The question before a version is deleted, for the Models tab and the version control's tree: what goes (the version and the ones made from
 * it), what stays (the model it was made from) and that it cannot be undone. `model` null: closed.
 */
export function DeleteVersionDialog({
    model,
    models,
    onConfirm,
    onCancel,
}: {
    model: ModelAsset | null;
    models: readonly ModelAsset[];
    onConfirm: (model: ModelAsset) => void;
    onCancel: () => void;
}) {
    const alsoRemoved = model ? subtreeIds(models, model.id).length - 1 : 0;
    return (
        <AlertDialog open={model !== null} onOpenChange={(open) => !open && onCancel()}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                        {model ? `Delete ${versionTitle(models, model)}?` : "Delete this version?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {alsoRemoved > 0
                            ? `It is removed from the project, together with the ${alsoRemoved} ${alsoRemoved === 1 ? "version" : "versions"} made from it. `
                            : "It is removed from the project. "}
                        The model it was made from is kept. This cannot be undone.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        data-testid="delete-version-confirm"
                        onClick={() => model && onConfirm(model)}
                    >
                        Delete
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
