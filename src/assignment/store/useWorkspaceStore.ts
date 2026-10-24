import { create } from "zustand";

import {
    TERMINAL_JOB_STATUSES,
    type ChatMessage,
    type HubProject,
    type Job,
    type ModelAsset,
    type ProjectData,
    type ProjectDetail,
    type ProviderId,
    type ProvidersResponse,
} from "@/assignment/shared/contract";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * The top bar's views: the model in 3D, the same model as an assembly of 100 mm blocks with the structural
 * report (store/analysis.ts), or the list of every model the project made.
 */
export type WorkspaceTab = "3d" | "analysis" | "models";

/**
 * The workspace's one source of truth for the project on screen. The URL says which
 * project to open (hooks/useProjectRoute.ts keeps the two in step); this store holds
 * what was opened plus everything the chat and the viewer add to it.
 *
 * `messages`, `jobs`, `models` and `activeModelId` are the LIVE copies. `project` is
 * mostly its metadata (name, pinned, tags, thumbnail): the `data`, `models` and `jobs`
 * inside it are only the snapshot from when it was loaded, so read the fields below.
 */
interface WorkspaceState {
    /** The saved project on screen; null for a new chat that has not been sent yet. */
    activeProjectId: string | null;
    /** The project the route hook is fetching right now, if any. */
    loadingProjectId: string | null;
    project: ProjectDetail | null;
    messages: ChatMessage[];
    jobs: Record<string, Job>;
    models: ModelAsset[];
    /** The model shown in the viewer. */
    activeModelId: string | null;
    /** A prompt typed while a generation was running; sent when it finishes. */
    queuedPrompt: string | null;
    /**
     * The text in the composer. Held here (not in the panel) so it survives the panel remounting when
     * the layout flips between phone and desktop, and so a Stop can hand a queued prompt back to it.
     * A different project starts with an empty box.
     */
    draft: string;
    saveStatus: SaveStatus;
    /** Focus mode: the chat panel is folded away. */
    chatHidden: boolean;
    /** A prompt is being sent (the project row and the jobs are being created). */
    sending: boolean;
    /** Which send owns `sending`: a send that ends after the user moved on must not clear a newer one. */
    sendTicket: number;
    /** Bumped whenever the chat on screen is replaced; a save started before that must not mark the new one saved. */
    session: number;
    workspaceTab: WorkspaceTab;
    /**
     * Bumped by every change to what the project saves (messages, active model). The autosave
     * compares it with `savedRevision`, so loading a project never counts as an edit.
     */
    revision: number;
    savedRevision: number;
    /** Models, daily usage and whether an access code is needed. Global: survives a new chat. */
    providers: ProvidersResponse | null;
    /** Models the server refused to stop this session (their provider cannot cancel a started run). */
    unstoppable: ProviderId[];

    /** Blank chat: forget the project and everything in it. */
    startNewChat: () => void;
    /** Show a project loaded from the server (replaces everything). */
    setProject: (detail: ProjectDetail) => void;
    /** The first send created the row for the chat on screen: give it an id, keep what is typed. */
    adoptProject: (project: HubProject) => void;
    /**
     * Merge fresh metadata (a rename, a pin, a new thumbnail) into `project`. A late response passes
     * the id it was for, so it cannot land on whichever project is open by then.
     */
    updateProjectMeta: (meta: Partial<HubProject>, forProjectId?: string) => void;
    setLoadingProjectId: (id: string | null) => void;

    setMessages: (messages: ChatMessage[]) => void;
    addMessage: (message: ChatMessage) => void;
    updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
    removeMessage: (id: string) => void;

    upsertJob: (job: Job) => void;
    /** Add a finished model (or replace the one with the same id). Does not select it. */
    addModel: (model: ModelAsset) => void;
    setActiveModel: (id: string | null) => void;

    setSaveStatus: (status: SaveStatus) => void;
    /** The save for `revision` landed. */
    markSaved: (revision: number) => void;
    /** A send begins; resolves to the ticket its end must present. */
    beginSend: () => number;
    endSend: (ticket: number) => void;
    setDraft: (draft: string) => void;
    /** Put text back in the box (a send that did not start, a queued prompt after Stop) without losing what is typed. */
    restoreDraft: (text: string) => void;
    setWorkspaceTab: (tab: WorkspaceTab) => void;
    setProviders: (providers: ProvidersResponse) => void;
    markUnstoppable: (provider: ProviderId) => void;
    setQueuedPrompt: (prompt: string | null) => void;
    setChatHidden: (hidden: boolean) => void;
    toggleChat: () => void;
}

const EMPTY = {
    activeProjectId: null,
    loadingProjectId: null,
    project: null,
    messages: [] as ChatMessage[],
    jobs: {} as Record<string, Job>,
    models: [] as ModelAsset[],
    activeModelId: null,
    queuedPrompt: null,
    saveStatus: "idle" as SaveStatus,
    chatHidden: false,
    sending: false,
    workspaceTab: "3d" as WorkspaceTab,
    revision: 0,
    savedRevision: 0,
};

/** The model the project was last looking at, falling back to its newest. */
function initialActiveModel(detail: ProjectDetail): string | null {
    const saved = detail.data?.active_model_id;
    if (saved && detail.models.some((m) => m.id === saved)) return saved;
    return detail.models.length ? detail.models[detail.models.length - 1].id : null;
}

/**
 * `messages` comes from the server and anyone can write it (PATCH /projects/:id is open), so it is
 * rebuilt entry by entry: a null, a wrong role or a non-string field would otherwise throw inside
 * render and make the project unopenable.
 */
export function sanitizeMessages(raw: unknown): ChatMessage[] {
    if (!Array.isArray(raw)) return [];
    const out: ChatMessage[] = [];
    for (const item of raw as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const m = item as Record<string, unknown>;
        if (typeof m.id !== "string" || !m.id) continue;
        if (m.role !== "user" && m.role !== "assistant") continue;
        const message: ChatMessage = {
            id: m.id,
            role: m.role,
            content: typeof m.content === "string" ? m.content : "",
            timestamp: typeof m.timestamp === "string" ? m.timestamp : "",
        };
        if (Array.isArray(m.job_ids)) {
            const ids = (m.job_ids as unknown[]).filter((id): id is string => typeof id === "string");
            if (ids.length > 0) message.job_ids = ids;
        }
        out.push(message);
    }
    return out;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
    ...EMPTY,
    draft: "",
    sendTicket: 0,
    session: 0,
    providers: null,
    unstoppable: [],

    startNewChat: () => set((s) => ({ ...EMPTY, draft: "", session: s.session + 1 })),

    setProject: (detail) =>
        set((s) => ({
            activeProjectId: detail.id,
            loadingProjectId: s.loadingProjectId === detail.id ? null : s.loadingProjectId,
            project: detail,
            messages: sanitizeMessages(detail.data?.messages),
            jobs: Object.fromEntries(detail.jobs.map((job) => [job.id, job])),
            models: detail.models,
            activeModelId: initialActiveModel(detail),
            queuedPrompt: null,
            draft: "",
            saveStatus: "idle",
            sending: false,
            session: s.session + 1,
            workspaceTab: "3d",
            revision: 0,
            savedRevision: 0,
        })),

    adoptProject: (project) =>
        set((s) => ({
            activeProjectId: project.id,
            project: {
                ...project,
                data: { messages: s.messages, active_model_id: s.activeModelId },
                models: s.models,
                jobs: Object.values(s.jobs),
            },
        })),

    updateProjectMeta: (meta, forProjectId) =>
        set((s) =>
            s.project && (forProjectId === undefined || s.project.id === forProjectId)
                ? { project: { ...s.project, ...meta } }
                : {},
        ),

    setLoadingProjectId: (id) => set({ loadingProjectId: id }),

    setMessages: (messages) => set((s) => ({ messages, revision: s.revision + 1 })),
    addMessage: (message) => set((s) => ({ messages: [...s.messages, message], revision: s.revision + 1 })),
    updateMessage: (id, patch) =>
        set((s) => ({
            messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
            revision: s.revision + 1,
        })),
    removeMessage: (id) =>
        set((s) => ({ messages: s.messages.filter((m) => m.id !== id), revision: s.revision + 1 })),

    upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
    addModel: (model) =>
        set((s) => ({
            models: s.models.some((m) => m.id === model.id)
                ? s.models.map((m) => (m.id === model.id ? model : m))
                : [...s.models, model],
        })),
    setActiveModel: (id) => set((s) => (s.activeModelId === id ? s : { activeModelId: id, revision: s.revision + 1 })),

    setSaveStatus: (saveStatus) => set({ saveStatus }),
    markSaved: (revision) => set((s) => ({ savedRevision: Math.max(s.savedRevision, revision) })),
    beginSend: () => {
        set((s) => ({ sending: true, sendTicket: s.sendTicket + 1 }));
        return get().sendTicket;
    },
    // A newer send (another project's) owns the flag by now: leave it alone.
    endSend: (ticket) => set((s) => (s.sendTicket === ticket ? { sending: false } : {})),
    setDraft: (draft) => set({ draft }),
    restoreDraft: (text) => set((s) => ({ draft: s.draft && s.draft !== text ? `${text}\n${s.draft}` : text })),
    setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
    setProviders: (providers) => set({ providers }),
    markUnstoppable: (provider) =>
        set((s) => (s.unstoppable.includes(provider) ? {} : { unstoppable: [...s.unstoppable, provider] })),
    setQueuedPrompt: (queuedPrompt) => set({ queuedPrompt }),
    setChatHidden: (chatHidden) => set({ chatHidden }),
    toggleChat: () => set((s) => ({ chatHidden: !s.chatHidden })),
}));

/** Is any job of the open project still running? (Not a hook: use it as a selector.) */
export const selectIsGenerating = (s: WorkspaceState): boolean =>
    Object.values(s.jobs).some(
        (job) => job.project_id === s.activeProjectId && !TERMINAL_JOB_STATUSES.includes(job.status),
    );

export function useIsGenerating(): boolean {
    return useWorkspaceStore(selectIsGenerating);
}

/** Jobs of the open project that are still running. */
export function activeJobsOf(s: Pick<WorkspaceState, "jobs" | "activeProjectId">): Job[] {
    return Object.values(s.jobs).filter(
        (job) => job.project_id === s.activeProjectId && !TERMINAL_JOB_STATUSES.includes(job.status),
    );
}

/** What PATCH /projects/:id { data } should save for the current state. */
export function projectDataOf(s: Pick<WorkspaceState, "messages" | "activeModelId">): ProjectData {
    return { messages: s.messages, active_model_id: s.activeModelId };
}
