// The bindings the client-outreach routes use (wrangler.jsonc). All optional, so the Worker still runs the rest of the site
// when they are missing: the outreach routes then answer 503 "not set up".
export interface OutreachEnv {
    ASSETS: Fetcher;
    /** D1 database "llo-outreach": statuses, settings, claims, keys, log, and the research records. */
    OUTREACH_DB?: D1Database;
    /** KV namespace with the research files as uploaded (data/<version>/contacts.json ...), streamed to the page. */
    OUTREACH_KV?: KVNamespace;
    /** The founder's owner key (secret, at least 32 characters): the login password of /client-outreach. */
    OUTREACH_KEY?: string;
}
