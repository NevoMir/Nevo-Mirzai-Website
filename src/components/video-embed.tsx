import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, IframeHTMLAttributes } from "react";

import { AutoReloadIframe } from "@/components/auto-reload-iframe";
import { cn } from "@/lib/utils";
import { getEmbedProvider } from "@/lib/project-assets";

type VideoEmbedProps = IframeHTMLAttributes<HTMLIFrameElement> & {
    poster?: string;
    wrapperClassName?: string;
    wrapperStyle?: CSSProperties;
    mediaClassName?: string;
};

const VIMEO_ORIGIN = "https://player.vimeo.com";

function addQueryParams(value: string, params: Record<string, string>) {
    try {
        const url = new URL(value);
        Object.entries(params).forEach(([key, paramValue]) => {
            if (!url.searchParams.has(key)) {
                url.searchParams.set(key, paramValue);
            }
        });
        return url.toString();
    } catch {
        return value;
    }
}

export function VideoEmbed({
    poster,
    wrapperClassName,
    wrapperStyle,
    mediaClassName,
    onLoad,
    ...props
}: VideoEmbedProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const provider = useMemo(
        () => (typeof props.src === "string" ? getEmbedProvider(props.src) : null),
        [props.src]
    );
    const embedSrc = useMemo(() => {
        if (typeof props.src !== "string") return props.src;
        if (provider === "vimeo") {
            return addQueryParams(props.src, { api: "1" });
        }
        return props.src;
    }, [props.src, provider]);
    const [loaded, setLoaded] = useState(!poster);

    useEffect(() => {
        setLoaded(!poster);
    }, [poster, embedSrc]);

    useEffect(() => {
        if (provider !== "vimeo") return;

        const handleMessage = (event: MessageEvent) => {
            if (event.origin !== VIMEO_ORIGIN) return;
            if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;

            let data: unknown = event.data;
            if (typeof data === "string") {
                try {
                    data = JSON.parse(data);
                } catch {
                    return;
                }
            }

            if (!data || typeof data !== "object") return;
            const payload = data as { event?: string };
            const eventName = payload.event;
            if (eventName === "timeupdate" || eventName === "bufferend") {
                setLoaded(true);
            }
        };

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [provider]);

    const handleLoad: IframeHTMLAttributes<HTMLIFrameElement>["onLoad"] = (event) => {
        if (provider !== "vimeo") {
            setLoaded(true);
        }

        if (provider === "vimeo" && iframeRef.current?.contentWindow) {
            ["timeupdate", "bufferend"].forEach((eventName) => {
                iframeRef.current?.contentWindow?.postMessage(
                    JSON.stringify({ method: "addEventListener", value: eventName }),
                    VIMEO_ORIGIN
                );
            });
        }

        onLoad?.(event);
    };

    return (
        <div className={cn("relative w-full h-full overflow-hidden bg-black", wrapperClassName)} style={wrapperStyle}>
            {poster && (
                <img
                    src={poster}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className={cn(
                        "absolute inset-0 h-full w-full object-cover transition-opacity duration-500",
                        mediaClassName,
                        loaded ? "opacity-0" : "opacity-100"
                    )}
                />
            )}
            <AutoReloadIframe
                {...props}
                src={embedSrc}
                onLoad={handleLoad}
                onReload={() => setLoaded(!poster)}
                ref={iframeRef}
                className={cn(
                    "absolute inset-0 h-full w-full border-0 transition-opacity duration-500",
                    mediaClassName,
                    loaded ? "opacity-100" : "opacity-0"
                )}
            />
        </div>
    );
}
