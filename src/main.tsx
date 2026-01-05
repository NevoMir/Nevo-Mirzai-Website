import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);

const loader = document.getElementById("app-loader");
if (loader) {
    const hideLoader = () => {
        loader.classList.add("is-hidden");
        window.setTimeout(() => loader.remove(), 500);
    };

    window.requestAnimationFrame(() => window.requestAnimationFrame(hideLoader));
}
