import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Rocket,
} from "lucide-react";
import type { DeploymentRun } from "../../types";
import { Button } from "../ui/button";

const stages = [
  { key: "write-config", active: "prepare", title: "准备部署配置" },
  { key: "verify-build", active: "build", title: "验证并构建程序" },
  { key: "publish-images", active: "publish", title: "上传不可变镜像" },
  { key: "prepare-server", active: "prepare-server", title: "准备目标服务器" },
  { key: "deploy", active: "deploy", title: "启动目标环境" },
  { key: "healthcheck", active: "healthcheck", title: "运行健康检查" },
];

interface DeploymentProgressProps {
  run: DeploymentRun;
  onRefresh: () => void;
  onRetry: () => void;
  onWorkspace: () => void;
}

export function DeploymentProgress({
  run,
  onRefresh,
  onRetry,
  onWorkspace,
}: DeploymentProgressProps) {
  const failed = run.status === "failed" || run.status === "needs_action";
  const success = run.status === "success";

  return (
    <div>
      <span
        className={`mb-4 grid size-10 place-items-center rounded-lg ${
          failed
            ? "bg-[var(--warning-soft)] text-[var(--warning)]"
            : success
              ? "bg-[var(--success-soft)] text-[var(--success)]"
              : "bg-[var(--accent-soft)] text-[var(--accent)]"
        }`}
      >
        {failed ? (
          <AlertTriangle className="size-5" />
        ) : success ? (
          <CheckCircle2 className="size-5" />
        ) : (
          <Rocket className="size-5" />
        )}
      </span>
      <h1 className="m-0 text-2xl font-semibold">
        {failed
          ? "部署在一个可恢复的步骤暂停了"
          : success
            ? run.environment === "production"
              ? "生产环境发布完成"
              : "测试环境已经可以使用"
            : run.environment === "production"
              ? "正在发布生产环境"
              : "正在部署测试环境"}
      </h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        {run.message}
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {stages.map((stage, index) => {
          const completed = run.completedSteps.includes(stage.key) || success;
          const active =
            !completed && run.currentStage === stage.active && !failed;
          const stopped =
            !completed && run.currentStage === stage.active && failed;
          return (
            <div
              className="relative flex min-h-[58px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0"
              key={stage.key}
            >
              {index < stages.length - 1 ? (
                <span className="absolute bottom-[-14px] left-[29px] top-[42px] z-0 w-px bg-[var(--border)]" />
              ) : null}
              <span
                className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full border ${
                  completed
                    ? "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]"
                    : active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : stopped
                        ? "border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--subtle-foreground)]"
                }`}
              >
                {completed ? (
                  <Check className="size-3.5" />
                ) : active ? (
                  <LoaderCircle className="size-3.5 animate-spin-slow" />
                ) : stopped ? (
                  <AlertTriangle className="size-3.5" />
                ) : (
                  <Clock3 className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm font-medium">
                  {stage.title}
                </strong>
                <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                  {completed
                    ? "已完成"
                    : active
                      ? "正在执行"
                      : stopped
                        ? "需要处理"
                        : "等待中"}
                </span>
              </span>
            </div>
          );
        })}
      </section>

      <div className="mt-5 flex items-center justify-between gap-3">
        <details className="group text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-xs text-[var(--muted-foreground)] outline-none hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            技术详情
          </summary>
          <div className="mt-1 space-y-1 border-l border-[var(--border)] pl-5 text-[11px] leading-5 text-[var(--muted-foreground)]">
            <p className="m-0">CNB 仓库：{run.repository}</p>
            <p className="m-0">发布分支：{run.branch}</p>
            <p className="m-0">
              构建编号：{run.buildSerial ?? "等待 CNB 返回"}
            </p>
            <p className="m-0">
              提交版本：{run.commitSha?.slice(0, 12) ?? "等待 CNB 返回"}
            </p>
          </div>
        </details>
        <div className="flex items-center gap-2">
          {failed ? (
            <Button onClick={onRetry} variant="secondary">
              <RefreshCw />
              {run.actionKind === "route-check"
                ? "重新检查域名与 HTTPS"
                : "从失败步骤重试"}
            </Button>
          ) : null}
          {!failed && !success ? (
            <Button onClick={onRefresh} variant="secondary">
              <RefreshCw />
              刷新状态
            </Button>
          ) : null}
          {success ? (
            <Button onClick={onWorkspace}>
              进入项目工作台
              <ChevronRight />
            </Button>
          ) : null}
        </div>
      </div>

      {!success ? (
        <p className="mt-6 text-xs leading-5 text-[var(--muted-foreground)]">
          可以关闭 ABCDeploy。CNB
          和服务器会继续执行，重新打开后将恢复到这次部署。
        </p>
      ) : null}
    </div>
  );
}
