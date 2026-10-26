import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
    Blocks,
    Box,
    Boxes,
    Check,
    Home,
    Layers,
    Loader2,
    MessageSquare,
    MoreHorizontal,
    PanelRightOpen,
    Pencil,
    Pin,
    PinOff,
    SlidersHorizontal,
    Trash2,
    TriangleAlert,
} from "lucide-react";

import { AnalysisDock, AnalysisSheet } from "@/assignment/components/analysis/AnalysisDock";
import { ANALYSIS_PEEK_CARD_PX, AnalysisPeekCard } from "@/assignment/components/analysis/AnalysisPeekCard";
import { ANALYSIS_DOCK_INSET_PX, ANALYSIS_PANEL_PX } from "@/assignment/components/analysis/AnalysisPanel";
import { SelectionPeek } from "@/assignment/components/analysis/SelectionPeek";
import { useAnalysisSnapshot, type AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { useAnalysisRunner } from "@/assignment/components/analysis/useAnalysisRunner";
import { GenerationOverlay } from "@/assignment/components/workspace/GenerationOverlay";
import { InlineName } from "@/assignment/components/hub/InlineName";
import { ModelsPanel } from "@/assignment/components/workspace/ModelsPanel";
import { RunChip } from "@/assignment/components/workspace/RunChip";
import { VersionSwitcher } from "@/assignment/components/workspace/VersionSwitcher";
import { useRunActivity } from "@/assignment/components/workspace/useRunActivity";
import { useVersionSwitcherState } from "@/assignment/components/workspace/useVersionSwitcherState";
import { PhonePeekDock } from "@/assignment/components/workspace/PhonePeekDock";
import { modelFileName, modelTitle } from "@/assignment/components/workspace/format";
import {
    OPTIMIZE_TAB_LABEL,
    PHONE_PEEK_MARGIN_PX,
    STABILITY_TAB_LABEL,
    applyViewPatch,
    isBlockTab,
    previewLabelOf,
    sheetOnTabTap,
    stabilityTabLabel,
    viewerInsetsFor,
    type ViewPatch,
} from "@/assignment/components/workspace/shellLogic";
import { editVersion, handleVersionKey, openVersion, versionKeyEvent } from "@/assignment/components/workspace/versionActions";
import { inTypingContext, isOptimizeKey, switcherLayout } from "@/assignment/components/workspace/versionLogic";
import { stageColorBy, useHeldStage } from "@/assignment/components/workspace/stageHold";
import { SettingsMenu } from "@/assignment/components/SettingsMenu";
import { Button } from "@/assignment/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { toast } from "@/assignment/components/ui/sonner";
import { useViewerInsets } from "@/assignment/components/workspace/useViewerInsets";
import { HIDDEN_BAR, useEdgeFade } from "@/assignment/hooks/useEdgeFade";
import { cn } from "@/assignment/lib/utils";
import { putThumbnail } from "@/assignment/lib/api";
import {
    notifyHubChanged,
    renameProjectRow,
    restoreProjects,
    setProjectPinned,
    trashProjects,
} from "@/assignment/lib/hub/hubClient";
import type { AnalysisViewState, LoadedModel } from "@/assignment/analysis/types";
import type { HubProject, ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { dockFits } from "@/assignment/store/analysisLogic";
import { completedThisSession, isTerminalJob, latestJobIds } from "@/assignment/store/jobs";
import { deleteVersion } from "@/assignment/store/models";
import { saveNow, whenSaved } from "@/assignment/store/persist";
import { savedStepOffset } from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore, type WorkspaceTab } from "@/assignment/store/useWorkspaceStore";
import { clearMeshFailures, markMeshFailed, useAssemblyFor, useVersionFamily } from "@/assignment/store/versions";
import { useCurrentWork } from "@/assignment/store/workGuard";

// three.js is imported by the viewer on first use; lazy here keeps even its React shell out of the
// first paint of the page.
const GlbViewer = lazy(() => import("@/assignment/viewer/GlbViewer"));
// The optimizer's panel is a chunk of its own: most visits never open the tab.
const OptimizePanel = lazy(() => import("@/assignment/components/optimize/OptimizePanel"));

export interface WorkspaceShellProps {
    /** Back to the projects hub: the bar's left end, on every layout. */
    onOpenProjects: () => void;
    /** Desktop only, and only while the chat is hidden: bring the chat panel back. */
    onShowChat?: () => void;
    /** Phone layout: tabs collapse to icons and a Chat button appears; the canvas and the chat are
     *  full-screen alternatives there. */
    mobile?: { onShowChat: () => void };
    /** The conversation has begun (a message exists), so an empty viewer says a model is coming. */
    chatStarted: boolean;
}

const TABS: { id: WorkspaceTab; label: string; icon: typeof Box }[] = [
    { id: "3d", label: "3D", icon: Box },
    // The report. Its id stays "analysis" (links, saved state, tests); the tab is called Stability.
    { id: "analysis", label: STABILITY_TAB_LABEL, icon: Blocks },
    // The optimizer. Its id is "optimize"; the tab is called Optimization.
    { id: "optimize", label: OPTIMIZE_TAB_LABEL, icon: SlidersHorizontal },
    { id: "models", label: "Models", icon: Layers },
];

/**
 * The Stability tab's status next to its name: a spinner while it runs, a warning triangle when the run failed, a tick when the
 * design passes, a count of problems or warnings otherwise. Symbols and numbers, so it never relies on colour alone.
 */
function StabilityTabStatus({ snapshot }: { snapshot: AnalysisSnapshot }) {
    const { phase, verdict } = snapshot;
    if (phase === "running") return <Loader2 className="ml-0.5 h-3 w-3 animate-spin text-muted-foreground" aria-hidden />;
    // A run that failed says so here too: on the 3D tab nothing else does (the report's error card is on the other tab).
    if (phase === "error") return <TriangleAlert className="ml-0.5 h-3.5 w-3.5 text-destructive" aria-hidden />;
    if (!verdict) return null;
    if (verdict.kind === "pass") return <Check className="ml-0.5 h-3.5 w-3.5 text-success" strokeWidth={3} aria-hidden />;
    const count = verdict.kind === "fail" ? verdict.errors : verdict.warnings;
    return (
        <span
            aria-hidden
            className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold leading-4 ${
                verdict.kind === "fail" ? "bg-destructive text-white" : "bg-warning text-amber-950"
            }`}
        >
            {count}
        </span>
    );
}

/**
 * The Optimization tab's status next to its name: a spinner while the optimizer works, a dot while a result waits for a decision (the work
 * guard is held for both: the optimizer says which, if it says anything, by the label it gave the guard).
 */
function OptimizeTabStatus() {
    const work = useCurrentWork();
    if (!work || work.kind !== "optimize") return null;
    if (work.waiting) {
        return <span role="img" aria-label="A result is waiting" title="A result is waiting for you" className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary" />;
    }
    return <Loader2 className="ml-0.5 h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Optimizing" />;
}

/**
 * The workspace behind the panels: the 3D viewer filling the window, the floating top bar over it
 * (Home, the project's name and menu, the tab strip, save state, settings) and, on the Models tab,
 * the list of generated models in a box under the bar.
 */
export function WorkspaceShell({ onOpenProjects, onShowChat, mobile, chatStarted }: WorkspaceShellProps) {
    const barRef = useRef<HTMLDivElement>(null);
    // Something is running (a change, the stabilizer, the optimizer): a phone keeps a place for the run chip even where it has no other row.
    const somethingRuns = useRunActivity() !== null;
    const { insets, side, width } = useViewerInsets(barRef);

    const project = useWorkspaceStore((s) => s.project);
    const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
    const messages = useWorkspaceStore((s) => s.messages);
    const jobs = useWorkspaceStore((s) => s.jobs);
    const models = useWorkspaceStore((s) => s.models);
    const activeModelId = useWorkspaceStore((s) => s.activeModelId);
    const saveStatus = useWorkspaceStore((s) => s.saveStatus);
    const tab = useWorkspaceStore((s) => s.workspaceTab);
    const providers = useWorkspaceStore((s) => s.providers?.providers);

    const activeModel = models.find((m) => m.id === activeModelId) ?? null;
    // A stabilized model names and downloads as its own version. The way back to the model it was made from is the bar's
    // version switcher (the viewer's "Stabilized from … · View original" chip is not passed: it would say the same thing twice).
    const stageTitle = activeModel ? modelTitle(activeModel) : undefined;
    const stageDownloadName = activeModel ? modelFileName(activeModel).replace(/\.glb$/i, "") : undefined;

    // ---- the mesh on stage: a stabilized model is shown over the model it was made from ----
    // The 3D tab then draws the original mesh with only the ADDED blocks on it; the Stability tab draws all the blocks
    // of the stabilized model mapped over that mesh. Without the source (deleted) the stabilized GLB itself is shown.
    const family = useVersionFamily();
    const displayModel = family && activeModel && family.active.id === activeModel.id ? family.display : activeModel;
    const displayUrl = displayModel?.glb_url ?? null;
    const onSource = Boolean(family?.isVersion && activeModel && displayModel && displayModel.id !== activeModel.id);
    // Read the blocks of the version the switcher would open before it is asked for (a few KB, kept for the analysis run that needs
    // them): the first flip to it then waits for the analysis only, not for a download and a parse as well.
    useAssemblyFor(family ? family.head : null);
    /** The url the viewer was last given: a load error is about that mesh, not about the active model's own file. */
    const viewerUrl = useRef<string | null>(null);
    viewerUrl.current = displayUrl;
    /** The model whose mesh is on stage behind a stabilized version (null when the stage shows the active model's own file). */
    const sourceOnStage = useRef<string | null>(null);
    sourceOnStage.current = onSource && displayModel ? displayModel.id : null;
    // A source mesh that failed to load is given up for the version on stage (it shows its own blocks, as when the source is
    // deleted); opening another model, or leaving, tries the sources again.
    useEffect(() => {
        clearMeshFailures();
    }, [activeModelId]);
    useEffect(() => () => clearMeshFailures(), []);

    // ---- analysis: runs on its own once the model's GLB is in the viewer ----
    useAnalysisRunner(activeModel);
    const snapshot = useAnalysisSnapshot(activeModel);
    const switcher = useVersionSwitcherState(tab);
    // The tooltips and cards number the supports of the model's own run from 1 ("added in step 1"), as the Stabilize timeline does: a
    // version made from another version carries its predecessors' steps, which the source mesh on stage has no log to count.
    // (No log to count: left to the viewer, which then numbers from the file's top step rather than guess.)
    const ownSteps = activeModel?.derived?.steps;
    const stepOffset = onSource && Array.isArray(ownSteps) ? savedStepOffset(snapshot.result, ownSteps.length) : undefined;
    const stepAssembly = onSource ? (snapshot.result?.assembly?.descriptor ?? null) : null;
    // The download of a version shown on its source mesh is the version's own blocks file: say which.
    const downloadLabel = onSource && activeModel ? `Download ${activeModel.kind === "stabilized" ? "stabilized" : activeModel.kind === "optimized" ? "optimized" : "blocks"} GLB` : undefined;
    // The block view between two versions of a model (the bar's switch, or the switch a saved run makes by itself): the new version
    // has no result until its own analysis lands, and the viewer would drop to the plain mesh (the model chrome, a re-framed camera,
    // the blocks back a moment later). The stage keeps drawing the last picture over the same mesh meanwhile; the report does not:
    // it shows its skeleton, not the other version's verdict (see stageHold.ts).
    const stage = useHeldStage({
        own: snapshot.viewResult,
        preview: snapshot.previewResult,
        url: displayUrl,
        family: family ? (family.root?.id ?? family.active.id) : activeModelId,
        waiting: snapshot.phase === "loading" || snapshot.phase === "running",
    });
    const analysisView = useAnalysisStore((s) => s.view);
    // The last pick raised the layer cut to keep its blocks in view: the stage says so (its cut note).
    const layerRaised = useAnalysisStore((s) => s.layerRaised);
    const analysisPanelOpen = useAnalysisStore((s) => s.panelOpen);
    const previewOwner = useAnalysisStore((s) => s.preview?.owner ?? null);
    const analysisOn = tab === "analysis";
    // The Optimization tab shows the same stage: the blocks over the model, with a panel of its own beside them.
    const optimizeOn = tab === "optimize";
    const blocksOn = isBlockTab(tab);
    // The store settles the user's colouring against the result it has, which is the other version's while a picture is held (it has
    // no added blocks, say): the held picture is coloured as asked instead (the viewer still falls back where it cannot be drawn).
    const colorChoice = useAnalysisStore((s) => s.colorChoice);
    const viewerAnalysisView = useMemo<AnalysisViewState>(
        () => ({ ...analysisView, colorBy: stageColorBy(analysisView.colorBy, colorChoice, stage.holding), mode: blocksOn ? "blocks" : "model" }),
        [analysisView, blocksOn, colorChoice, stage.holding],
    );
    const handleModelReady = useCallback((loaded: LoadedModel | null) => {
        useAnalysisStore.getState().setLoaded(loaded);
    }, []);
    // The viewer hands over a model once and never takes it back, but its scene is gone as soon as another model
    // is shown: a handle for any other url is stale (its triangles read as empty), and a pick made on the last
    // model's result no longer means anything.
    useEffect(() => {
        useAnalysisStore.getState().modelChanged(activeModelId, displayUrl);
    }, [displayUrl, activeModelId]);
    // Leaving the workspace disposes the viewer with its scene; its handle must not outlive it.
    useEffect(() => () => useAnalysisStore.getState().setLoaded(null), []);
    // "A" flips between the 3D view and the Stability tab, "O" between the 3D view and the Optimization tab, "V" between the original and the
    // version you are working on, "[" and "]" walk the versions, like the viewer's own letter keys: only while the 3D view has focus (the
    // version control handles V, [ and ] itself), never as a bare key anywhere on the page (a single-letter shortcut that cannot be
    // switched off). The tab was called Analysis; the key stays "A".
    const handleViewerKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
        const keyEvent = versionKeyEvent(e);
        if (handleVersionKey(keyEvent)) return;
        if (isOptimizeKey(keyEvent)) {
            if (inTypingContext(e.target)) return;
            e.preventDefault();
            const workspace = useWorkspaceStore.getState();
            workspace.setWorkspaceTab(workspace.workspaceTab === "optimize" ? "3d" : "optimize");
            return;
        }
        if (e.key.toLowerCase() !== "a" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.nativeEvent.isComposing) return;
        if (inTypingContext(e.target)) return;
        e.preventDefault();
        const workspace = useWorkspaceStore.getState();
        if (workspace.workspaceTab === "analysis") {
            workspace.setWorkspaceTab("3d");
            return;
        }
        // On a phone this lands on the peek card; the full report is one tap on it.
        workspace.setWorkspaceTab("analysis");
    }, []);
    // The stage owns the view controls (its Colour menu, the Layers popover, the Show menu): they report here and the store decides
    // what each may be (a colour mode that cannot be drawn is refused). Switching versions is not one of them: only the bar does that.
    const handleViewChange = useCallback((patch: ViewPatch) => applyViewPatch(patch, useAnalysisStore.getState()), []);
    const handleBlockHover = useCallback((index: number | null) => useAnalysisStore.getState().hoverBlock(index), []);
    const handleBlockClick = useCallback((index: number | null) => useAnalysisStore.getState().clickBlock(index), []);
    // The viewer stops reporting hovers once the blocks leave the stage: a card must not stay lit.
    useEffect(() => {
        if (!blocksOn) useAnalysisStore.getState().hoverBlock(null);
    }, [blocksOn]);

    // ---- generation overlay: only while the first model is on its way and nothing is shown ----
    const running = useMemo(() => {
        const open = Object.values(jobs).filter((job) => job.project_id === activeProjectId && !isTerminalJob(job));
        // The newest prompt's models first, so the card follows the run the user just started.
        const group = latestJobIds(messages);
        return [...open].sort((a, b) => Number(group.includes(b.id)) - Number(group.includes(a.id)));
    }, [jobs, messages, activeProjectId]);
    const showOverlay = !activeModel && running.length > 0;

    // ---- thumbnail: the viewer's capture becomes the project's card image ----
    const thumbnailed = useRef(new Set<string>());
    /** Projects whose cover is being uploaded, so two models shown in a row do not race. */
    const uploading = useRef(new Set<string>());
    const viewerModel = useRef<ModelAsset | null>(null);
    viewerModel.current = activeModel;
    const handleThumbnail = useCallback((blob: Blob) => {
        const model = viewerModel.current;
        const state = useWorkspaceStore.getState();
        const projectId = model?.project_id;
        if (!model || !projectId || projectId !== state.activeProjectId) return;
        if (thumbnailed.current.has(model.id) || uploading.current.has(projectId)) return;
        // The first model a project shows gives it a card image. After that only the newest model of
        // a run this page watched finish replaces it: the cover is shared by every visitor, so merely
        // opening a project (or browsing its old models) must not repaint it with this browser's capture.
        if (state.project?.thumbnail_url) {
            const newest = state.models[state.models.length - 1]?.id === model.id;
            if (!newest || !completedThisSession(model.id)) return;
        }
        thumbnailed.current.add(model.id);
        uploading.current.add(projectId);
        putThumbnail(projectId, blob)
            .then((url) => {
                // For the project it was captured in, not whichever is open by the time the reply lands.
                useWorkspaceStore.getState().updateProjectMeta({ thumbnail_url: url }, projectId);
            })
            // A failed upload may be tried again the next time this model is shown.
            .catch(() => thumbnailed.current.delete(model.id))
            .finally(() => uploading.current.delete(projectId));
    }, []);

    const handleLoadError = useCallback((message: string) => {
        // The mesh behind a version could not be loaded: the version still can, so it is shown as its own blocks
        // (the stage, the analysis and the buttons all follow the same file) and the original stays one click away.
        const sourceId = sourceOnStage.current;
        if (sourceId) {
            markMeshFailed(sourceId);
            toast.error("The original model could not be displayed", { id: "viewer-load-error", description: `Showing this version's blocks instead. ${message}` });
            return;
        }
        toast.error("This model could not be displayed", { id: "viewer-load-error", description: message });
        // The report says so too, instead of waiting for geometry that will not come.
        const url = viewerUrl.current;
        if (url) useAnalysisStore.getState().modelFailed(url, message);
    }, []);

    // ---- title and options ----
    const [renaming, setRenaming] = useState(false);
    /** The Rename item closes the menu, and the menu's focus trap holds focus until it is gone, so
     *  the name field cannot take focus yet; the field opens once the menu has let go (and the
     *  menu is told not to hand focus back to its trigger, which would blur the field). */
    const renameFromMenu = useRef(false);
    const showFiling = !mobile && Boolean(project && activeProjectId);

    const commitName = (next: string) => {
        setRenaming(false);
        const name = next.trim();
        if (!project || !activeProjectId || !name || name === project.name) return;
        const previous = project.name;
        // Tied to this project: a slow reply must not rename (or re-time) whichever one is open by then.
        const id = activeProjectId;
        const update = (meta: Partial<HubProject>) => useWorkspaceStore.getState().updateProjectMeta(meta, id);
        update({ name });
        renameProjectRow(activeProjectId, name)
            .then((modifiedAt) => modifiedAt && update({ modified_at: modifiedAt }))
            .catch((err: unknown) => {
                update({ name: previous });
                toast.error("Could not rename the project", { description: err instanceof Error ? err.message : undefined });
            });
    };

    const togglePinned = () => {
        if (!project || !activeProjectId) return;
        const next = !project.pinned;
        const id = activeProjectId;
        const update = (meta: Partial<HubProject>) => useWorkspaceStore.getState().updateProjectMeta(meta, id);
        update({ pinned: next });
        setProjectPinned(activeProjectId, next).catch((err: unknown) => {
            update({ pinned: !next });
            toast.error("Could not update the pin", { description: err instanceof Error ? err.message : undefined });
        });
    };

    const moveToTrash = async () => {
        if (!project || !activeProjectId) return;
        const id = activeProjectId;
        const name = project.name;
        try {
            // Any edit still waiting for its save goes out before the project leaves the workspace.
            await saveNow();
            // A save that was already on its way when the button was pressed finishes first.
            await whenSaved(id);
            await trashProjects([id]);
        } catch (err) {
            toast.error("Could not move the project to the bin", {
                description: err instanceof Error ? err.message : undefined,
            });
            return;
        }
        toast.success(`"${name}" moved to the bin`, {
            description: "It is deleted for good after 7 days.",
            action: {
                label: "Undo",
                onClick: () => {
                    restoreProjects([id])
                        .then(() => {
                            toast.success("Project restored");
                            // The hub is on screen by now: tell it to re-read.
                            notifyHubChanged();
                        })
                        .catch(() => toast.error("Could not restore the project"));
                },
            },
        });
        // In the bin from here on (and the "still generating" note on the way out does not apply).
        useWorkspaceStore.getState().updateProjectMeta({ deleted_at: new Date().toISOString() }, id);
        onOpenProjects();
    };

    // The Models tab's View: the same switch as the bar's, landing on the 3D tab.
    const viewModel = (model: ModelAsset) => openVersion(model, { tab: "3d" });

    // ---- layout ----
    const tabStripFade = useEdgeFade();
    const activeTabRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        // The strip scrolls sideways when narrow: keep the open tab in view.
        activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }, [tab]);

    // The bar keeps extra breathing room from the chat panel and the window edges.
    const barStyle = { marginLeft: side.left + 16, marginRight: side.right + 16 };
    const contentStyle = mobile ? { marginLeft: 12, marginRight: 12 } : { marginLeft: side.left, marginRight: side.right };

    // The report floats over the viewer, so the viewer frames the model in what it leaves free: beside the
    // desktop panel, under the folded pill, or under the phone's pill (the sheet is an overlay).
    const freeWidth = Math.max(0, width - insets.left - insets.right);
    // The version switcher sits in the bar's tab card, in the room the tab strip leaves free. On a phone, and in a window too narrow
    // for that, it has a row of its own under the bar. The row is kept (empty) while the first analysis may still bring a switcher,
    // so the model is not re-framed when the verdict lands.
    const { inRow: switcherInRow, rowKept: switcherRowKept, rowPx: switcherRowPx, compact: switcherCompact } = switcherLayout({
        mobile: Boolean(mobile),
        freeWidth,
        mode: switcher.mode,
        pending: switcher.pending,
    });
    // Phone: the peek card sits at the bottom of the stage (below), and the stage's toolbar must sit above it. Its height is measured
    // (it changes with the state of the check) and kept while the full report covers it.
    const [peekPx, setPeekPx] = useState(ANALYSIS_PEEK_CARD_PX + PHONE_PEEK_MARGIN_PX);
    const sheetOpen = useAnalysisStore((s) => s.sheetOpen);
    const viewerInsets = useMemo(
        () =>
            viewerInsetsFor({
                insets,
                analysisOn: blocksOn,
                mobile: Boolean(mobile),
                switcherRowPx,
                // The report folds into a pill; the optimizer's panel stays beside the model.
                panelOpen: optimizeOn ? true : analysisPanelOpen,
                freeWidth,
                dockInsetPx: ANALYSIS_DOCK_INSET_PX,
                peekPx,
            }),
        [blocksOn, optimizeOn, mobile, switcherRowPx, analysisPanelOpen, insets, freeWidth, peekPx],
    );
    // Opening the Stability tab in a window too narrow to show the report beside the model starts it folded
    // into its pill (the user can still open it, over the stage).
    const dockRoom = useRef(true);
    dockRoom.current = dockFits(freeWidth, ANALYSIS_DOCK_INSET_PX);
    useEffect(() => {
        if (analysisOn && !mobile && !dockRoom.current) useAnalysisStore.getState().setPanelOpen(false);
    }, [analysisOn, mobile]);

    const selectTab = (id: WorkspaceTab) => {
        const workspace = useWorkspaceStore.getState();
        // On a phone the tab lands on the peek card; tapping the open tab again opens the full report (a sheet), and again folds it.
        const analysis = useAnalysisStore.getState();
        const sheet = sheetOnTabTap({ mobile: Boolean(mobile), tapped: id, current: workspace.workspaceTab, sheetOpen: analysis.sheetOpen });
        if (sheet !== null) analysis.setSheetOpen(sheet);
        workspace.setWorkspaceTab(id);
    };

    const emptyState = chatStarted ? (
        // A small card: bare muted text would sink into the viewer's grey stage.
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-background/85 px-6 py-4 text-center text-muted-foreground shadow-lg backdrop-blur">
            <Boxes className="h-7 w-7 opacity-60" strokeWidth={1.5} aria-hidden />
            <p className="text-sm">Your model will appear here</p>
        </div>
    ) : (
        // A new chat shows the hero over the empty stage instead.
        <></>
    );

    return (
        <div className="relative h-full w-full">
            {/* The viewer IS the window background; the panels float on top. `isolate` keeps its
                own z-indexed controls below the bar. */}
            <div className="absolute inset-0 isolate bg-canvas">
                {/* Hidden (not unmounted) on the Models tab, so its controls do not peek out around
                    the list's box and coming back costs no reload. */}
                <div className={cn("absolute inset-0", tab === "models" && "invisible")} onKeyDown={handleViewerKeyDown}>
                    <Suspense fallback={null}>
                        <GlbViewer
                            url={displayUrl}
                            title={stageTitle}
                            downloadName={stageDownloadName}
                            downloadUrl={activeModel?.glb_url ?? null}
                            // The 3D tab is the model as it was made (or as the person changed it with words): the blocks the stabilizer
                            // and the optimizer added are shown on the Stability and Optimization tabs only.
                            supports={null}
                            stepOffset={stepOffset}
                            stepAssembly={stepAssembly}
                            downloadLabel={downloadLabel}
                            insets={viewerInsets}
                            overlay={
                                showOverlay ? <GenerationOverlay jobs={running} providers={providers} /> : null
                            }
                            emptyState={emptyState}
                            onThumbnail={handleThumbnail}
                            onLoadError={handleLoadError}
                            onModelReady={handleModelReady}
                            analysis={stage.analysis}
                            analysisView={viewerAnalysisView}
                            previewResult={snapshot.previewResult}
                            previewLabel={previewLabelOf(previewOwner)}
                            onViewChange={handleViewChange}
                            layerRaised={layerRaised}
                            analysisBusy={snapshot.phase === "running"}
                            // The blocks on stage are the last version's while it is held: not the report's, so a hover or a click means nothing yet.
                            onBlockHover={stage.holding ? undefined : handleBlockHover}
                            onBlockClick={stage.holding ? undefined : handleBlockClick}
                        />
                    </Suspense>
                </div>
                {/* A new chat shows the hero on the plain canvas colour, as Cably does; the viewer's own
                    stage (a mid-grey in dark mode) fades in when the conversation starts. */}
                <div
                    aria-hidden
                    className={cn(
                        "pointer-events-none absolute inset-0 z-20 bg-canvas transition-opacity duration-[420ms] motion-reduce:transition-none",
                        chatStarted ? "opacity-0" : "opacity-100",
                    )}
                />
            </div>

            <div className="pointer-events-none relative z-10 flex h-full flex-col">
                {/* The bar never scrolls: the tab strip inside it does, so the right-hand controls
                    (save state, Show chat, settings) are always on screen. */}
                <div ref={barRef} className="pointer-events-auto mt-3 flex min-w-0 items-center gap-2" style={barStyle}>
                    {!mobile && (
                        <div className="shrink-0 overflow-hidden rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur">
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-[34px] gap-1.5 rounded-2xl px-3 text-xs"
                                onClick={onOpenProjects}
                                title="Home"
                                aria-label="Home"
                            >
                                <Home className="h-4 w-4" />
                                Home
                            </Button>
                        </div>
                    )}

                    {showFiling && project && (
                        // On a card of its own (Cably sets the title straight on its dark canvas): the
                        // viewer's stage is a mid-grey in dark mode, where bare text would sink.
                        <div
                            data-testid="project-filing"
                            className="flex h-[34px] min-w-0 items-center gap-0.5 rounded-2xl border border-border/70 bg-sidebar/95 pl-3 pr-1 shadow-lg backdrop-blur"
                        >
                            <InlineName
                                value={project.name}
                                editing={renaming}
                                onStart={() => setRenaming(true)}
                                onCommit={commitName}
                                onCancel={() => setRenaming(false)}
                                className="min-w-0 max-w-[24rem] truncate text-sm font-medium text-foreground"
                                settleKey={activeProjectId ?? "new-chat"}
                            />
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 shrink-0"
                                        aria-label="Project options"
                                        data-testid="project-options"
                                    >
                                        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="start"
                                    className="w-52"
                                    onCloseAutoFocus={(e) => {
                                        if (!renameFromMenu.current) return;
                                        renameFromMenu.current = false;
                                        e.preventDefault();
                                        setRenaming(true);
                                    }}
                                >
                                    <DropdownMenuItem
                                        className="gap-2 text-xs"
                                        onSelect={() => {
                                            renameFromMenu.current = true;
                                        }}
                                    >
                                        <Pencil className="h-3.5 w-3.5" /> Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="gap-2 text-xs" onSelect={togglePinned}>
                                        {project.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                                        {project.pinned ? "Unpin" : "Pin to top"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="gap-2 text-xs" onSelect={() => void moveToTrash()}>
                                        <Trash2 className="h-3.5 w-3.5" /> Move to bin
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="gap-2 text-xs" onSelect={onOpenProjects}>
                                        <Home className="h-3.5 w-3.5" /> All projects
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}

                    <div className="flex min-w-min flex-1 items-center overflow-hidden rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur">
                        {/* The tabs scroll sideways with no bar line: a clipped end fades instead. */}
                        <div
                            ref={tabStripFade}
                            data-testid="workspace-tab-strip"
                            className={`flex ${mobile ? "min-w-0 flex-1" : "min-w-[6rem]"} items-center overflow-x-auto ${HIDDEN_BAR}`}
                        >
                            {mobile && (
                                <>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="mx-1 h-7 w-7 shrink-0"
                                        onClick={onOpenProjects}
                                        title="Home"
                                        aria-label="Home"
                                    >
                                        <Home className="h-4 w-4" />
                                    </Button>
                                    <div className="w-px h-5 bg-border shrink-0" />
                                </>
                            )}
                            {TABS.map(({ id, label, icon: Icon }) => (
                                <button
                                    key={id}
                                    type="button"
                                    ref={tab === id ? activeTabRef : undefined}
                                    onClick={() => selectTab(id)}
                                    title={
                                        id === "analysis"
                                            ? `${label} (A while the 3D view has focus)`
                                            : id === "optimize"
                                              ? `${label} (O while the 3D view has focus)`
                                              : mobile
                                                ? label
                                                : undefined
                                    }
                                    aria-label={id === "analysis" ? stabilityTabLabel(snapshot) : mobile ? label : undefined}
                                    data-testid={`tab-${id}`}
                                    aria-pressed={tab === id}
                                    className={`flex items-center ${mobile ? "gap-1.5 px-2.5" : "gap-1 px-3"} py-2 text-xs border-b-2 transition-colors whitespace-nowrap ${
                                        tab === id
                                            ? "border-primary bg-background text-foreground"
                                            : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                                    }`}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {/* Icons only on phones: labelled tabs would crowd the bar. */}
                                    {!mobile && label}
                                    {id === "analysis" && <StabilityTabStatus snapshot={snapshot} />}
                                    {id === "optimize" && <OptimizeTabStatus />}
                                    {id === "models" && models.length > 0 && !mobile && (
                                        <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                                            {models.length}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                        {/* The room between the tabs and the save state: the version switcher fills it on the 3D and the Stability tab, so
                            neither the tabs nor the controls on the right move when it comes and goes. */}
                        <div className="flex flex-1 items-center">
                            {/* The work in progress is told here on every tab, beside the control (in its row when the bar has no room). */}
                            {!switcherInRow && <RunChip className="ml-2" />}
                            {!switcherInRow && <VersionSwitcher state={switcher} compact={switcherCompact} embedded className="mx-2" />}
                        </div>

                        {/* The save text overflows the icon-packed phone bar (which fits 375px
                            exactly): autosave still runs there, it is just not narrated. */}
                        {!mobile && saveStatus === "error" && (
                            <button
                                type="button"
                                className="text-[10px] font-medium text-destructive mr-2 shrink-0 whitespace-nowrap hover:underline"
                                title="The last save failed. Click to try again."
                                onClick={() => void saveNow()}
                            >
                                Not saved
                            </button>
                        )}
                        {!mobile && (saveStatus === "saving" || saveStatus === "saved") && (
                            <span className="text-[10px] text-muted-foreground mr-2 shrink-0 whitespace-nowrap">
                                {saveStatus === "saving" ? "Saving…" : "✓ Saved"}
                            </span>
                        )}

                        {/* The way back from a hidden chat: it lives in the bar because, with the
                            chat gone, the bar spans the whole window. */}
                        {!mobile && onShowChat && (
                            <Button
                                data-testid="show-chat"
                                variant="ghost"
                                size="icon"
                                className="mr-2 h-7 w-7 shrink-0"
                                onClick={onShowChat}
                                title="Show chat (⌘\)"
                                aria-label="Show chat"
                            >
                                <PanelRightOpen className="h-4 w-4" />
                            </Button>
                        )}
                        <SettingsMenu className="mr-2 shrink-0" />
                        {mobile && (
                            <>
                                <div className="w-px h-5 bg-border shrink-0" />
                                <button
                                    type="button"
                                    onClick={mobile.onShowChat}
                                    className="mx-1 flex h-7 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors shrink-0"
                                    title="Back to chat"
                                >
                                    <MessageSquare className="h-4 w-4" />
                                    Chat
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {!mobile && switcherRowKept && (
                    // A window too narrow for the switcher in the bar: its row under the bar (kept empty while it may still appear).
                    <div className="mt-2 flex min-h-9 items-center gap-2" style={barStyle}>
                        <VersionSwitcher state={switcher} compact />
                        <RunChip />
                    </div>
                )}
                {!mobile && !switcherRowKept && switcherInRow && (
                    // A narrow window with no control to show: the chip still has a place, so a run is never invisible.
                    <div className="mt-2 flex items-center" style={barStyle}>
                        <RunChip />
                    </div>
                )}

                {analysisOn && !mobile && (
                    // Under the bar, at the left edge of the free area: the viewer's insets leave this strip alone.
                    <div className="min-h-0 flex-1 py-3" style={{ marginLeft: side.left + 12, marginRight: side.right }}>
                        <AnalysisDock model={activeModel} snapshot={snapshot} />
                    </div>
                )}

                {optimizeOn && !mobile && (
                    // The optimizer's panel under the bar, at the left edge of the free area, like the report's.
                    <div className="min-h-0 flex-1 py-3" style={{ marginLeft: side.left + 12, marginRight: side.right }}>
                        <div className="pointer-events-auto h-full max-h-full" style={{ width: ANALYSIS_PANEL_PX }} data-testid="optimize-dock">
                            <Suspense fallback={null}>
                                <OptimizePanel />
                            </Suspense>
                        </div>
                    </div>
                )}

                {mobile && (switcherRowKept || analysisOn || somethingRuns) && (
                    // On a phone the row holds the switcher and the issue being shown (tap x to clear it). The row keeps its height
                    // (a 32 px chip under 8 px of air) with nothing picked, so the stage does not move when a pick comes and goes. With
                    // neither (a model with no versions, on the 3D tab) it exists only while something runs, for the run chip.
                    <div className={cn("mt-2 flex items-center gap-2", switcherRowKept && "min-h-10", analysisOn && !switcherRowKept && "min-h-8")} style={contentStyle}>
                        <VersionSwitcher state={switcher} row />
                        <RunChip compact />
                        {analysisOn && (
                            <div className="min-w-0 flex-1">
                                <SelectionPeek />
                            </div>
                        )}
                    </div>
                )}

                {tab === "models" && (
                    <div className="min-h-0 flex-1 py-3" style={contentStyle}>
                        <div className="pointer-events-auto h-full overflow-hidden rounded-2xl border border-border/70 bg-background shadow-lg">
                            <ModelsPanel
                                models={models}
                                activeModelId={activeModelId}
                                providers={providers}
                                onView={viewModel}
                                onEdit={editVersion}
                                onDelete={deleteVersion}
                            />
                        </div>
                    </div>
                )}
            </div>

            {mobile && analysisOn && !sheetOpen && (
                // The peek card is the Stability tab at rest: the answer, four figures and the one action, over the foot of the stage.
                // It is gone while the full report covers it (one copy of the buttons, one live region), and its room is kept.
                <PhonePeekDock onHeight={setPeekPx}>
                    <AnalysisPeekCard model={activeModel} snapshot={snapshot} />
                </PhonePeekDock>
            )}
            {mobile && analysisOn && <AnalysisSheet model={activeModel} snapshot={snapshot} />}
            {mobile && optimizeOn && (
                // The optimizer at rest on a phone: its panel docked at the foot of the stage, in the room the viewer leaves for it.
                <PhonePeekDock onHeight={setPeekPx}>
                    <div className="max-h-[60dvh] overflow-y-auto rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur" data-testid="optimize-peek">
                        <Suspense fallback={null}>
                            <OptimizePanel />
                        </Suspense>
                    </div>
                </PhonePeekDock>
            )}
        </div>
    );
}
