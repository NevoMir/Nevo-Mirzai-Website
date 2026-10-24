import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Home, Loader2, PanelRightClose, SquarePen, Box } from "lucide-react";

import { AccessCodeGate } from "@/assignment/components/chat/AccessCodeGate";
import { Composer, MAX_PROMPT_CHARS } from "@/assignment/components/chat/Composer";
import { HeroStart } from "@/assignment/components/chat/HeroStart";
import { JobCard } from "@/assignment/components/chat/JobCard";
import { Markdown } from "@/assignment/components/chat/Markdown";
import { ModelCard } from "@/assignment/components/chat/ModelCard";
import { BrandLockup } from "@/assignment/components/BrandLockup";
import { SettingsMenu } from "@/assignment/components/SettingsMenu";
import { toast } from "@/assignment/components/ui/sonner";
import { useTheme } from "@/assignment/hooks/useTheme";
import { getAccessCode } from "@/assignment/lib/api";
import type { ChatMessage, Job, ModelAsset, ProviderId, ProviderInfo } from "@/assignment/shared/contract";
import { requestAccessCode, settleAccessPrompt, useAccessPrompt } from "@/assignment/store/access";
import { retryJob, sendPrompt, startNewProject, stopGeneration } from "@/assignment/store/generation";
import { isTerminalJob } from "@/assignment/store/jobs";
import {
    generationSwitchedOff,
    initialSelection,
    isCancelable,
    loadSelection,
    providerInfo,
    refreshProviders,
    saveSelection,
} from "@/assignment/store/providers";
import { replyLine } from "@/assignment/store/replies";
import { selectIsGenerating, useIsGenerating, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const EMPTY_QUESTION = "What do you want to build?";

export interface ChatPanelProps {
    /** Present only in the phone layout: the chat fills the screen, so its header carries the link
     *  back to the projects hub and the switch to the 3D view. */
    mobile?: {
        onOpenProjects: () => void;
        onShowCanvas: () => void;
        /** True when the chat is the visible phone view (false while the canvas is showing and the
         *  chat is display:none underneath). */
        active: boolean;
    };
    /** Desktop only: a box over the empty canvas (the page's hero slot). While the chat has no
     *  messages the panel is collapsed and the empty state plus the composer are portalled here
     *  instead, so the prompt sits alone at the bottom of the middle of the window. */
    heroSlot?: HTMLElement | null;
    /** Desktop only: fold the chat panel away and give the viewer the window. */
    onHide?: () => void;
    /** A project from the URL is being fetched: show a spinner, not the empty-chat state. */
    loading?: boolean;
    /** Seed tag for the project the first send creates (the hub's tag page passes `?tag=`). */
    tagId?: string | null;
}

export function ChatPanel({ mobile, heroSlot, onHide, loading = false, tagId = null }: ChatPanelProps = {}) {
    // The text in the box lives in the store: this panel is rebuilt when the layout flips between
    // phone and desktop, and a half-typed prompt must not go with it.
    const input = useWorkspaceStore((s) => s.draft);
    const setInput = useWorkspaceStore((s) => s.setDraft);
    const restoreDraft = useWorkspaceStore((s) => s.restoreDraft);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const { isDark } = useTheme();

    const messages = useWorkspaceStore((s) => s.messages);
    const jobs = useWorkspaceStore((s) => s.jobs);
    const models = useWorkspaceStore((s) => s.models);
    const activeModelId = useWorkspaceStore((s) => s.activeModelId);
    const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
    const sending = useWorkspaceStore((s) => s.sending);
    const queuedPrompt = useWorkspaceStore((s) => s.queuedPrompt);
    const providersInfo = useWorkspaceStore((s) => s.providers);
    const unstoppable = useWorkspaceStore((s) => s.unstoppable);
    const generating = useIsGenerating();

    // ---- model selection ----
    // null until the visitor changes it: the remembered selection (or the server's default) stands in,
    // derived rather than copied into state so there is no frame between the model list arriving and
    // the picker having a label.
    const [selected, setSelected] = useState<ProviderId[] | null>(null);
    const defaultSelection = useMemo(
        () =>
            providersInfo
                ? initialSelection(providersInfo.providers, loadSelection(), providersInfo.default_provider)
                : [],
        [providersInfo],
    );
    const available = new Set(providersInfo?.providers.filter((p) => p.available).map((p) => p.id));
    const picked = (selected ?? []).filter((id) => available.has(id));
    const chosen = picked.length > 0 ? picked : defaultSelection;
    const changeSelection = (next: ProviderId[]) => {
        setSelected(next);
        saveSelection(next);
    };

    // ---- access code ----
    // One dialog for the whole page (store/access.ts), so the Stop shortcut can ask for the code too.
    const gateOpen = useAccessPrompt((s) => s.open);
    const askAccess = requestAccessCode;

    // Newest at the bottom. scrollIntoView is a no-op while the chat is display:none (phone canvas
    // view), so also re-run when the chat becomes the visible view again.
    const chatVisible = !mobile || mobile.active;
    useEffect(() => {
        if (!chatVisible) return;
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, queuedPrompt, chatVisible]);

    // The empty state and the composer paint over the canvas (see heroSlot) until the first
    // message; after it they are back inside the panel. Same component instance either way, so the
    // text typed carries over: only the DOM nodes move.
    const heroActive = Boolean(heroSlot) && messages.length === 0 && !mobile;

    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        // An empty box is one line and needs no measuring, and measuring it is how the box got stuck
        // tall: on the first send the textarea moves into the panel while the panel is still sliding
        // open a few pixels wide, the placeholder wraps into twenty lines, scrollHeight reads ~450,
        // and the 120 px cap sticks until the next keystroke.
        if (!input) return;
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
        // heroActive: the textarea is a NEW node after the portal <-> panel move, with no inline
        // height, and `input` alone does not change on the move.
    }, [input, heroActive]);

    const focusPromptInput = useCallback(() => {
        requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (!ta) return;
            ta.focus();
            const end = ta.value.length;
            ta.setSelectionRange(end, end);
        });
    }, []);

    // Moving the textarea from the hero to the panel recreates its DOM node, which drops keyboard
    // focus mid-conversation. Only on the hero -> panel flip (focusing on plain mount would pop the
    // phone keyboard uninvited), and only when the user was in the box or just sent from it.
    const heroWasActiveRef = useRef(heroActive);
    // onFocus/onBlur keep this current; a node removed while focused fires no blur (Chrome), so it
    // still reads true across the move, which is the case we want.
    const textareaHadFocusRef = useRef(false);
    useEffect(() => {
        const wasActive = heroWasActiveRef.current;
        heroWasActiveRef.current = heroActive;
        if (!wasActive || heroActive) return;
        if (messages.length > 0 || textareaHadFocusRef.current) focusPromptInput();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [heroActive]);

    // A new chat on a desktop starts with the cursor in the box (never on a phone: that would pop
    // the keyboard uninvited), unless the visitor is already somewhere else on the page.
    useEffect(() => {
        if (!heroActive) return;
        if (document.activeElement === document.body) focusPromptInput();
    }, [heroActive, focusPromptInput]);

    // ---- sending ----
    // `queued`: the prompt that waited for the last run (sent by the effect below). If it cannot go
    // out, it goes back to the box instead of vanishing: it was typed once already.
    const submit = async (queued?: string) => {
        const fromQueue = queued !== undefined;
        const text = (queued ?? input).trim();
        if (!text) return;
        const giveBack = () => {
            if (fromQueue) restoreDraft(text);
        };
        const state = useWorkspaceStore.getState();
        // A project from the URL is still being fetched: a send now would start a second, new one.
        if (state.sending || loading) return giveBack();

        if (selectIsGenerating(state)) {
            if (fromQueue) return giveBack();
            // One run at a time per chat: the prompt waits its turn and goes when this one ends.
            if (state.queuedPrompt) {
                toast.info("One prompt can wait at a time", {
                    description: "Unsend the queued one first, or wait for this run to finish.",
                });
                return;
            }
            state.setQueuedPrompt(text);
            setInput("");
            return;
        }

        if (text.length > MAX_PROMPT_CHARS) {
            toast.error("That prompt is too long", { description: `Keep it under ${MAX_PROMPT_CHARS} characters.` });
            return giveBack();
        }
        let info = state.providers;
        if (!info) {
            toast.error("The model list has not loaded", { description: "Check your connection and try again." });
            void refreshProviders();
            return giveBack();
        }
        if (chosen.length === 0) {
            toast.error(
                generationSwitchedOff(info.providers) ? "Generation is switched off" : "No text-to-3D model is available",
                {
                    description: generationSwitchedOff(info.providers)
                        ? "The owner has not set the access code for this deployment yet."
                        : "This deployment has no API key configured yet.",
                },
            );
            return giveBack();
        }
        // The daily cap is known from the last answer: refuse here instead of making a project the
        // server would then refuse to fill. The count may be stale (a new day, a refund), so ask again first.
        // The free demo takes no slot (the server only counts paid models).
        const paid = chosen.filter((id) => id !== "mock").length;
        if (paid > 0 && info.daily_limit !== null && info.used_today + paid > info.daily_limit) {
            await refreshProviders();
            info = useWorkspaceStore.getState().providers ?? info;
            if (info.daily_limit !== null && info.used_today + paid > info.daily_limit) {
                toast.warning("Daily limit reached", {
                    description: `${info.used_today} of ${info.daily_limit} generations are used today. Try again tomorrow.`,
                    duration: 9000,
                });
                return giveBack();
            }
        }
        // Ask before anything is created, so a visitor without the code leaves no empty project.
        if (info.access_required && !getAccessCode() && !(await askAccess())) return giveBack();

        if (!fromQueue) setInput("");
        const outcome = await sendPrompt({
            prompt: text,
            providers: chosen,
            tagId,
            requestAccessCode: askAccess,
        });
        // Hand the text back if nothing started (anything typed since stays too).
        if (!outcome.ok && outcome.restorePrompt) restoreDraft(text);
    };

    // The queue drains itself: the newest submit through a ref, so the effect never captures a
    // stale closure over the composer's state.
    const submitRef = useRef(submit);
    submitRef.current = submit;
    useEffect(() => {
        // The live store, not this render's copy: an effect that runs twice (StrictMode, a remount)
        // must not send the same prompt twice.
        const state = useWorkspaceStore.getState();
        const next = state.queuedPrompt;
        if (!next || selectIsGenerating(state) || state.sending || loading) return;
        state.setQueuedPrompt(null);
        void submitRef.current(next);
    }, [queuedPrompt, generating, sending, loading]);

    const unsendQueued = () => {
        if (!queuedPrompt) return;
        restoreDraft(queuedPrompt);
        useWorkspaceStore.getState().setQueuedPrompt(null);
        focusPromptInput();
    };

    const pickExample = (prompt: string) => {
        setInput(prompt);
        focusPromptInput();
    };

    // ---- phone: flash the 3D button when a model lands while the user sits in the chat ----
    const [flashCanvas, setFlashCanvas] = useState(false);
    const lastActiveModel = useRef(activeModelId);
    useEffect(() => {
        const was = lastActiveModel.current;
        lastActiveModel.current = activeModelId;
        if (mobile?.active && activeModelId && activeModelId !== was) setFlashCanvas(true);
    }, [activeModelId, mobile?.active]);
    useEffect(() => {
        if (!flashCanvas) return;
        const timer = setTimeout(() => setFlashCanvas(false), 3200);
        return () => clearTimeout(timer);
    }, [flashCanvas]);

    // ---- cards ----
    const viewModel = (model: ModelAsset) => {
        const state = useWorkspaceStore.getState();
        state.setActiveModel(model.id);
        state.setWorkspaceTab("3d");
        mobile?.onShowCanvas();
    };
    const retry = (job: Job) => void retryJob(job, askAccess);
    const canRetry = (job: Job) =>
        !sending &&
        !Object.values(jobs).some(
            (other) =>
                other.id !== job.id &&
                other.provider === job.provider &&
                other.prompt === job.prompt &&
                other.created_at > job.created_at,
        );
    const providerList = providersInfo?.providers;
    const renderCard = (job: Job) => (
        <JobCard
            key={job.id}
            job={job}
            providers={providerList}
            active={Boolean(job.model) && job.model?.id === activeModelId}
            canRetry={canRetry(job)}
            onView={viewModel}
            onRetry={retry}
        />
    );

    // Jobs of this project that no message points at (a reload while a send was starting, a run begun
    // in another tab): still shown, so a running job is never invisible while it holds the Stop button.
    const unlistedJobs = useMemo(() => {
        const listed = new Set(messages.flatMap((m) => m.job_ids ?? []));
        return Object.values(jobs)
            .filter((job) => job.project_id === activeProjectId && !listed.has(job.id))
            .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    }, [messages, jobs, activeProjectId]);

    // Stop is offered only when it can work: some providers (Tencent) cannot cancel a running task.
    const stoppable = useMemo(
        () =>
            Object.values(jobs).some(
                (job) =>
                    job.project_id === activeProjectId &&
                    !isTerminalJob(job) &&
                    isCancelable(providerInfo(providerList, job.provider), unstoppable),
            ),
        [jobs, activeProjectId, providerList, unstoppable],
    );

    // No cap configured: no "N/limit today" hint at all.
    const usage =
        providersInfo && providersInfo.daily_limit !== null
            ? { used: providersInfo.used_today, limit: providersInfo.daily_limit }
            : null;
    const hasMessages = messages.length > 0;
    // Short on purpose: the box is one line tall, so a long placeholder would be cut off.
    const placeholder = generating
        ? "Queue the next prompt"
        : hasMessages
          ? "Describe another object"
          : "Describe the object you want to build";

    const brandMark = <BrandLockup size="lg" dark={isDark} />;
    // Ready-made example projects or example prompts, whichever the deployment can offer (components/chat/HeroStart.tsx).
    const examples = <HeroStart onPick={pickExample} tagId={tagId} />;

    // The composer, rendered exactly once: at the bottom of the panel or, before the first message,
    // portalled over the canvas (heroActive).
    const composer = (
        <Composer
            input={input}
            onInput={setInput}
            onSubmit={() => void submit()}
            onStop={() => void stopGeneration(askAccess)}
            textareaRef={textareaRef}
            onTextareaFocus={() => {
                textareaHadFocusRef.current = true;
                // The model list failed to load earlier: try again now that someone wants it.
                if (!useWorkspaceStore.getState().providers) void refreshProviders();
            }}
            onTextareaBlur={() => {
                textareaHadFocusRef.current = false;
            }}
            placeholder={placeholder}
            locked={loading}
            generating={generating}
            stoppable={stoppable}
            canSend={input.trim().length > 0 && !sending && !loading && chosen.length > 0}
            providers={providersInfo?.providers}
            selected={chosen}
            onSelectedChange={changeSelection}
            usage={usage}
        />
    );

    return (
        <div className="@container flex flex-col h-full bg-sidebar">
            {/* Header, only once the conversation has started: an empty chat shows the single big
                centred logo instead (never both at once). On phones the header always exists (it
                carries the navigation buttons), but the logo inside it follows the same rule. */}
            {(hasMessages || mobile || (onHide && !heroActive)) && (
                <div className={`border-b border-sidebar-border ${mobile ? "px-2 py-2" : "px-4 py-4 @[20rem]:px-6"}`}>
                    <div className="flex items-center gap-1">
                        {!mobile && onHide && (
                            <button
                                type="button"
                                onClick={onHide}
                                data-testid="hide-chat"
                                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors shrink-0"
                                title="Hide chat (⌘\)"
                                aria-label="Hide chat"
                            >
                                <PanelRightClose className="h-5 w-5" />
                            </button>
                        )}
                        {mobile && (
                            <button
                                type="button"
                                onClick={mobile.onOpenProjects}
                                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors shrink-0"
                                title="Home"
                                aria-label="Home"
                            >
                                <Home className="h-5 w-5" />
                            </button>
                        )}
                        {/* The wordmark is wide: a panel dragged narrow drops it before it crowds the buttons. */}
                        {hasMessages && (
                            <div className="ml-1 hidden min-w-0 @[17rem]:block">
                                <BrandLockup size="sm" dark={isDark} />
                            </div>
                        )}
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={startNewProject}
                            data-testid="new-project"
                            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors shrink-0"
                            title="New project (⇧⌘O)"
                            aria-label="New project"
                        >
                            <SquarePen className="h-[18px] w-[18px]" />
                        </button>
                        {mobile && (
                            <>
                                <SettingsMenu className="mx-1 shrink-0" />
                                <button
                                    type="button"
                                    onClick={mobile.onShowCanvas}
                                    className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors shrink-0 ${
                                        flashCanvas
                                            ? "sweep-red text-white"
                                            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                                    }`}
                                    title="Open the 3D view"
                                >
                                    <Box className="h-4 w-4" />
                                    3D
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
                {!hasMessages && !heroActive && (
                    <div className="mb-0 flex min-h-full flex-col items-center justify-center text-center space-y-3">
                        {/* min-h-full (not h-full): on short landscape phones the logo + examples
                            exceed the viewport; this lets the block grow and scroll instead of
                            clipping the top under justify-center. */}
                        {loading ? (
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading project" />
                        ) : (
                            <>
                                {brandMark}
                                <p className="text-muted-foreground text-sm">{EMPTY_QUESTION}</p>
                                {examples}
                            </>
                        )}
                    </div>
                )}

                {messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        {msg.role === "user" ? (
                            // WhatsApp-style bubble: tight padding and a small radius so the outline
                            // hugs the text instead of floating around it. Plain text, as typed: a
                            // prompt like "# tower" or "1. x" is not markup.
                            <div className="max-w-[85%] w-fit rounded-lg bg-accent text-accent-foreground px-3 py-1.5 text-sm">
                                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{msg.content}</p>
                            </div>
                        ) : (
                            // A long unbroken word wraps rather than widening the list.
                            <div className="w-full max-w-[95%] text-sm text-sidebar-foreground [overflow-wrap:anywhere]">
                                <AssistantLine message={msg} jobs={jobs} providers={providerList} />
                                {msg.job_ids && msg.job_ids.length > 0 && (
                                    <div className="mt-2 flex flex-col gap-2">
                                        {msg.job_ids.map((id) => (jobs[id] ? renderCard(jobs[id]) : null))}
                                    </div>
                                )}
                                {msg.model_ids && msg.model_ids.length > 0 && (
                                    // A model that was deleted since (a stabilized version) simply has no card:
                                    // the sentence above still reads on its own.
                                    <div className="mt-2 flex flex-col gap-2" data-testid="message-models">
                                        {msg.model_ids.map((id) => {
                                            const model = models.find((m) => m.id === id);
                                            return model ? (
                                                <ModelCard
                                                    key={id}
                                                    model={model}
                                                    models={models}
                                                    active={model.id === activeModelId}
                                                    onView={viewModel}
                                                />
                                            ) : null;
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ))}

                {unlistedJobs.length > 0 && (
                    <div className="flex flex-col gap-2" data-testid="unlisted-jobs">
                        {unlistedJobs.map(renderCard)}
                    </div>
                )}

                {queuedPrompt && (
                    <div className="flex justify-end" data-testid="queued-prompt">
                        <div className="max-w-[85%] w-fit rounded-lg border border-dashed border-accent/70 bg-muted px-3 py-1.5 text-sm text-foreground">
                            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{queuedPrompt}</p>
                            <div className="mt-1 flex items-center gap-2 text-[11px] opacity-80">
                                <span>Queued. Sends when this run finishes</span>
                                <button type="button" className="underline" onClick={unsendQueued} aria-label="Unsend">
                                    Unsend
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {sending && !generating && (
                    <div className="flex justify-start px-2" role="status">
                        <span className="text-[15px] font-medium text-shimmer">Starting…</span>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            {!heroActive && composer}

            {/* The new-chat hero, over the canvas: brand + question + examples in the free space, the
                composer alone at the bottom. pointer-events-none on the column so the viewer stays
                interactive around it; only the examples and the composer take input. pt-[76px]
                clears the floating top bar (mt-3 + ~33px bar). */}
            {heroActive &&
                heroSlot &&
                createPortal(
                    <div className="pointer-events-none flex h-full flex-col pt-[76px]" data-testid="chat-hero">
                        <div className="flex min-h-0 flex-1 -translate-y-[4%] flex-col items-center justify-center gap-5 px-6 text-center">
                            {brandMark}
                            <p className="text-muted-foreground text-sm">{EMPTY_QUESTION}</p>
                            <div className="pointer-events-auto flex w-full justify-center">{examples}</div>
                        </div>
                        <div
                            className="pointer-events-auto mx-auto mt-auto w-full max-w-[42rem] pb-4"
                            data-testid="chat-hero-composer"
                        >
                            {composer}
                        </div>
                    </div>,
                    heroSlot,
                )}

            <AccessCodeGate open={gateOpen} onResult={settleAccessPrompt} />
        </div>
    );
}

/** The reply's one line, worded for how the jobs it points at stand now (see store/replies.ts). */
function AssistantLine({
    message,
    jobs,
    providers,
}: {
    message: ChatMessage;
    jobs: Record<string, Job>;
    providers: readonly ProviderInfo[] | undefined;
}) {
    const mine = (message.job_ids ?? []).map((id) => jobs[id]).filter((job): job is Job => Boolean(job));
    const line = replyLine(message.content, mine, providers);
    return line ? <Markdown>{line}</Markdown> : null;
}
