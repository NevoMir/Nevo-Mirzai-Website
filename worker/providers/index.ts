// The text-to-3D models the app offers, and which API serves each one.
// A model is available when one of its routes is enabled (its API key is configured), so the app works with any
// subset of FAL_KEY / TRIPO_API_KEY / MESHY_API_KEY / the Tencent Cloud key pair. Routes are tried in order and the
// vendor's own API comes first: it has the vendor's newest options and no middleman, while fal is the one-key fallback.
//
// approx_seconds (typical end to end, drives the progress estimate): Tripo's model page lists ~40 s untextured and
// ~120 s textured; Meshy's task-lifecycle page lists ~75 s for the 7.1 preview plus ~80 s for the texture pass;
// Rodin and Hunyuan publish no timings, so those are estimates from third-party measurements: about 2.5 minutes for
// Rodin, and 3-6 minutes for the Hunyuan Pro edition (240 s), before the 3 concurrent jobs per account queue up.
// Replace the Hunyuan figure with the measured time after the first live run.

import type { ProviderId, ProviderInfo } from "../../src/assignment/shared/contract.ts";
import { falHunyuan, falMeshy, falRodin, falTripo } from "./fal.ts";
import { meshyDirect } from "./meshy.ts";
import { mockAdapter } from "./mock.ts";
import { tencentHunyuan } from "./tencent.ts";
import { tripoParts, tripoTextured } from "./tripo.ts";
import type { Env, ProviderAdapter, ProviderSpec, Via } from "./types.ts";

// A key that is empty or only whitespace counts as not configured.
const hasFal = (env: Env) => Boolean(env.FAL_KEY?.trim());
const hasTripo = (env: Env) => Boolean(env.TRIPO_API_KEY?.trim());
const hasMeshy = (env: Env) => Boolean(env.MESHY_API_KEY?.trim());
const hasTencent = (env: Env) => Boolean(env.TENCENTCLOUD_SECRET_ID?.trim() && env.TENCENTCLOUD_SECRET_KEY?.trim());

export const PROVIDER_SPECS: ProviderSpec[] = [
    {
        id: "tripo-parts",
        info: {
            label: "Tripo H3.1 · Parts",
            vendor: "Tripo",
            description: "Splits the object into separate editable parts, a real assembly (untextured)",
            parts: true,
            textured: false,
            approx_seconds: 90,
        },
        routes: [{ via: "tripo", adapter: tripoParts, enabled: hasTripo }],
    },
    {
        id: "tripo",
        info: {
            label: "Tripo H3.1",
            vendor: "Tripo",
            description: "Clean geometry with PBR textures",
            parts: false,
            textured: true,
            approx_seconds: 120,
        },
        routes: [
            { via: "tripo", adapter: tripoTextured, enabled: hasTripo },
            { via: "fal", adapter: falTripo, enabled: hasFal },
        ],
    },
    {
        id: "meshy",
        info: {
            label: "Meshy 7.1",
            vendor: "Meshy",
            description: "Detailed models with PBR textures (mesh first, then texturing)",
            parts: false,
            textured: true,
            approx_seconds: 170,
        },
        routes: [
            { via: "meshy", adapter: meshyDirect, enabled: hasMeshy },
            { via: "fal", adapter: falMeshy, enabled: hasFal },
        ],
    },
    {
        id: "rodin",
        info: {
            label: "Rodin Gen-2.5",
            vendor: "Hyper3D",
            description: "High-fidelity geometry with PBR materials",
            parts: false,
            textured: true,
            approx_seconds: 140,
        },
        routes: [{ via: "fal", adapter: falRodin, enabled: hasFal }],
    },
    {
        id: "hunyuan",
        info: {
            label: "Hunyuan 3D 3.1",
            vendor: "Tencent",
            description: "Tencent's 3D model: detailed geometry with textures",
            parts: false,
            textured: true,
            approx_seconds: 240,
        },
        routes: [
            { via: "tencent", adapter: tencentHunyuan, enabled: hasTencent },
            { via: "fal", adapter: falHunyuan, enabled: hasFal },
        ],
    },
    {
        id: "mock",
        info: {
            label: "Demo (offline)",
            vendor: "Local",
            description: "Replays a bundled desk-lamp assembly; no API call",
            parts: true,
            textured: false,
            approx_seconds: 12,
        },
        routes: [{ via: "mock", adapter: mockAdapter, enabled: (env) => env.MOCK_PROVIDER === "1" }],
    },
];

export function resolveProvider(
    env: Env,
    id: ProviderId,
): { spec: ProviderSpec; via: Via; adapter: ProviderAdapter } | null {
    const spec = PROVIDER_SPECS.find((s) => s.id === id);
    const route = spec?.routes.find((r) => r.enabled(env));
    return spec && route ? { spec, via: route.via, adapter: route.adapter } : null;
}

export function listProviders(env: Env): ProviderInfo[] {
    return PROVIDER_SPECS.flatMap((spec) => {
        const route = spec.routes.find((r) => r.enabled(env));
        // The mock is a local-dev tool: hide it entirely unless it is switched on.
        if (spec.id === "mock" && !route) return [];
        return [{ id: spec.id, ...spec.info, via: route?.via ?? null, available: Boolean(route) }];
    });
}
