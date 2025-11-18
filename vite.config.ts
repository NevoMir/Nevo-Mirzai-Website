import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
    base: "/Nevo-Mirzai-Website/",
    plugins: [react(), tailwindcss()],
    assetsInclude: ["**/*.pptx", "**/*.ppt"],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "/src": path.resolve(__dirname, "src")
        },
    },
});
