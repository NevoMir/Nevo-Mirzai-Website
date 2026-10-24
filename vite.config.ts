import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const basePath = process.env.VITE_BASE_PATH ?? "/";

// The text-to-3D assignment is a second page (assignment_alex/index.html) with its own
// router under /assignment_alex. In dev, deep links there must get that page, not the site's.
const assignmentSpaFallback = (): Plugin => ({
    name: "assignment-spa-fallback",
    configureServer(server) {
        server.middlewares.use((req, _res, next) => {
            const url = req.url ?? "";
            const pathname = url.split("?")[0];
            if (/^\/assignment_alex(\/[^.]*)?$/.test(pathname)) req.url = "/assignment_alex/index.html";
            next();
        });
    },
});

// https://vite.dev/config/
export default defineConfig({
    base: basePath,
    plugins: [react(), tailwindcss(), assignmentSpaFallback()],
    assetsInclude: ["**/*.pptx", "**/*.ppt"],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "/src": path.resolve(__dirname, "src"),
        },
    },
    server: {
        // `npx wrangler dev` serves the assignment API on 8787.
        proxy: { "/api/assignment_alex": "http://127.0.0.1:8787" },
    },
    build: {
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, "index.html"),
                assignment: path.resolve(__dirname, "assignment_alex/index.html"),
            },
        },
    },
});
