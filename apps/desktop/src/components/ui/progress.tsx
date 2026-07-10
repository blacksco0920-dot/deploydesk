import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";
import { cn } from "../../lib/utils";

export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    className={cn(
      "relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]",
      className,
    )}
    ref={ref}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full bg-[var(--accent)] transition-transform duration-300"
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
