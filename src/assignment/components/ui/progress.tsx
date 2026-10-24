import * as React from "react";

import { cn } from "@/assignment/lib/utils";

// shadcn's Progress without @radix-ui/react-progress (not installed).
const Progress = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { value?: number }>(
    ({ className, value = 0, ...props }, ref) => (
        <div
            ref={ref}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value)}
            className={cn("relative h-4 w-full overflow-hidden rounded-full bg-secondary", className)}
            {...props}
        >
            <div
                className="h-full w-full flex-1 bg-primary transition-all"
                style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` }}
            />
        </div>
    ),
);
Progress.displayName = "Progress";

export { Progress };
