import { Suspense, lazy } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router";
import { Loader2 } from "lucide-react";

import { ErrorBoundary } from "@/assignment/components/ErrorBoundary";
import { Toaster } from "@/assignment/components/ui/sonner";
import { TooltipProvider } from "@/assignment/components/ui/tooltip";
import { useTheme } from "@/assignment/hooks/useTheme";
import { HUB_PATH, NEW_PROJECT_PATH, isProjectPath } from "@/assignment/lib/projectPath";
import { APP_BASE } from "@/assignment/shared/contract";

// Both pages are lazy so the hub never pays for the 3D viewer (three.js) and the
// workspace never pays for the hub.
const ProjectsHub = lazy(() => import("./pages/ProjectsHub"));
const Workspace = lazy(() => import("./pages/Workspace"));

/** Applies the theme (adds or removes `.dark`) and follows the OS in System mode. One instance, here. */
function ThemeController() {
    useTheme();
    return null;
}

/**
 * Sonner's default corner (bottom right) is where the workspace's chat composer sits, so toasts
 * there go to the top centre; the hub has nothing in either place, so it keeps the default.
 */
function AppToaster() {
    const { pathname } = useLocation();
    const inWorkspace = pathname === NEW_PROJECT_PATH || isProjectPath(pathname);
    return <Toaster position={inWorkspace ? "top-center" : "bottom-right"} />;
}

function PageFallback() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
        </div>
    );
}

function NotFound() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center">
            <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
            <p className="text-sm text-muted-foreground">There is nothing at this address.</p>
            <Link to={HUB_PATH} className="text-sm font-medium text-primary hover:underline">
                Back to all projects
            </Link>
        </div>
    );
}

const App = () => (
    <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
            <ThemeController />
            <BrowserRouter basename={APP_BASE}>
                <AppToaster />
                <Suspense fallback={<PageFallback />}>
                    <Routes>
                        <Route path="/" element={<Navigate to={NEW_PROJECT_PATH} replace />} />
                        {/* The hub and its views share one element, so switching view keeps its state. */}
                        <Route path="/app" element={<ProjectsHub />} />
                        <Route path="/app/archived" element={<ProjectsHub />} />
                        <Route path="/app/deleted" element={<ProjectsHub />} />
                        <Route path="/app/tag/:tagId" element={<ProjectsHub />} />
                        {/* /app/new and /app/<id> are the WORKSPACE, and the same element on purpose:
                            switching projects (or the first send giving a new chat its id) must never
                            remount it. useProjectRoute keeps URL and store in step. React Router ranks
                            the static segments above :projectId, so the hub's own paths never collide. */}
                        <Route path="/app/new" element={<Workspace />} />
                        <Route path="/app/:projectId" element={<Workspace />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </Suspense>
            </BrowserRouter>
        </TooltipProvider>
    </ErrorBoundary>
);

export default App;
