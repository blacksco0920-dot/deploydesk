import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Cloud,
  FolderOpen,
  History,
  Home,
  RefreshCw,
  RotateCcw,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { DeploymentRun, WorkspacePreview } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

type WorkspaceSection =
  "project" | "deployments" | "environments" | "resources" | "settings";

const navigation = [
  { id: "project" as const, label: "项目", icon: Home },
  { id: "deployments" as const, label: "部署", icon: History },
  { id: "environments" as const, label: "环境", icon: Server },
  { id: "resources" as const, label: "资源", icon: Boxes },
  { id: "settings" as const, label: "设置", icon: Settings },
];

interface WorkspaceShellProps {
  path: string;
  workspace: WorkspacePreview;
  onDeploy: () => void;
  onForget: () => void;
  onPromote: (run: DeploymentRun) => void;
  onRollback: (environment: DeploymentRun["environment"]) => void;
  onRefresh: () => void;
  runs: DeploymentRun[];
}

export function WorkspaceShell({
  path,
  workspace,
  onDeploy,
  onForget,
  onPromote,
  onRollback,
  onRefresh,
  runs,
}: WorkspaceShellProps) {
  const [active, setActive] = useState<WorkspaceSection>("project");
  const [confirmForget, setConfirmForget] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<
    DeploymentRun["environment"] | null
  >(null);
  const [promoteTarget, setPromoteTarget] = useState<DeploymentRun | null>(
    null,
  );

  return (
    <TooltipProvider delayDuration={350}>
      <div className="grid h-full min-h-0 min-w-0 grid-rows-[58px_minmax(0,1fr)] bg-[var(--background)]">
        <header
          className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5"
          data-tauri-drag-region
        >
          <nav
            aria-label="项目工作台"
            className="flex min-w-0 items-center gap-1"
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={active === item.id ? "page" : undefined}
                  className={`flex h-8 items-center gap-2 rounded-md px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
                    active === item.id
                      ? "bg-[var(--muted)] font-medium text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="重新识别项目"
                  onClick={onRefresh}
                  size="icon"
                  variant="ghost"
                >
                  <RefreshCw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>重新识别项目</TooltipContent>
            </Tooltip>
            <Button onClick={onDeploy} size="sm">
              <Rocket />
              部署测试
            </Button>
          </div>
        </header>

        <main className="min-h-0 overflow-auto">
          <div className="mx-auto w-full max-w-[980px] px-6 py-8">
            {active === "project" ? (
              <ProjectView
                onPromote={setPromoteTarget}
                onRollback={setRollbackTarget}
                runs={runs}
                workspace={workspace}
              />
            ) : null}
            {active === "deployments" ? (
              <DeploymentsView runs={runs} workspace={workspace} />
            ) : null}
            {active === "environments" ? (
              <EnvironmentsView runs={runs} workspace={workspace} />
            ) : null}
            {active === "resources" ? <ResourcesView /> : null}
            {active === "settings" ? (
              <SettingsView
                path={path}
                onForget={() => setConfirmForget(true)}
                onRefresh={onRefresh}
              />
            ) : null}
          </div>
        </main>
      </div>

      <Dialog onOpenChange={setConfirmForget} open={confirmForget}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除这个项目？</DialogTitle>
            <DialogDescription>
              只会删除 ABCDeploy
              的本机项目记录，不会删除代码、部署文件、服务器容器或数据。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmForget(false)} variant="secondary">
              取消
            </Button>
            <Button onClick={onForget} variant="destructive">
              <Trash2 />
              移除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setRollbackTarget(null)}
        open={Boolean(rollbackTarget)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              回滚{rollbackTarget === "production" ? "生产" : "测试"}环境？
            </DialogTitle>
            <DialogDescription>
              将恢复上一健康版本的镜像摘要。数据库、运行配置、域名和其他环境不会改变；旧版本启动失败时会恢复当前版本。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setRollbackTarget(null)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={() => {
                if (rollbackTarget) onRollback(rollbackTarget);
                setRollbackTarget(null);
              }}
            >
              <RotateCcw />
              确认回滚{rollbackTarget === "production" ? "生产" : "测试"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setPromoteTarget(null)}
        open={Boolean(promoteTarget)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布到正式环境？</DialogTitle>
            <DialogDescription>
              将使用测试通过的同一组镜像摘要，生产环境仍使用自己的域名、配置和数据库。此操作不会重新构建程序。
            </DialogDescription>
          </DialogHeader>
          {promoteTarget ? (
            <div className="overflow-hidden rounded-md border border-[var(--border)] text-xs">
              <ConfirmRow
                label="候选版本"
                value={
                  promoteTarget.candidateTag ??
                  promoteTarget.commitSha?.slice(0, 12) ??
                  "待核对"
                }
              />
              <ConfirmRow
                label="镜像摘要"
                value={`${promoteTarget.artifacts.length} 个服务已逐项记录`}
              />
              <ConfirmRow label="目标" value="生产环境" />
            </div>
          ) : null}
          <DialogFooter>
            {promoteTarget?.actionUrl ? (
              <Button
                onClick={() => openUrl(promoteTarget.actionUrl ?? "")}
                variant="ghost"
              >
                <ArrowUpRight />
                打开 CNB 发布页
              </Button>
            ) : null}
            <Button onClick={() => setPromoteTarget(null)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={() => {
                if (promoteTarget) onPromote(promoteTarget);
                setPromoteTarget(null);
              }}
            >
              <Rocket />
              确认发布正式
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0">
      <span className="text-[var(--muted-foreground)]">{label}</span>
      <strong className="min-w-0 truncate font-medium">{value}</strong>
    </div>
  );
}

function ProjectView({
  onPromote,
  onRollback,
  runs,
  workspace,
}: {
  onPromote: (run: DeploymentRun) => void;
  onRollback: (environment: DeploymentRun["environment"]) => void;
  runs: DeploymentRun[];
  workspace: WorkspacePreview;
}) {
  const staging = runs.find((run) => run.environment === "staging");
  const production = runs.find((run) => run.environment === "production");
  const stagingHistory = runs.filter(
    (run) => run.environment === "staging" && run.status === "success",
  ).length;
  const productionHistory = runs.filter(
    (run) => run.environment === "production" && run.status === "success",
  ).length;
  const productionHasCandidate = Boolean(
    staging &&
    production &&
    (production.sourceRunId === staging.id ||
      sameArtifactDigests(production, staging)),
  );
  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-5">
        <div>
          <p className="m-0 text-xs font-medium text-[var(--accent)]">
            项目状态
          </p>
          <h1 className="mb-0 mt-2 text-2xl font-semibold">
            {workspace.inspection.project_name}
          </h1>
          <p className="mb-0 mt-2 text-sm text-[var(--muted-foreground)]">
            {workspace.inspection.services.length} 个服务 ·{" "}
            {workspace.inspection.package_manager}
          </p>
        </div>
        <span
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium ${
            staging?.status === "success"
              ? "bg-[var(--success-soft)] text-[var(--success)]"
              : "bg-[var(--muted)] text-[var(--muted-foreground)]"
          }`}
        >
          <CheckCircle2 className="size-4" />
          {staging?.status === "success"
            ? "测试环境运行正常"
            : "等待首次测试部署"}
        </span>
      </div>

      <section className="grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
        <EnvironmentSummary
          action={
            staging?.status === "success" && stagingHistory >= 2 ? (
              <Button
                onClick={() => onRollback("staging")}
                size="sm"
                variant="ghost"
              >
                <RotateCcw />
                回滚
              </Button>
            ) : null
          }
          description={staging?.message ?? "等待首次部署"}
          name="测试环境"
          status={runStatus(staging)}
        />
        <EnvironmentSummary
          action={
            staging?.status === "success" &&
            staging.commitSha &&
            staging.artifacts.length > 0 &&
            !productionHasCandidate ? (
              <Button
                onClick={() => onPromote(staging)}
                size="sm"
                variant="secondary"
              >
                <Rocket />
                发布生产
              </Button>
            ) : production?.status === "success" && productionHistory >= 2 ? (
              <Button
                onClick={() => onRollback("production")}
                size="sm"
                variant="ghost"
              >
                <RotateCcw />
                回滚
              </Button>
            ) : null
          }
          description={production?.message ?? "测试通过后可以发布"}
          name="生产环境"
          status={runStatus(production)}
        />
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="m-0 text-sm font-semibold">识别到的服务</h2>
          <span className="text-xs text-[var(--muted-foreground)]">
            {workspace.inspection.services.length} 项
          </span>
        </div>
        <div className="overflow-hidden border-y border-[var(--border)]">
          {workspace.inspection.services.map((service) => (
            <div
              className="flex min-h-[56px] items-center gap-3 border-b border-[var(--border)] px-2 last:border-b-0"
              key={service.id}
            >
              <Activity className="size-4 text-[var(--subtle-foreground)]" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {service.id}
                </strong>
                <span className="block truncate text-xs text-[var(--muted-foreground)]">
                  {service.path || "项目根目录"}
                </span>
              </span>
              <span className="text-xs text-[var(--muted-foreground)]">
                端口 {service.suggested_port}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function sameArtifactDigests(left: DeploymentRun, right: DeploymentRun) {
  return (
    left.artifacts.length > 0 &&
    left.artifacts.length === right.artifacts.length &&
    left.artifacts.every((artifact) =>
      right.artifacts.some(
        (candidate) =>
          candidate.service === artifact.service &&
          candidate.digest === artifact.digest,
      ),
    )
  );
}

function DeploymentsView({
  runs,
  workspace,
}: {
  runs: DeploymentRun[];
  workspace: WorkspacePreview;
}) {
  return (
    <div>
      <PageHeading
        description="每次构建和发布都会保留提交、镜像摘要、检查点与回滚结果。"
        title="部署记录"
      />
      <div className="border-y border-[var(--border)]">
        {runs.length
          ? runs.map((run) => (
              <div
                className="flex min-h-[62px] items-center gap-3 border-b border-[var(--border)] px-2 last:border-b-0"
                key={run.id}
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-full ${
                    run.status === "success"
                      ? "bg-[var(--success-soft)] text-[var(--success)]"
                      : run.status === "failed" || run.status === "needs_action"
                        ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                        : "bg-[var(--accent-soft)] text-[var(--accent)]"
                  }`}
                >
                  {run.status === "success" ? (
                    <CheckCircle2 className="size-4" />
                  ) : (
                    <Activity className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">
                    {run.environment === "production" ? "生产发布" : "测试部署"}
                  </strong>
                  <span className="block truncate text-xs text-[var(--muted-foreground)]">
                    {run.issueCode ? `${run.issueCode} · ` : ""}
                    {run.message}
                  </span>
                </span>
                <span className="text-xs text-[var(--subtle-foreground)]">
                  {new Date(run.startedAt).toLocaleString("zh-CN")}
                </span>
              </div>
            ))
          : workspace.plan.steps.map((step, index) => (
              <div
                className="flex min-h-[62px] items-center gap-3 border-b border-[var(--border)] px-2 last:border-b-0"
                key={step.id}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--muted)] text-xs font-medium text-[var(--muted-foreground)]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">
                    {step.title}
                  </strong>
                  <span className="block truncate text-xs text-[var(--muted-foreground)]">
                    {step.detail}
                  </span>
                </span>
                <span className="text-xs text-[var(--subtle-foreground)]">
                  等待首次运行
                </span>
              </div>
            ))}
      </div>
    </div>
  );
}

function EnvironmentsView({
  runs,
  workspace,
}: {
  runs: DeploymentRun[];
  workspace: WorkspacePreview;
}) {
  return (
    <div>
      <PageHeading
        description="环境使用各自的域名、变量和数据，程序版本通过同一个镜像摘要晋级。"
        title="环境"
      />
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {workspace.plan.environments.map((environment) => (
          <div
            className="grid min-h-[72px] grid-cols-[140px_1fr_120px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0 max-sm:grid-cols-[1fr_auto]"
            key={environment.name}
          >
            <strong className="text-sm font-medium">
              {environmentLabel(environment.name)}
            </strong>
            <span className="truncate text-xs text-[var(--muted-foreground)] max-sm:hidden">
              {environment.target}
            </span>
            <span className="text-right text-xs text-[var(--muted-foreground)]">
              {environment.name !== "development" &&
              runs.find((run) => run.environment === environment.name)
                ? runStatus(
                    runs.find((run) => run.environment === environment.name),
                  )
                : environment.approval_required
                  ? "发布前确认"
                  : environment.automatic
                    ? "自动更新"
                    : "本机运行"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResourcesView() {
  return (
    <div>
      <PageHeading
        description="账号和服务器属于这台电脑的全局资源，新项目可以安全复用。"
        title="资源"
      />
      <div className="border-y border-[var(--border)]">
        <ResourceRow
          icon={Cloud}
          label="CNB 构建账号"
          status="已保存在系统密钥库"
        />
        <ResourceRow
          icon={Server}
          label="目标服务器"
          status="首次部署前重新验证"
        />
        <ResourceRow
          icon={ShieldCheck}
          label="Caddy 与 HTTPS"
          status="由服务器统一管理"
        />
      </div>
    </div>
  );
}

function SettingsView({
  onForget,
  onRefresh,
  path,
}: {
  onForget: () => void;
  onRefresh: () => void;
  path: string;
}) {
  return (
    <div>
      <PageHeading
        description="调整项目记录和重新识别，不在这里暴露原始密钥。"
        title="项目设置"
      />
      <div className="space-y-5">
        <div>
          <span className="mb-1 block text-xs font-medium">本机目录</span>
          <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <FolderOpen className="size-4 shrink-0 text-[var(--muted-foreground)]" />
            <code className="min-w-0 flex-1 truncate text-xs">{path}</code>
            <Button onClick={onRefresh} size="sm" variant="ghost">
              <RefreshCw />
              重新识别
            </Button>
          </div>
        </div>
        <div className="border-t border-[var(--border)] pt-5">
          <h2 className="m-0 text-sm font-semibold text-[var(--destructive)]">
            移除项目记录
          </h2>
          <p className="mb-3 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            不删除代码和服务器数据，只让 ABCDeploy 忘记这个本机项目。
          </p>
          <Button onClick={onForget} size="sm" variant="destructive">
            <Trash2 />
            移除项目
          </Button>
        </div>
      </div>
    </div>
  );
}

function EnvironmentSummary({
  action,
  description,
  name,
  status,
}: {
  action?: React.ReactNode;
  description: string;
  name: string;
  status: string;
}) {
  return (
    <div className="bg-[var(--surface)] p-5">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm font-medium">{name}</strong>
        {action ?? (
          <span className="text-xs text-[var(--success)]">{status}</span>
        )}
      </div>
      <p className="mb-0 mt-2 text-xs text-[var(--muted-foreground)]">
        {description}
      </p>
    </div>
  );
}

function runStatus(run: DeploymentRun | undefined) {
  if (!run) return "尚未部署";
  return {
    queued: "等待资源",
    running: "部署中",
    needs_action: "需要处理",
    success: "运行正常",
    failed: "部署失败",
    cancelled: "已取消",
  }[run.status];
}

function ResourceRow({
  icon: Icon,
  label,
  status,
}: {
  icon: typeof Cloud;
  label: string;
  status: string;
}) {
  return (
    <div className="flex min-h-[62px] items-center gap-3 border-b border-[var(--border)] px-2 last:border-b-0">
      <Icon className="size-4 text-[var(--muted-foreground)]" />
      <strong className="min-w-0 flex-1 text-sm font-medium">{label}</strong>
      <span className="text-xs text-[var(--muted-foreground)]">{status}</span>
      <ArrowUpRight className="size-4 text-[var(--subtle-foreground)]" />
    </div>
  );
}

function PageHeading({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="mb-7">
      <h1 className="m-0 text-xl font-semibold">{title}</h1>
      <p className="mb-0 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        {description}
      </p>
    </div>
  );
}

function environmentLabel(value: string) {
  return (
    { development: "开发环境", staging: "测试环境", production: "生产环境" }[
      value
    ] ?? value
  );
}
