// Serving files from R2 (models, provider stills, project thumbnails) and storing project thumbnails.
// Every file URL is unique or versioned (model ids, ?v=<thumbnail_version>), so responses are immutable.

import { API_BASE } from "../src/assignment/shared/contract.ts";
import type { Env } from "./providers/types.ts";
import { HttpError, imageSize, isUuid, json, readBytes, requireUuid, sniffImageType } from "./util.ts";

const THUMBNAIL_LIMIT = 512 * 1024;
// The viewer captures about 512 x 384; a file that declares far more would be an image bomb for every hub visitor.
const THUMBNAIL_MAX_SIDE = 2048;
const THUMBNAIL_MAX_PIXELS = 2048 * 2048;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Maps /files/<kind>/<file> to an R2 key, or null when the shape is wrong. */
function fileKey(kind: string, file: string): string | null {
    if (kind === "models") {
        const m = /^([0-9a-f-]{36})\.glb$/i.exec(file);
        return m && isUuid(m[1]) ? `models/${m[1].toLowerCase()}.glb` : null;
    }
    if (kind === "model-thumbs") {
        const m = /^([0-9a-f-]{36})\.(png|jpg|webp)$/i.exec(file);
        return m && isUuid(m[1]) ? `model-thumbs/${m[1].toLowerCase()}.${m[2].toLowerCase()}` : null;
    }
    if (kind === "thumbs") {
        const m = /^([0-9a-f-]{36})\.webp$/i.exec(file);
        return m && isUuid(m[1]) ? `thumbs/${m[1].toLowerCase()}` : null;
    }
    return null;
}

export async function serveFile(request: Request, env: Env, kind: string, file: string): Promise<Response> {
    const key = fileKey(kind, file);
    if (!key) throw new HttpError(404, "File not found");
    const head = request.method === "HEAD";
    const object = head ? await env.FILES.head(key) : await env.FILES.get(key);
    if (!object) throw new HttpError(404, "File not found");

    const headers = new Headers({
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": IMMUTABLE,
        "X-Content-Type-Options": "nosniff",
        ETag: object.httpEtag,
    });
    const noneMatch = request.headers.get("if-none-match");
    if (noneMatch && noneMatch.split(",").some((tag) => tag.trim() === object.httpEtag || tag.trim() === "*")) {
        await (object as R2ObjectBody).body?.cancel().catch(() => {});
        return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Length", String(object.size));
    return new Response(head ? null : (object as R2ObjectBody).body, { status: 200, headers });
}

/** PUT /projects/:id/thumbnail: a raw image body (<= 512 KB) captured from the viewer. Not an edit. */
export async function putThumbnail(request: Request, env: Env, rawId: string): Promise<Response> {
    const id = requireUuid(rawId, "project id");
    const declared = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!["image/webp", "image/png", "image/jpeg"].includes(declared)) {
        throw new HttpError(415, "Thumbnail must be image/webp, image/png or image/jpeg");
    }
    if (!(await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ?1").bind(id).first())) {
        throw new HttpError(404, "Project not found");
    }
    const bytes = await readBytes(request, THUMBNAIL_LIMIT);
    if (bytes.byteLength === 0 || sniffImageType(bytes) !== declared) {
        throw new HttpError(400, "The body is not a valid image of the declared type");
    }
    const size = imageSize(bytes, declared as "image/webp" | "image/png" | "image/jpeg");
    if (!size || size.width < 1 || size.height < 1) throw new HttpError(400, "The image size could not be read");
    if (
        size.width > THUMBNAIL_MAX_SIDE ||
        size.height > THUMBNAIL_MAX_SIDE ||
        size.width * size.height > THUMBNAIL_MAX_PIXELS
    ) {
        throw new HttpError(
            400,
            `The image is too large: at most ${THUMBNAIL_MAX_SIDE} x ${THUMBNAIL_MAX_SIDE} pixels`,
        );
    }
    const key = `thumbs/${id}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: declared } });
    const row = await env.DB.prepare(
        "UPDATE projects SET thumbnail_key = ?1, thumbnail_version = thumbnail_version + 1 WHERE id = ?2 RETURNING thumbnail_version",
    )
        .bind(key, id)
        .first<{ thumbnail_version: number }>();
    if (!row) {
        // The project was purged while the image was uploading.
        await env.FILES.delete(key).catch(() => {});
        throw new HttpError(404, "Project not found");
    }
    return json({ thumbnail_url: `${API_BASE}/files/thumbs/${id}.webp?v=${row.thumbnail_version}` });
}
