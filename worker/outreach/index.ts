// Entry for the client-outreach routes (run_worker_first in wrangler.jsonc): /client-outreach[/...] and /api/outreach[/...].
// See worker/outreach/README.md for the setup, the data upload and the deploy order.

import { isConfigured } from "./auth.ts";
import { API, handleOutreachApi } from "./api.ts";
import { apiError, errorResponse, html } from "./http.ts";
import { BASE, handlePages } from "./pages.ts";
import type { OutreachEnv } from "./types.ts";

export const isOutreachPath = (pathname: string): boolean =>
    pathname === API || pathname.startsWith(`${API}/`) || pathname === BASE || pathname.startsWith(`${BASE}/`);

export async function handleOutreach(request: Request, env: OutreachEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const isApi = pathname === API || pathname.startsWith(`${API}/`);
    // The guide needs nothing configured; everything else fails closed until the database and a long owner key exist.
    const isGuide = pathname === `${BASE}/agents` || pathname === `${BASE}/agents.md`;
    if (!isGuide && !isConfigured(env)) {
        return isApi
            ? apiError(503, "The outreach service is not set up yet.")
            : html("<!doctype html><title>Not set up</title><p>The outreach page is not set up yet.</p>", 503);
    }
    try {
        return isApi ? await handleOutreachApi(request, env) : await handlePages(request, env);
    } catch (err) {
        return errorResponse(err);
    }
}
