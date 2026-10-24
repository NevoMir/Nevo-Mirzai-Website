# Text-to-3D assignment (`/assignment_alex`)

The assignment is a Cloudflare Worker (`worker/`, with D1 for projects and R2 for files) that serves the app and its API;
the rest of the site is static. It also ships bundled examples (`public/assignment_alex/examples/`, rebuilt with
`node scripts/assignment/make-examples.mjs`, verified with `--check`).

Release order matters when a change adds a migration:

```sh
npx wrangler d1 migrations apply assignment-alex --remote   # BEFORE merging or deploying main
```

The Worker answers 503 ("being updated") while the database is behind it, and logs this command. Optionally put a
Cloudflare rate-limiting rule (about 10 a minute per IP) in front of `POST /models/*/derived` and `POST /projects/from-example`.
