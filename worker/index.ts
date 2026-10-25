// Worker entry for the text-to-3D assignment. Only these paths reach it (see run_worker_first in wrangler.jsonc):
//   /api/assignment_alex/*          the JSON API (worker/api.ts)
//   /assignment_alex[/...]          the single-page app shell, plus its static files
//   queue "assignment-alex-llm"     the Muse assembly designer's LLM calls (worker/llm.ts)
// Everything else on nevomirzai.com is served from ./dist without invoking the Worker.

import { API_BASE, APP_BASE } from "../src/assignment/shared/contract.ts";
import { handleApi } from "./api.ts";
import { handleLlmBatch } from "./llm.ts";
import type { Env } from "./providers/types.ts";
import { errorSummary, jsonError } from "./util.ts";

const hasFileExtension = (pathname: string) => /\.[A-Za-z0-9]+$/.test(pathname.split("/").pop() ?? "");

async function serveApp(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const { pathname } = new URL(request.url);
    // /assignment_alex/fixtures/demo-assembly.glb and friends are plain static files.
    if (hasFileExtension(pathname)) {
        const file = await env.ASSETS.fetch(request);
        // The site's SPA fallback answers unknown paths with index.html; a missing .js or .glb must stay a 404.
        const isHtml = (file.headers.get("content-type") ?? "").includes("text/html");
        if (file.ok && isHtml && !/\.html?$/i.test(pathname)) return new Response("Not found", { status: 404 });
        return file;
    }

    // Any other path is a client-side route: answer with the app shell (html_handling serves it at the trailing slash).
    const shell = await env.ASSETS.fetch(new Request(new URL(`${APP_BASE}/`, request.url), { method: request.method }));
    const response = new Response(shell.body, shell);
    response.headers.set("X-Robots-Tag", "noindex");
    return response;
}

export default {
    async fetch(request, env, ctx): Promise<Response> {
        const { pathname } = new URL(request.url);
        try {
            if (pathname === API_BASE || pathname.startsWith(`${API_BASE}/`)) {
                return await handleApi(request, env, ctx);
            }
            if (pathname === APP_BASE || pathname.startsWith(`${APP_BASE}/`)) {
                return await serveApp(request, env);
            }
            return await env.ASSETS.fetch(request);
        } catch (err) {
            console.error(`unhandled error: ${errorSummary(err)}`);
            return pathname.startsWith(API_BASE)
                ? jsonError(500, "Something went wrong on the server. Please try again.")
                : new Response("Something went wrong.", { status: 500 });
        }
    },

    // The Muse assembly designer's queue (wrangler.jsonc: assignment-alex-llm): one message designs one object.
    async queue(batch, env): Promise<void> {
        await handleLlmBatch(batch, env);
    },
} satisfies ExportedHandler<Env>;
