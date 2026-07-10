import {
  ArrowRight,
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
import type { RecentProject, SystemPreflight } from "../types";
import { Brand } from "./Brand";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface ProjectHomeProps {
  loading: boolean;
  preflight: SystemPreflight | null;
  projects: RecentProject[];
  showDemo: boolean;
  onSelect: () => void;
  onDemo: () => void;
  onOpen: (project: RecentProject) => void;
  onForget: (project: RecentProject) => void;
}

export function ProjectHome({
  loading,
  preflight,
  projects,
  showDemo,
  onSelect,
  onDemo,
  onOpen,
  onForget,
}: ProjectHomeProps) {
  const [query, setQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<RecentProject | null>(
    null,
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(normalized) ||
        project.path.toLocaleLowerCase().includes(normalized),
    );
  }, [projects, query]);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
        <header
          className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5"
          data-tauri-drag-region
        >
          <Brand />
          <Button disabled={loading} onClick={onSelect} size="sm">
            {loading ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Plus />
            )}
            添加项目
          </Button>
        </header>

        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[900px] px-6 py-12">
            <div className="mb-9 flex items-end justify-between gap-6">
              <div>
                <h1 className="m-0 text-[28px] font-semibold leading-tight">
                  {projects.length ? "继续你的项目" : "部署第一个项目"}
                </h1>
                <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                  {projects.length
                    ? "项目、连接和部署进度已经保存在这台电脑上。"
                    : "选择代码目录，系统会先只读识别，再给出推荐部署方案。"}
                </p>
              </div>
              {projects.length > 4 ? (
                <label className="relative block w-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--subtle-foreground)]" />
                  <Input
                    className="pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="查找项目"
                    value={query}
                  />
                </label>
              ) : null}
            </div>

            {projects.length ? (
              <section
                aria-label="最近项目"
                className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              >
                {filtered.map((project) => (
                  <div
                    className="group flex min-h-[76px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0 hover:bg-[var(--muted)]"
                    key={project.id}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]"
                      onClick={() => onOpen(project)}
                      type="button"
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]">
                        <FolderOpen className="size-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <strong className="truncate text-sm font-medium">
                            {project.name}
                          </strong>
                          {!project.pathExists ? (
                            <span className="text-xs text-[var(--warning)]">
                              目录已移动
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
                          {project.serviceCount} 个服务 ·{" "}
                          {stepLabel(project.currentStep)}
                        </span>
                      </span>
                      <span className="hidden items-center gap-1.5 text-xs text-[var(--subtle-foreground)] sm:flex">
                        <Clock3 className="size-3.5" />
                        {formatRelativeTime(project.lastOpenedAt)}
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-[var(--subtle-foreground)]" />
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={`移除 ${project.name}`}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                          onClick={() => setPendingRemoval(project)}
                          size="icon"
                          variant="ghost"
                        >
                          <MoreHorizontal />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>项目选项</TooltipContent>
                    </Tooltip>
                  </div>
                ))}
                {!filtered.length ? (
                  <div className="px-5 py-12 text-center text-sm text-[var(--muted-foreground)]">
                    没有匹配的项目
                  </div>
                ) : null}
              </section>
            ) : (
              <section className="flex min-h-[280px] flex-col items-center justify-center border-y border-[var(--border)] py-12 text-center">
                <span className="mb-5 grid size-12 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                  <FolderOpen className="size-5" />
                </span>
                <h2 className="m-0 text-base font-semibold">从本机项目开始</h2>
                <p className="mb-6 mt-2 max-w-md text-sm leading-6 text-[var(--muted-foreground)]">
                  识别过程不会运行项目代码，也不会读取环境变量的值。
                </p>
                <div className="flex items-center gap-2">
                  <Button disabled={loading} onClick={onSelect}>
                    <FolderOpen />
                    选择项目目录
                  </Button>
                  {showDemo ? (
                    <Button onClick={onDemo} variant="secondary">
                      查看示例
                    </Button>
                  ) : null}
                </div>
              </section>
            )}

            <div className="mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <CheckCircle2
                className={
                  preflight?.ready_for_cloud_deploy
                    ? "size-4 text-[var(--success)]"
                    : "size-4 text-[var(--warning)]"
                }
              />
              <span>
                {preflight
                  ? preflight.ready_for_cloud_deploy
                    ? `本机部署能力正常 · ${preflight.operating_system}`
                    : "本机还有一项工具需要处理，选择项目后会给出办法"
                  : "正在检查本机部署能力"}
              </span>
            </div>
          </div>
        </main>
      </div>

      <Dialog
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        open={Boolean(pendingRemoval)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从最近项目中移除？</DialogTitle>
            <DialogDescription>
              只会删除 ABCDeploy
              在本机保存的项目记录，不会删除代码、部署文件或服务器数据。
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
              移除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function stepLabel(step: RecentProject["currentStep"]) {
  return {
    inspection: "等待确认识别结果",
    connections: "等待连接服务",
    recommendation: "等待确认方案",
    requirements: "等待补充必要信息",
    review: "等待部署确认",
    deploying: "正在部署",
    workspace: "已进入项目工作台",
  }[step];
}

function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30
    ? `${days} 天前`
    : new Date(value).toLocaleDateString("zh-CN");
}
