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
    Trash2,
} from "lucide-react";

import { AnalysisDock, AnalysisPeek, AnalysisSheet, ANALYSIS_PEEK_PX } from "@/assignment/components/analysis/AnalysisDock";
import { ANALYSIS_DOCK_INSET_PX } from "@/assignment/components/analysis/AnalysisPanel";
import { useAnalysisSnapshot, type AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { useAnalysisRunner } from "@/assignment/components/analysis/useAnalysisRunner";
import { GenerationOverlay } from "@/assignment/components/workspace/GenerationOverlay";
import { InlineName } from "@/assignment/components/hub/InlineName";
import { ModelsPanel } from "@/assignment/components/workspace/ModelsPanel";
import { modelFileName, modelTitle } from "@/assignment/components/workspace/format";
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
import type { AnalysisViewState, CompareMode, LoadedModel } from "@/assignment/analysis/types";
import type { HubProject, ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { dockFits, dockInset } from "@/assignment/store/analysisLogic";
import { completedThisSession, isTerminalJob, latestJobIds } from "@/assignment/store/jobs";
import { deleteStabilized } from "@/assignment/store/models";
import { saveNow, whenSaved } from "@/assignment/store/persist";
import { useWorkspaceStore, type WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

// three.js is imported by the viewer on first use; lazy here keeps even its React shell out of the
// first paint of the page.
const GlbViewer = lazy(() => import("@/assignment/viewer/GlbViewer"));

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
    { id: "analysis", label: "Analysis", icon: Blocks },
    { id: "models", label: "Models", icon: Layers },
];

/**
 * The Analysis tab's status next to its name: a spinner while it runs, a tick when the design passes, a count
 * of problems or warnings otherwise. Symbols and numbers, so it never relies on colour alone.
 */
function AnalysisTabStatus({ snapshot }: { snapshot: AnalysisSnapshot }) {
    const { phase, verdict } = snapshot;
    if (phase === "running") return <Loader2 className="ml-0.5 h-3 w-3 animate-spin text-muted-foreground" aria-hidden />;
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

/** "Analysis, 3 problems" for the tab's accessible name. */
function analysisTabLabel(snapshot: AnalysisSnapshot): string {
    if (snapshot.phase === "running") return "Analysis, running";
    return snapshot.verdict ? `Analysis, ${snapshot.verdict.short.toLowerCase()}` : "Analysis";
}

/**
 * The workspace behind the panels: the 3D viewer filling the window, the floating top bar over it
 * (Home, the project's name and menu, the tab strip, save state, settings) and, on the Models tab,
 * the list of generated models in a box under the bar.
 */
export function WorkspaceShell({ onOpenProjects, onShowChat, mobile, chatStarted }: WorkspaceShellProps) {
    const barRef = useRef<HTMLDivElement>(null);
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
    // A stabilized model names and downloads as its own version, and links back to the model it was made from (when that is in the project).
    const stageTitle = activeModel ? modelTitle(activeModel) : undefined;
    const stageDownloadName = activeModel ? modelFileName(activeModel).replace(/\.glb$/i, "") : undefined;
    const sourceId = activeModel?.kind === "stabilized" ? activeModel.source_model_id : null;
    const sourcePrompt = sourceId ? (models.find((m) => m.id === sourceId)?.prompt ?? null) : null;
    const derivedFrom = useMemo(
        () => (sourceId && sourcePrompt !== null ? { title: sourcePrompt, onOpen: () => useWorkspaceStore.getState().setActiveModel(sourceId) } : null),
        [sourceId, sourcePrompt],
    );

    // ---- analysis: runs on its own once the model's GLB is in the viewer ----
    useAnalysisRunner(activeModel);
    const snapshot = useAnalysisSnapshot(activeModel);
    const analysisView = useAnalysisStore((s) => s.view);
    const originalState = useAnalysisStore((s) => s.originalState);
    const analysisPanelOpen = useAnalysisStore((s) => s.panelOpen);
    const analysisOn = tab === "analysis";
    const viewerAnalysisView = useMemo<AnalysisViewState>(
        () => ({ ...analysisView, mode: analysisOn ? "blocks" : "model" }),
        [analysisView, analysisOn],
    );
    const handleModelReady = useCallback((loaded: LoadedModel | null) => {
        useAnalysisStore.getState().setLoaded(loaded);
    }, []);
    // The viewer hands over a model once and never takes it back, but its scene is gone as soon as another model
    // is shown: a handle for any other url is stale (its triangles read as empty), and a pick made on the last
    // model's result no longer means anything.
    const activeGlbUrl = activeModel?.glb_url ?? null;
    useEffect(() => {
        useAnalysisStore.getState().modelChanged(activeModelId, activeGlbUrl);
    }, [activeGlbUrl, activeModelId]);
    // Leaving the workspace disposes the viewer with its scene; its handle must not outlive it.
    useEffect(() => () => useAnalysisStore.getState().setLoaded(null), []);
    // "A" flips between the 3D view and the report, like the viewer's own letter keys: only while the 3D view has
    // focus, never as a bare key anywhere on the page (a single-letter shortcut that cannot be switched off).
    const handleViewerKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key.toLowerCase() !== "a" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.nativeEvent.isComposing) return;
        if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'], [role='listbox']")) return;
        e.preventDefault();
        const workspace = useWorkspaceStore.getState();
        if (workspace.workspaceTab === "analysis") {
            workspace.setWorkspaceTab("3d");
            return;
        }
        workspace.setWorkspaceTab("analysis");
        useAnalysisStore.getState().setSheetOpen(true);
    }, []);
    // The viewer's Original | Stabilized | Overlay chip: the store decides which result the stage draws (and computes the original half).
    const handleCompareChange = useCallback((mode: CompareMode) => useAnalysisStore.getState().setCompare(mode), []);
    const handleBlockHover = useCallback((index: number | null) => useAnalysisStore.getState().hoverBlock(index), []);
    const handleBlockClick = useCallback((index: number | null) => useAnalysisStore.getState().clickBlock(index), []);
    // The viewer stops reporting hovers once the blocks leave the stage: a card must not stay lit.
    useEffect(() => {
        if (!analysisOn) useAnalysisStore.getState().hoverBlock(null);
    }, [analysisOn]);

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
        toast.error("This model could not be displayed", { id: "viewer-load-error", description: message });
        // The report says so too, instead of waiting for geometry that will not come.
        const url = viewerModel.current?.glb_url;
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

    const viewModel = (model: ModelAsset) => {
        const state = useWorkspaceStore.getState();
        state.setActiveModel(model.id);
        state.setWorkspaceTab("3d");
    };

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
    const viewerInsets = useMemo(() => {
        if (!analysisOn) return insets;
        if (mobile) return { ...insets, top: insets.top + ANALYSIS_PEEK_PX };
        // In a narrow window the panel overlaps the model rather than squeezing it to a sliver.
        return analysisPanelOpen
            ? { ...insets, left: insets.left + dockInset(freeWidth, ANALYSIS_DOCK_INSET_PX) }
            : { ...insets, top: insets.top + ANALYSIS_PEEK_PX + 4 };
    }, [analysisOn, mobile, analysisPanelOpen, insets, freeWidth]);
    // Opening the Analysis tab in a window too narrow to show the report beside the model starts it folded
    // into its pill (the user can still open it, over the stage).
    const dockRoom = useRef(true);
    dockRoom.current = dockFits(freeWidth, ANALYSIS_DOCK_INSET_PX);
    useEffect(() => {
        if (analysisOn && !mobile && !dockRoom.current) useAnalysisStore.getState().setPanelOpen(false);
    }, [analysisOn, mobile]);

    const selectTab = (id: WorkspaceTab) => {
        const workspace = useWorkspaceStore.getState();
        if (id === "analysis" && mobile) {
            // On a phone the report is a sheet: the tab opens it, and tapping the open tab again toggles it.
            const analysis = useAnalysisStore.getState();
            analysis.setSheetOpen(workspace.workspaceTab === "analysis" ? !analysis.sheetOpen : true);
        }
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
                            url={activeModel?.glb_url ?? null}
                            title={stageTitle}
                            downloadName={stageDownloadName}
                            derivedFrom={derivedFrom}
                            compareStatus={originalState}
                            insets={viewerInsets}
                            overlay={showOverlay ? <GenerationOverlay jobs={running} providers={providers} /> : null}
                            emptyState={emptyState}
                            onThumbnail={handleThumbnail}
                            onLoadError={handleLoadError}
                            onModelReady={handleModelReady}
                            analysis={snapshot.viewResult}
                            analysisView={viewerAnalysisView}
                            previewResult={snapshot.previewResult}
                            onCompareChange={handleCompareChange}
                            analysisBusy={snapshot.phase === "running"}
                            onBlockHover={handleBlockHover}
                            onBlockClick={handleBlockClick}
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
                                    title={id === "analysis" ? "Analysis (A while the 3D view has focus)" : mobile ? label : undefined}
                                    aria-label={id === "analysis" ? analysisTabLabel(snapshot) : mobile ? label : undefined}
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
                                    {id === "analysis" && <AnalysisTabStatus snapshot={snapshot} />}
                                    {id === "models" && models.length > 0 && !mobile && (
                                        <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                                            {models.length}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="flex-1" />

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

                {analysisOn && !mobile && (
                    // Under the bar, at the left edge of the free area: the viewer's insets leave this strip alone.
                    <div className="min-h-0 flex-1 py-3" style={{ marginLeft: side.left + 12, marginRight: side.right }}>
                        <AnalysisDock model={activeModel} snapshot={snapshot} />
                    </div>
                )}

                {analysisOn && mobile && (
                    <div className="mt-2" style={contentStyle}>
                        <AnalysisPeek snapshot={snapshot} />
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
                                onDelete={deleteStabilized}
                            />
                        </div>
                    </div>
                )}
            </div>

            {mobile && analysisOn && <AnalysisSheet model={activeModel} snapshot={snapshot} />}
        </div>
    );
}
