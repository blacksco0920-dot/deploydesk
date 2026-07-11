import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FolderKanban,
  LayoutGrid,
  LoaderCircle,
  Plus,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { RecentProject, SystemPreflight } from "../types";
import { Brand } from "./Brand";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface AppShellProps {
  activePath: string;
  children: ReactNode;
  loading: boolean;
  onAddProject: () => void;
  onOpenProject: (project: RecentProject) => void;
  onShowProjects: () => void;
  preflight: SystemPreflight | null;
  projects: RecentProject[];
}

export function AppShell({
  activePath,
  children,
  loading,
  onAddProject,
  onOpenProject,
  onShowProjects,
  preflight,
  projects,
}: AppShellProps) {
  return (
    <TooltipProvider delayDuration={350}>
      <div className="grid h-full min-h-0 grid-cols-[236px_minmax(0,1fr)] bg-[var(--background)] max-[900px]:grid-cols-[72px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] px-3 py-3 max-[900px]:px-2">
          <div className="flex h-10 items-center px-1 max-[900px]:justify-center">
            <div className="max-[900px]:hidden">
              <Brand />
            </div>
            <div className="hidden max-[900px]:block">
              <Brand compact />
            </div>
          </div>

          <nav className="mt-4" aria-label="工作区">
            <SidebarButton
              active={!activePath}
              icon={LayoutGrid}
              label="所有项目"
              onClick={onShowProjects}
            />
          </nav>

          <div className="mt-5 flex items-center justify-between px-2 max-[900px]:justify-center max-[900px]:px-0">
            <span className="text-[10px] font-medium text-[var(--subtle-foreground)] max-[900px]:hidden">
              项目
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="添加项目"
                  disabled={loading}
                  onClick={onAddProject}
                  size="icon"
                  variant="ghost"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">添加项目</TooltipContent>
            </Tooltip>
          </div>

          <div
            className="mt-1 min-h-0 flex-1 space-y-1 overflow-y-auto"
            data-testid="project-sidebar"
          >
            {projects.map((project) => (
              <ProjectButton
                active={project.path === activePath}
                key={project.id}
                onClick={() => onOpenProject(project)}
                project={project}
              />
            ))}
          </div>

          <div className="mt-3 flex h-9 items-center gap-2 border-t border-[var(--border)] px-2 pt-3 max-[900px]:justify-center max-[900px]:px-0">
            <span
              className={`size-2 shrink-0 rounded-full ${
                preflight?.ready_for_cloud_deploy
                  ? "bg-[var(--success)]"
                  : "bg-[var(--warning)]"
              }`}
            />
            <span className="truncate text-[10px] text-[var(--muted-foreground)] max-[900px]:hidden">
              {preflight?.ready_for_cloud_deploy ? "本机可部署" : "本机待检查"}
            </span>
          </div>
        </aside>

        <section className="min-h-0 min-w-0">{children}</section>
      </div>
    </TooltipProvider>
  );
}

function SidebarButton({
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={active ? "page" : undefined}
          className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[900px]:justify-center max-[900px]:px-0 ${
            active
              ? "bg-[var(--muted)] font-medium text-[var(--foreground)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
          onClick={onClick}
          type="button"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate max-[900px]:hidden">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="hidden max-[900px]:block" side="right">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function ProjectButton({
  active,
  onClick,
  project,
}: {
  active: boolean;
  onClick: () => void;
  project: RecentProject;
}) {
  const StatusIcon = project.activeRunCount
    ? LoaderCircle
    : project.latestStatus === "success"
      ? CheckCircle2
      : project.latestStatus === "failed"
        ? XCircle
        : project.latestStatus === "needs_action"
          ? AlertCircle
          : Circle;
  const statusClass = project.activeRunCount
    ? "text-[var(--accent)]"
    : project.latestStatus === "success"
      ? "text-[var(--success)]"
      : project.latestStatus === "failed" ||
          project.latestStatus === "needs_action"
        ? "text-[var(--warning)]"
        : "text-[var(--subtle-foreground)]";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={active ? "page" : undefined}
          className={`flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[900px]:justify-center ${
            active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--muted)]"
          }`}
          onClick={onClick}
          type="button"
        >
          <span className="relative grid size-8 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]">
            <FolderKanban className="size-4" />
            <StatusIcon
              className={`absolute -bottom-1 -right-1 size-3.5 rounded-full bg-[var(--surface)] ${statusClass} ${project.activeRunCount ? "animate-spin-slow" : ""}`}
            />
          </span>
          <span className="min-w-0 flex-1 max-[900px]:hidden">
            <strong className="block truncate text-xs font-medium">
              {project.name}
            </strong>
            <span className="mt-0.5 block truncate text-[10px] text-[var(--muted-foreground)]">
              {projectStatus(project)}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="hidden max-[900px]:block" side="right">
        {project.name} · {projectStatus(project)}
      </TooltipContent>
    </Tooltip>
  );
}

function projectStatus(project: RecentProject) {
  if (!project.pathExists) return "目录已移动";
  if (project.activeRunCount) return "正在部署";
  if (project.latestStatus === "needs_action") return "需要处理";
  if (project.latestStatus === "failed") return "上次部署失败";
  if (project.latestStatus === "success") {
    return project.latestEnvironment === "production"
      ? "正式环境正常"
      : "测试环境正常";
  }
  return project.currentStep === "workspace" ? "等待部署" : "配置未完成";
}
