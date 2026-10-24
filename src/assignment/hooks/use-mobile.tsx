import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

// Phone layout must survive rotation: a phone held sideways is ~800-950px
// WIDE but short — a width-only breakpoint would snap it back to the desktop
// layout mid-rotation. So: narrow (portrait phone) OR short-and-touch
// (landscape phone). The pointer:coarse guard keeps short DESKTOP windows
// (quarter-tiled, docked devtools) on the desktop layout, and iPads (min side
// ≥768, landscape width ≥1024) stay desktop in both orientations. Plain
// comma-list members (no extra parens) so pre-MQ4 engines still parse the
// landscape clause.
const MOBILE_LAYOUT_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px), (pointer: coarse) and (max-width: 1023px) and (max-height: 499px)`;

export function useMobileLayout() {
  const [isMobile, setIsMobile] = React.useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_LAYOUT_QUERY).matches : false,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
