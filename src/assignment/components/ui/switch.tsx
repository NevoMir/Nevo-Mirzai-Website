import * as React from "react";

import { cn } from "@/assignment/lib/utils";

export interface SwitchProps
    extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "defaultValue"> {
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
}

// shadcn's Switch without @radix-ui/react-switch (not installed): role="switch" button.
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
    ({ className, checked, defaultChecked = false, onCheckedChange, onClick, ...props }, ref) => {
        const [inner, setInner] = React.useState(defaultChecked);
        const on = checked ?? inner;
        const state = on ? "checked" : "unchecked";
        return (
            <button
                ref={ref}
                type="button"
                role="switch"
                aria-checked={on}
                data-state={state}
                className={cn(
                    "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
                    className,
                )}
                onClick={(event) => {
                    onClick?.(event);
                    if (event.defaultPrevented) return;
                    if (checked === undefined) setInner(!on);
                    onCheckedChange?.(!on);
                }}
                {...props}
            >
                <span
                    data-state={state}
                    className="pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
                />
            </button>
        );
    },
);
Switch.displayName = "Switch";

export { Switch };
