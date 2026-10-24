import * as React from "react";

import { cn } from "@/assignment/lib/utils";

// Cably's Label wraps @radix-ui/react-label, which is not installed here; a plain
// <label> does the same job (it only adds a double-click text-selection guard).
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
    ({ className, ...props }, ref) => (
        <label
            ref={ref}
            className={cn(
                "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
                className,
            )}
            {...props}
        />
    ),
);
Label.displayName = "Label";

export { Label };
