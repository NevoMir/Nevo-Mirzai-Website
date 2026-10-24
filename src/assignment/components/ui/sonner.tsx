import type { ComponentProps, CSSProperties } from "react";
import { Toaster as Sonner, toast } from "sonner";

import { useIsDark } from "@/assignment/hooks/useIsDark";

type ToasterProps = ComponentProps<typeof Sonner>;

// Sonner paints from its own unlayered stylesheet, which beats Tailwind 4's layered
// utilities, so the app's surface colours go in through sonner's CSS variables.
const toastTheme = {
    "--normal-bg": "hsl(var(--popover))",
    "--normal-text": "hsl(var(--popover-foreground))",
    "--normal-border": "hsl(var(--border))",
    "--border-radius": "0.75rem",
} as CSSProperties;

const Toaster = ({ ...props }: ToasterProps) => {
    // Read-only: the theme itself is applied once, by App's ThemeController.
    const isDark = useIsDark();

    return (
        <Sonner
            theme={isDark ? "dark" : "light"}
            className="toaster group"
            style={toastTheme}
            toastOptions={{
                classNames: {
                    toast: "group toast shadow-lg",
                    description: "group-[.toast]:text-muted-foreground",
                    actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
                    cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
                },
            }}
            {...props}
        />
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export { Toaster, toast };
