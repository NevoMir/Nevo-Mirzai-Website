import * as React from "react";
import { Check, Minus } from "lucide-react";

import { cn } from "@/assignment/lib/utils";

export interface CheckboxProps
    extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "defaultValue"> {
    checked?: boolean | "indeterminate";
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
}

// Same props and `data-state` hooks as shadcn's Checkbox, without @radix-ui/react-checkbox
// (not installed): a button with role="checkbox", so Space toggles it natively.
const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
    ({ className, checked, defaultChecked = false, onCheckedChange, onClick, ...props }, ref) => {
        const [inner, setInner] = React.useState(defaultChecked);
        const state: boolean | "indeterminate" = checked ?? inner;
        const dataState = state === "indeterminate" ? "indeterminate" : state ? "checked" : "unchecked";
        return (
            <button
                ref={ref}
                type="button"
                role="checkbox"
                aria-checked={state === "indeterminate" ? "mixed" : state}
                data-state={dataState}
                className={cn(
                    "peer flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
                    className,
                )}
                onClick={(event) => {
                    onClick?.(event);
                    if (event.defaultPrevented) return;
                    const next = state !== true;
                    if (checked === undefined) setInner(next);
                    onCheckedChange?.(next);
                }}
                {...props}
            >
                {state === "indeterminate" ? <Minus className="h-3.5 w-3.5" /> : state ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
        );
    },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
