import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  side?: "right";
}

/**
 * Standard task drawer for contextual work that should not replace the
 * current page. Radix Dialog provides the focus trap, Escape handling and
 * accessible modal semantics; this component only defines the right-side
 * presentation shared by ABCDeploy screens.
 */
export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ className, children, side = "right", ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]" />
    <DialogPrimitive.Content
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-none flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-xl outline-none sm:w-[min(520px,calc(100vw-32px))] sm:max-w-[520px]",
        className,
      )}
      data-side={side}
      ref={ref}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 grid size-8 place-items-center rounded-md text-[var(--muted-foreground)] outline-none hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
        <X className="size-4" />
        <span className="sr-only">关闭</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-1.5 pr-10", className)} {...props} />;
}

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    className={cn("text-base font-semibold", className)}
    ref={ref}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    className={cn(
      "text-sm leading-6 text-[var(--muted-foreground)]",
      className,
    )}
    ref={ref}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;
