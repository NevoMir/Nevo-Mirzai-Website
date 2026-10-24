// The last thing in the tree allowed to fail.
//
// A render-time throw is the one failure nothing else catches: no toast fires, no
// promise rejects, React unmounts the whole tree and the user is left looking at a
// white page they cannot describe. This turns that into a page that still says
// something. Cably's fallback, minus the error reporter (there is no backend for it).
import { Component, type ErrorInfo, type ReactNode } from "react";

import { APP_BASE } from "@/assignment/shared/contract";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: unknown): State {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // The console is the only place to look; there is no reporting endpoint.
        console.error("Assembly Studio crashed:", error, info.componentStack);
    }

    render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <div
                data-testid="app-error-boundary"
                className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center"
            >
                <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
                {/* No "try again" that re-renders the same broken tree into the same throw:
                    a reload (or a way out to the projects list) is the only honest offer. */}
                <p className="max-w-md text-sm text-muted-foreground">
                    The page hit an error it could not recover from. Reloading usually fixes it, and your projects are
                    saved on the server.
                </p>
                {error.message && (
                    <code className="max-w-md break-words rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                        {error.message}
                    </code>
                )}
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        Reload the page
                    </button>
                    {/* A real navigation, not the router's: the router may be what broke. */}
                    <a
                        href={`${APP_BASE}/app`}
                        className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
                    >
                        All projects
                    </a>
                </div>
            </div>
        );
    }
}
