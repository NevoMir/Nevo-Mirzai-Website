import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { ImperativePanelHandle } from "react-resizable-panels";

import { ChatPanel } from "@/assignment/components/chat/ChatPanel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/assignment/components/ui/resizable";
import { WorkspaceShell } from "@/assignment/components/workspace/WorkspaceShell";
import { useMobileLayout } from "@/assignment/hooks/use-mobile";
import { CHAT_MAX_PCT, useChatSizes } from "@/assignment/hooks/useChatSizes";
import { useProjectRoute } from "@/assignment/hooks/useProjectRoute";
import { HUB_PATH, isProjectId } from "@/assignment/lib/projectPath";
import { requestAccessCode, settleAccessPrompt } from "@/assignment/store/access";
import { noteRunLeftBehind, startNewProject, stopGeneration } from "@/assignment/store/generation";
import { useJobPolling } from "@/assignment/store/jobs";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { useAutosave } from "@/assignment/store/persist";
import { refreshProviders } from "@/assignment/store/providers";
import { selectIsGenerating, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/**
 * Shortcuts stay out of dialogs, menus and text fields other than the prompt box: a chord typed
 * into a rename or the access-code field must not throw that work away.
 */
function shortcutBlocked(target: EventTarget | null): boolean {
    if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true;
    if (!(target instanceof Element)) return false;
    if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return true;
    if (target instanceof HTMLTextAreaElement) return target.getAttribute("aria-label") !== "Prompt";
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return true;
    return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * The app page, /app/new and /app/<id>: the 3D viewer fills the window and two floating rounded
 * panels sit on it, the top bar (inside WorkspaceShell) and the chat panel on the right. A new chat
 * has no panel: the hero (brand, question, example prompts) and the composer are portalled onto the
 * empty canvas, and the first message slides the panel in around the same composer.
 */
export default function Workspace() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    // The hub's "New project" on a tag page lands here with ?tag=<id> so the project is filed there.
    const tagParam = searchParams.get("tag");
    const tagId = tagParam && isProjectId(tagParam) ? tagParam : null;

    // /app/<id> <-> the open project: reload, deep links, Back/Forward, and the first send's new id.
    const { projectId: routeProjectId, opening } = useProjectRoute();
    useAutosave();
    useJobPolling();
    useEffect(() => {
        void refreshProviders();
    }, []);

    const isMobile = useMobileLayout();
    const chatSizes = useChatSizes();
    const goToHub = () => {
        noteRunLeftBehind();
        navigate(HUB_PATH);
    };
    // Leaving the page with the access-code dialog open: the send waiting on it gives up.
    useEffect(() => () => settleAccessPrompt(false), []);

    // Hiding the chat shoves the panel out of the way so the viewer fills the window. Set from the
    // chat header's own button, cleared from the top bar's "Show chat", and never outlives the
    // conversation it was set on (see the effect below).
    const chatHidden = useWorkspaceStore((s) => s.chatHidden);
    const setChatHidden = useWorkspaceStore((s) => s.setChatHidden);
    const projectName = useWorkspaceStore((s) => s.project?.name);

    // "The conversation has started" = there is a message. Not activeProjectId: the first message
    // is appended synchronously on send, so this flips in the same tick. A project from the URL that
    // is still being fetched counts as started too, so the panel opens around its spinner instead of
    // flashing the new-chat hero for a frame.
    const hasMessages = useWorkspaceStore((s) => s.messages.length > 0);
    const chatStarted = hasMessages || opening;
    const chatPanelOpen = chatStarted && !chatHidden;
    const showChatOwed = chatStarted && chatHidden;

    // Nothing to hide (a new chat, where the hero owns the middle): neither button is drawn, so the
    // flag must not be carried through it, or the next conversation's panel would stay folded away.
    useEffect(() => {
        if (!chatStarted && chatHidden) setChatHidden(false);
    }, [chatStarted, chatHidden, setChatHidden]);

    // Where the hero + composer paint: an absolute box inside the canvas spacer, handed to ChatPanel
    // through state (a callback ref) so it exists by the time the panel renders.
    const [heroSlot, setHeroSlot] = useState<HTMLDivElement | null>(null);
    const chatPanelRef = useRef<ImperativePanelHandle>(null);
    // The panel library only reads defaultSize at mount; every later change goes through the handle.
    const everOpenedRef = useRef(chatPanelOpen);
    useEffect(() => {
        const panel = chatPanelRef.current;
        if (!panel) return;
        if (chatPanelOpen) {
            // 25 (the mount-time default) the first time; afterwards expand() restores whatever
            // width the user had dragged it to.
            if (panel.isCollapsed()) panel.expand(everOpenedRef.current ? undefined : chatSizes.preferred);
            everOpenedRef.current = true;
        } else if (!panel.isCollapsed()) {
            panel.collapse();
        }
        // chatSizes is read when the panel opens; a window resize alone must not reopen or move it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatPanelOpen]);

    // The reveal: the first message opens the panel with its content sliding right while fading in
    // (.chat-panel-reveal), and the width handoff from the canvas panel animates under
    // data-chat-revealing (index.css). The attribute lives ~450ms, just past the 420ms transition,
    // so a handle drag afterwards is instant again. Only for the started flip, not for leaving focus
    // mode.
    const [revealing, setRevealing] = useState(false);
    const chatStartedRef = useRef(chatStarted);
    useEffect(() => {
        const was = chatStartedRef.current;
        chatStartedRef.current = chatStarted;
        if (was || !chatStarted || chatHidden) return;
        setRevealing(true);
        const timer = setTimeout(() => setRevealing(false), 450);
        return () => {
            clearTimeout(timer);
            // Hiding the chat inside those 450 ms re-runs this effect, which returns early: without
            // this the flag would stay on and every later panel drag would animate.
            setRevealing(false);
        };
    }, [chatStarted, chatHidden]);

    // The tab shows the project's name (the browser history and the tab bar are how people find it).
    useEffect(() => {
        const previous = document.title;
        document.title = projectName ? `${projectName} · Assembly Studio` : "Assembly Studio";
        return () => {
            document.title = previous;
        };
    }, [projectName]);

    // ---- phone layout: chat and canvas are full-screen alternatives ----
    // A project that is open (picked on the hub, restored from /app/<id> on a reload) means the
    // canvas: it is what the user came back for, and the chat is one tap away. Nothing open (a new
    // chat) means the chat, because the composer is the only thing to do. A project the first send
    // just created has a message already, so the user stays in the chat watching it work.
    const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
    const openProjectId = activeProjectId ?? routeProjectId;
    const [mobileView, setMobileView] = useState<"chat" | "canvas">(openProjectId ? "canvas" : "chat");
    useEffect(() => {
        if (!openProjectId) setMobileView("chat");
        else if (useWorkspaceStore.getState().messages.length === 0) setMobileView("canvas");
    }, [openProjectId]);

    // ---- shortcuts: ⇧⌘O new project, ⌘\ toggle the chat panel, ⌘. stop the run ----
    const chatStartedLive = useRef(chatStarted);
    chatStartedLive.current = chatStarted;
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // Not while an IME is composing, not for a held key repeating, not inside a dialog or field.
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.repeat || e.isComposing) return;
            if (shortcutBlocked(e.target)) return;
            const key = e.key.toLowerCase();
            const store = useWorkspaceStore.getState();
            // The route hook moves the URL to /app/new once the store is reset. (Plain ⌘N belongs
            // to the browser.)
            if (e.shiftKey && key === "o") {
                e.preventDefault();
                startNewProject();
            } else if (!e.shiftKey && key === "\\") {
                if (!chatStartedLive.current) return;
                e.preventDefault();
                store.toggleChat();
            } else if (!e.shiftKey && key === ".") {
                if (!selectIsGenerating(store)) return;
                e.preventDefault();
                void stopGeneration(requestAccessCode);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // A chat card asked to open the analysis: on a phone that means leaving the chat for the canvas.
    const analysisOpenRequest = useAnalysisStore((s) => s.openRequest);
    const seenOpenRequest = useRef(analysisOpenRequest);
    useEffect(() => {
        if (seenOpenRequest.current === analysisOpenRequest) return;
        seenOpenRequest.current = analysisOpenRequest;
        setMobileView("canvas");
    }, [analysisOpenRequest]);

    if (isMobile) {
        return (
            // h-dvh (not h-screen): 100vh overflows under the collapsing mobile browser chrome and
            // would push the composer off-screen.
            <div className="relative h-dvh w-full overflow-hidden bg-canvas">
                {/* The canvas stays mounted at full size (never display:none) so the viewer keeps
                    real dimensions across toggles. `isolate` keeps its z-indexed controls under the
                    chat overlay, which covers it in chat mode. */}
                {/* viewport-fit=cover lets the page run under a notch or the home indicator: the
                    env() insets (0 where there are none) keep controls clear of them. */}
                <div className="absolute inset-0 isolate pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
                    <WorkspaceShell
                        onOpenProjects={goToHub}
                        mobile={{ onShowChat: () => setMobileView("chat") }}
                        chatStarted={chatStarted}
                    />
                </div>
                <div
                    className={`absolute inset-0 bg-sidebar pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] ${
                        mobileView === "chat" ? "" : "hidden"
                    }`}
                >
                    <ChatPanel
                        loading={opening}
                        tagId={tagId}
                        mobile={{
                            onOpenProjects: goToHub,
                            onShowCanvas: () => setMobileView("canvas"),
                            active: mobileView === "chat",
                        }}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-canvas">
            {/* The viewer IS the window background; the panels float on top of it as rounded blocks,
                so opening or closing the chat never moves the canvas. */}
            <div className="absolute inset-0">
                <WorkspaceShell
                    onOpenProjects={goToHub}
                    onShowChat={showChatOwed ? () => setChatHidden(false) : undefined}
                    chatStarted={chatStarted}
                />
            </div>

            {/* Floating panel layer: the transparent centre lets every pointer event fall through to
                the viewer; only the chat panel and its handle catch input. With the chat hidden the
                panel is collapsed, so the canvas spans the full width. */}
            <div className="pointer-events-none absolute inset-0">
                <ResizablePanelGroup
                    direction="horizontal"
                    className="h-full"
                    id="floating-panels"
                    data-chat-revealing={revealing ? "" : undefined}
                >
                    <ResizablePanel
                        id="panel-canvas"
                        order={2}
                        defaultSize={chatPanelOpen ? 100 - chatSizes.preferred : 100}
                        minSize={30}
                    >
                        {/* Transparent spacer over the viewer. Its rect IS the free middle column:
                            the shell measures it to inset the top bar and to frame the model, so the
                            hero slot is an absolute child that never changes the spacer's own box. */}
                        <div id="canvas-viewport-area" className="relative h-full">
                            <div ref={setHeroSlot} className="absolute inset-0 flex flex-col" />
                        </div>
                    </ResizablePanel>
                    {/* A disabled handle keeps an empty chat from being dragged open. */}
                    <ResizableHandle className="pointer-events-auto opacity-0" disabled={!chatPanelOpen} />
                    {/* The chat panel is always MOUNTED (it owns the composer, which the hero borrows)
                        and collapsed to 0 until the conversation starts, or while the chat is hidden. */}
                    <ResizablePanel
                        ref={chatPanelRef}
                        id="panel-chat"
                        order={3}
                        collapsible
                        collapsedSize={0}
                        defaultSize={chatPanelOpen ? chatSizes.preferred : 0}
                        minSize={chatSizes.min}
                        maxSize={CHAT_MAX_PCT}
                    >
                        {/* invisible while collapsed: a 0-width panel still lays its content out, and
                            nothing in it should be focusable or announced. */}
                        <div
                            className={`pointer-events-auto h-full py-3 pr-3 ${
                                chatPanelOpen ? (revealing ? "chat-panel-reveal" : "") : "invisible"
                            }`}
                        >
                            <div className="h-full overflow-hidden rounded-2xl border border-border/70 bg-sidebar shadow-xl">
                                <ChatPanel
                                    heroSlot={!chatStarted ? heroSlot : null}
                                    onHide={() => setChatHidden(true)}
                                    loading={opening}
                                    tagId={tagId}
                                />
                            </div>
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>
        </div>
    );
}
