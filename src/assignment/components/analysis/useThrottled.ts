import { useEffect, useRef, useState } from "react";

/** A value that changes at most once in `ms`: what a screen reader is told, so a fast run does not talk over itself. */
export function useThrottled<T>(value: T, ms: number): T {
    const [shown, setShown] = useState(value);
    const last = useRef(0);
    useEffect(() => {
        const wait = Math.max(0, last.current + ms - Date.now());
        const id = setTimeout(() => {
            last.current = Date.now();
            setShown(value);
        }, wait);
        return () => clearTimeout(id);
    }, [value, ms]);
    return shown;
}
