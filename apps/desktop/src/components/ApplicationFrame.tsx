import { Boxes, LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "./Brand";

interface ApplicationFrameProps {
  activeView: "projects" | "configuration" | "project";
  children: ReactNode;
  onShowConfiguration: () => void;
  onShowProjects: () => void;
}

export function ApplicationFrame({
  activeView,
  children,
  onShowConfiguration,
  onShowProjects,
}: ApplicationFrameProps) {
  if (activeView === "project") {
    return (
      <div className="h-full min-h-0 bg-[var(--background)]">{children}</div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[208px_minmax(0,1fr)] bg-[var(--background)]">
      <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar-background)] px-3 py-3">
        <div className="flex h-10 items-center px-2">
          <Brand />
        </div>
        <nav aria-label="主导航" className="mt-4 space-y-1">
          <ApplicationNavButton
            active={activeView === "projects"}
            icon={LayoutGrid}
            label="所有项目"
            onClick={onShowProjects}
          />
          <ApplicationNavButton
            active={activeView === "configuration"}
            icon={Boxes}
            label="配置中心"
            onClick={onShowConfiguration}
          />
        </nav>
      </aside>
      <div className="min-h-0 min-w-0">{children}</div>
    </div>
  );
}

function ApplicationNavButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof LayoutGrid;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${active ? "bg-[var(--selection-muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"}`}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
