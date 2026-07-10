import { Boxes } from "lucide-react";
import { cn } from "../lib/utils";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5" aria-label="小白部署 ABCDeploy">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)]">
        <Boxes className="size-[18px]" strokeWidth={2.1} />
      </span>
      <span className={cn("min-w-0 leading-tight", compact && "sr-only")}>
        <strong className="block truncate text-sm font-semibold">ABCDeploy</strong>
        <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
          小白部署
        </span>
      </span>
    </div>
  );
}
