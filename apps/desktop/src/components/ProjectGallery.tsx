import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DeploymentRun, RecentProject } from "../types";
import {
  isFirstDeployTask,
  preferredProjectTask,
  recentProjectStatus,
  type ProjectSetupTask,
  type ProjectVerificationTask,
} from "../lib/projects";
import { projectListState, type ProjectListState } from "./ProjectHome";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

type ProjectFilter = "all" | "attention" | "online";

interface ProjectGalleryProps {
  loading: boolean;
  onForget: (project: RecentProject) => void;
  onOpen: (project: RecentProject) => void;
  onSelect: () => void;
  projects: RecentProject[];
  releaseReadyPaths?: string[];
  selectingProject?: boolean;
  selectionIssue?: { message: string; title: string } | null;
  setupTasks?: ProjectSetupTask[];
  taskRuns: DeploymentRun[];
  verificationTasks?: ProjectVerificationTask[];
}

export function ProjectGallery({
  loading,
  onForget,
  onOpen,
  onSelect,
  projects,
  releaseReadyPaths = [],
  selectingProject = false,
  selectionIssue,
  setupTasks = [],
  taskRuns,
  verificationTasks = [],
}: ProjectGalleryProps) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [query, setQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<RecentProject | null>(
    null,
  );
  const releaseReady = useMemo(
    () => new Set(releaseReadyPaths),
    [releaseReadyPaths],
  );
  const projectCards = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return projects
      .map((project) => {
        const task = preferredProjectTask(taskRuns, project.path);
        const setupTask = setupTasks.find(
          (candidate) =>
            candidate.projectPath === project.path &&
            (!isFirstDeployTask(candidate) || project.latestStatus === null),
        );
        const verificationTask = verificationTasks.find(
          (candidate) =>
            candidate.projectPath === project.path &&
            candidate.runId === project.latestRunId,
        );
        const state = projectListState(
          project,
          task,
          setupTask,
          verificationTask,
        );
        return {
          project,
          state,
          status: recentProjectStatus(
            project,
            task,
            setupTask,
            verificationTask,
            releaseReady.has(project.path),
          ),
        };
      })
      .filter(({ project, state }) => {
        if (
          normalized &&
          !project.name.toLocaleLowerCase().includes(normalized) &&
          !project.path.toLocaleLowerCase().includes(normalized)
        ) {
          return false;
        }
        if (filter === "attention") return state === "user-action";
        if (filter === "online") {
          return project.latestStatus === "success" && state === "normal";
        }
        return true;
      })
      .sort((left, right) =>
        right.project.lastOpenedAt.localeCompare(left.project.lastOpenedAt),
      );
  }, [
    filter,
    projects,
    query,
    releaseReady,
    setupTasks,
    taskRuns,
    verificationTasks,
  ]);
  const recovering = loading && projects.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      <header
        className="flex h-14 shrink-0 items-center justify-end border-b border-[var(--border)] bg-[var(--surface)] px-5"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <label className="relative block w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--subtle-foreground)]" />
            <Input
              aria-label="搜索项目"
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目"
              value={query}
            />
          </label>
          <Button disabled={selectingProject} onClick={onSelect}>
            {selectingProject ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Plus />
            )}
            添加项目
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-7 py-7">
        <div className="mx-auto w-full max-w-[1440px]">
          <div>
            <h1 className="m-0 text-2xl font-semibold">所有项目</h1>
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">
              选择一个项目继续上线，或从电脑添加新的项目。
            </p>
          </div>

          <div className="mt-5 flex items-center gap-2">
            {(
              [
                ["all", "全部"],
                ["attention", "需要处理"],
                ["online", "已经上线"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                className={`rounded-lg px-4 py-2 text-sm ${filter === value ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60"}`}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {selectionIssue ? (
            <div
              className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-3"
              role="alert"
            >
              <div className="flex gap-3">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                <div>
                  <strong className="text-sm">{selectionIssue.title}</strong>
                  <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    {selectionIssue.message}
                  </p>
                </div>
              </div>
              <Button onClick={onSelect} size="sm" variant="secondary">
                重新选择
              </Button>
            </div>
          ) : null}

          {recovering ? (
            <div className="grid min-h-[320px] place-items-center">
              <div className="text-center text-sm text-[var(--muted-foreground)]">
                <LoaderCircle className="mx-auto mb-3 size-5 animate-spin-slow text-[var(--accent)]" />
                正在读取项目
              </div>
            </div>
          ) : projectCards.length ? (
            <section
              aria-label="项目列表"
              className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
            >
              {projectCards.map(({ project, state, status }) => (
                <article
                  className="group relative min-h-[164px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-shadow hover:shadow-md"
                  key={project.id}
                >
                  <button
                    aria-label={`${project.name}，${status}`}
                    className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                    onClick={() => onOpen(project)}
                    type="button"
                  />
                  <div className="relative pointer-events-none flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="m-0 truncate text-base font-semibold">
                        {project.name}
                      </h2>
                      <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">
                        {project.path}
                      </p>
                    </div>
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                      <FolderOpen className="size-5" />
                    </span>
                  </div>
                  <div className="relative pointer-events-none mt-6 flex items-center gap-2 text-xs">
                    <ProjectStatusIcon state={state} />
                    <span>{status}</span>
                  </div>
                  <div className="relative pointer-events-none mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3 text-[11px] text-[var(--subtle-foreground)]">
                    <span>{project.serviceCount} 个服务</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {formatRelativeTime(project.lastOpenedAt)}
                    </span>
                  </div>
                  <Button
                    aria-label={`从列表隐藏 ${project.name}`}
                    className="absolute bottom-2 right-2 z-10 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    onClick={() => setPendingRemoval(project)}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreHorizontal />
                  </Button>
                </article>
              ))}
            </section>
          ) : (
            <section className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] text-center">
              <FolderOpen className="size-6 text-[var(--subtle-foreground)]" />
              <h2 className="mb-0 mt-4 text-base font-semibold">
                {projects.length ? "没有匹配的项目" : "添加第一个项目"}
              </h2>
              <p className="mb-5 mt-2 text-sm text-[var(--muted-foreground)]">
                选择包含前端、后端等完整代码的最外层文件夹。
              </p>
              {!projects.length ? (
                <Button onClick={onSelect}>
                  <Plus />
                  添加项目
                </Button>
              ) : null}
            </section>
          )}
        </div>
      </main>

      <Dialog
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        open={Boolean(pendingRemoval)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              从列表隐藏 {pendingRemoval?.name ?? "这个项目"}？
            </DialogTitle>
            <DialogDescription>
              只会隐藏入口，项目代码、连接、线路和上线记录都会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPendingRemoval(null)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingRemoval) onForget(pendingRemoval);
                setPendingRemoval(null);
              }}
              variant="destructive"
            >
              <Trash2 />
              从列表隐藏
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProjectStatusIcon({ state }: { state: ProjectListState }) {
  if (state === "automatic") {
    return <LoaderCircle className="size-3.5 animate-spin-slow text-[var(--accent)]" />;
  }
  if (state === "user-action") {
    return <AlertCircle className="size-3.5 text-[var(--warning)]" />;
  }
  return <CheckCircle2 className="size-3.5 text-[var(--success)]" />;
}

function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "刚刚";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(value).toLocaleDateString("zh-CN");
}
