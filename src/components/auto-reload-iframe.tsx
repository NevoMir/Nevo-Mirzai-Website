import { forwardRef, useEffect, useRef, useState } from "react";
import type { IframeHTMLAttributes } from "react";

type AutoReloadIframeProps = IframeHTMLAttributes<HTMLIFrameElement> & {
    reloadOnVisible?: boolean;
    onReload?: () => void;
};

export const AutoReloadIframe = forwardRef<HTMLIFrameElement, AutoReloadIframeProps>(function AutoReloadIframe(
    { reloadOnVisible = true, onReload, ...props },
    ref
) {
    const [reloadKey, setReloadKey] = useState(0);
    const wasHiddenRef = useRef(false);
    const srcRef = useRef<string | undefined>(undefined);
    const onReloadRef = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
        srcRef.current = typeof props.src === "string" ? props.src : undefined;
    }, [props.src]);

    useEffect(() => {
        onReloadRef.current = onReload;
    }, [onReload]);

    useEffect(() => {
        if (!reloadOnVisible || typeof document === "undefined") return;

        const reload = () => {
            if (srcRef.current) {
                onReloadRef.current?.();
                setReloadKey((value) => value + 1);
            }
        };

        wasHiddenRef.current = document.visibilityState === "hidden";

        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                wasHiddenRef.current = true;
                return;
            }

            if (document.visibilityState === "visible" && wasHiddenRef.current) {
                wasHiddenRef.current = false;
                reload();
            }
        };

        const onFocus = () => {
            if (document.visibilityState === "visible" && wasHiddenRef.current) {
                wasHiddenRef.current = false;
                reload();
            }
        };

        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) {
                reload();
            }
        };

        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onFocus);
        window.addEventListener("pageshow", onPageShow);

        return () => {
            document.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("pageshow", onPageShow);
        };
    }, [reloadOnVisible]);

    return <iframe key={reloadKey} ref={ref} {...props} />;
});
