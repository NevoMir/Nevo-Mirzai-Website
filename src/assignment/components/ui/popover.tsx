import * as React from "react";
import { createPortal } from "react-dom";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/assignment/lib/utils";

// shadcn's Popover API (Popover, PopoverTrigger, PopoverContent, PopoverClose) without
// @radix-ui/react-popover, which is not installed: the content is portalled to <body>,
// placed with fixed coordinates next to the trigger, flipped when it would not fit, and
// closed by Escape or a press outside.

interface PopoverContextValue {
    open: boolean;
    setOpen: (open: boolean) => void;
    triggerRef: React.RefObject<HTMLElement | null>;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopover(): PopoverContextValue {
    const ctx = React.useContext(PopoverContext);
    if (!ctx) throw new Error("Popover parts must be rendered inside <Popover>");
    return ctx;
}

interface PopoverProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
}

function Popover({ open: openProp, defaultOpen = false, onOpenChange, children }: PopoverProps) {
    const [inner, setInner] = React.useState(defaultOpen);
    const triggerRef = React.useRef<HTMLElement | null>(null);
    const open = openProp ?? inner;
    const setOpen = React.useCallback(
        (next: boolean) => {
            if (openProp === undefined) setInner(next);
            onOpenChange?.(next);
        },
        [openProp, onOpenChange],
    );
    const value = React.useMemo(() => ({ open, setOpen, triggerRef }), [open, setOpen]);
    return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

interface PopoverTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    asChild?: boolean;
}

function PopoverTrigger({ asChild, onClick, ...props }: PopoverTriggerProps) {
    const { open, setOpen, triggerRef } = usePopover();
    const Comp = asChild ? Slot : "button";
    return (
        <Comp
            ref={triggerRef as React.Ref<HTMLButtonElement>}
            type={asChild ? undefined : "button"}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-state={open ? "open" : "closed"}
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                onClick?.(event);
                if (!event.defaultPrevented) setOpen(!open);
            }}
            {...props}
        />
    );
}

function PopoverClose({ onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const { setOpen } = usePopover();
    return (
        <button
            type="button"
            onClick={(event) => {
                onClick?.(event);
                setOpen(false);
            }}
            {...props}
        />
    );
}

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const VIEWPORT_MARGIN = 8;

/** Fixed-position coordinates for the content, flipped to the opposite side when it would overflow. */
function place(
    trigger: DOMRect,
    width: number,
    height: number,
    side: Side,
    align: Align,
    offset: number,
): { top: number; left: number; side: Side } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fits: Record<Side, boolean> = {
        bottom: trigger.bottom + offset + height <= vh - VIEWPORT_MARGIN,
        top: trigger.top - offset - height >= VIEWPORT_MARGIN,
        right: trigger.right + offset + width <= vw - VIEWPORT_MARGIN,
        left: trigger.left - offset - width >= VIEWPORT_MARGIN,
    };
    const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    const used = !fits[side] && fits[opposite[side]] ? opposite[side] : side;

    const alongX = (): number =>
        align === "start" ? trigger.left : align === "end" ? trigger.right - width : trigger.left + trigger.width / 2 - width / 2;
    const alongY = (): number =>
        align === "start" ? trigger.top : align === "end" ? trigger.bottom - height : trigger.top + trigger.height / 2 - height / 2;

    let top: number;
    let left: number;
    if (used === "bottom" || used === "top") {
        top = used === "bottom" ? trigger.bottom + offset : trigger.top - offset - height;
        left = alongX();
    } else {
        left = used === "right" ? trigger.right + offset : trigger.left - offset - width;
        top = alongY();
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
    return { top, left, side: used };
}

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
    side?: Side;
    align?: Align;
    sideOffset?: number;
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
    ({ className, side = "bottom", align = "center", sideOffset = 4, style, ...props }, forwardedRef) => {
        const { open, setOpen, triggerRef } = usePopover();
        const contentRef = React.useRef<HTMLDivElement | null>(null);
        const [pos, setPos] = React.useState<{ top: number; left: number; side: Side } | null>(null);

        const setRefs = React.useCallback(
            (node: HTMLDivElement | null) => {
                contentRef.current = node;
                if (typeof forwardedRef === "function") forwardedRef(node);
                else if (forwardedRef) forwardedRef.current = node;
            },
            [forwardedRef],
        );

        // Place it in a layout effect so the first frame the user sees is already positioned.
        React.useLayoutEffect(() => {
            if (!open) {
                setPos(null);
                return;
            }
            const update = () => {
                const trigger = triggerRef.current;
                const content = contentRef.current;
                if (!trigger || !content) return;
                setPos(place(trigger.getBoundingClientRect(), content.offsetWidth, content.offsetHeight, side, align, sideOffset));
            };
            update();
            window.addEventListener("resize", update);
            window.addEventListener("scroll", update, true);
            return () => {
                window.removeEventListener("resize", update);
                window.removeEventListener("scroll", update, true);
            };
        }, [open, side, align, sideOffset, triggerRef]);

        React.useEffect(() => {
            if (!open) return;
            const onKey = (event: KeyboardEvent) => {
                if (event.key !== "Escape") return;
                setOpen(false);
                triggerRef.current?.focus();
            };
            const onPointerDown = (event: PointerEvent) => {
                const target = event.target as Node;
                if (contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
                // A menu or dialog portalled on top of this popover is not "outside" it.
                if (target instanceof Element && target.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='menu']")) return;
                setOpen(false);
            };
            document.addEventListener("keydown", onKey);
            document.addEventListener("pointerdown", onPointerDown);
            return () => {
                document.removeEventListener("keydown", onKey);
                document.removeEventListener("pointerdown", onPointerDown);
            };
        }, [open, setOpen, triggerRef]);

        if (!open) return null;
        return createPortal(
            <div
                ref={setRefs}
                role="dialog"
                data-state="open"
                data-side={pos?.side ?? side}
                className={cn(
                    "fixed z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
                    className,
                )}
                // Hidden until measured, so it never flashes at the corner.
                style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden", ...style }}
                {...props}
            />,
            document.body,
        );
    },
);
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent, PopoverClose };
