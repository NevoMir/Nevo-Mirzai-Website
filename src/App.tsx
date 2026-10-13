import { BrowserRouter as Router, Routes, Route } from "react-router";

import Layout from "@/layout";
import { loadLazy } from "@/lib/loadComponent";
import { ThemeProvider } from "@/components/theme-provider";
import { ScrollToTop } from "@/hooks/scroll-to-top";

const About = loadLazy(() => import("@/pages/about"));
const Awards = loadLazy(() => import("@/pages/awards"));
const Projects = loadLazy(() => import("@/pages/projects"));
const Outreach = loadLazy(() => import("@/pages/outreach"));
const NotFound = loadLazy(() => import("@/pages/notfound"));

export default function App() {
    return (
        <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
            <Router>
                <ScrollToTop />
                <Routes>
                    <Route path="/" element={<Layout />}>
                        <Route index element={<About />} />
                        <Route path="projects" element={<Projects />} />
                        <Route path="projects/:slug" element={<Projects />} />
                        <Route path="awards" element={<Awards />} />
                        <Route path="outreach" element={<Outreach />} />
                        <Route path="*" element={<NotFound />} />
                    </Route>
                </Routes>
            </Router>
        </ThemeProvider>
    );
}
