import * as React from "react";

import { cn } from "@/assignment/lib/utils";

export interface SliderProps
    extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange"> {
    /** One thumb only; the array keeps shadcn's call sites working. */
    value?: number[];
    defaultValue?: number[];
    onValueChange?: (value: number[]) => void;
}

// shadcn's Slider without @radix-ui/react-slider (not installed): a native range input
// in the primary colour, which is plenty for a single-thumb control.
const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
    ({ className, value, defaultValue, onValueChange, min = 0, max = 100, step = 1, ...props }, ref) => (
        <input
            ref={ref}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value?.[0]}
            defaultValue={defaultValue?.[0]}
            onChange={(event) => onValueChange?.([Number(event.target.value)])}
            className={cn(
                "h-2 w-full cursor-pointer appearance-auto rounded-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            {...props}
        />
    ),
);
Slider.displayName = "Slider";

export { Slider };
