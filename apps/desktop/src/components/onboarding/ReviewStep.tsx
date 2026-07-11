import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  FileCode2,
  LoaderCircle,
  Rocket,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { UserFacingIssue, WorkspacePreview } from "../../types";
import { Button } from "../ui/button";

interface ReviewStepProps {
  applying: boolean;
  issue: UserFacingIssue | null;
  onApply: () => Promise<void>;
  onBackToConnections: () => void;
  workspace: WorkspacePreview;
}

export function ReviewStep({
  applying,
  issue,
  onApply,
  onBackToConnections,
  workspace,
}: ReviewStepProps) {
  const [confirmed, setConfirmed] = useState(false);
  const changed = useMemo(
    () =>
      workspace.plan.changes.filter((change) => change.kind !== "unchanged"),
    [workspace.plan.changes],
  );

  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <Rocket className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">确认首次部署会做什么</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        默认只准备并部署测试环境，不会发布生产，也不会删除现有容器、目录、数据库或域名记录。
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <SummaryRow
          description={`新增或更新 ${changed.length} 个部署文件，原文件自动备份`}
          icon={FileCode2}
          status="即将执行"
          title="写入项目部署配置"
        />
        <SummaryRow
          description="检查 Docker、共享网络和 Caddy，不接管无关服务"
          icon={Server}
          status="即将执行"
          title="准备目标服务器"
        />
        <SummaryRow
          description={`构建 ${workspace.inspection.services.length} 个服务并等待健康检查`}
          icon={Rocket}
          status="即将执行"
          title="启动测试环境"
        />
        <SummaryRow
          description="生产环境保持不变，需要你以后单独确认发布"
          icon={ShieldCheck}
          last
          status="保持不变"
          title="不自动发布生产"
        />
      </section>

      {workspace.plan.warnings.length ? (
        <div className="mt-4 space-y-2">
          {workspace.plan.warnings.map((warning) => (
            <div
              className="flex items-start gap-2 rounded-md bg-[var(--warning-soft)] px-3 py-2.5 text-xs leading-5 text-[var(--warning)]"
              key={warning}
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {issue ? (
        <section
          className="mt-4 border-l-2 border-[var(--warning)] bg-[var(--warning-soft)] px-4 py-3.5"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--warning)]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-sm font-semibold">{issue.title}</strong>
                <code className="text-[11px] font-semibold text-[var(--warning)]">
                  错误码 {issue.code}
                </code>
              </div>
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--foreground)]">
                {issue.message}
              </p>
              <strong className="mt-3 block text-xs font-semibold">
                接下来这样处理
              </strong>
              <ol className="mb-0 mt-1 space-y-1 pl-5 text-xs leading-5 text-[var(--muted-foreground)]">
                {issue.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {issue.technicalDetails.length ? (
                <details className="mt-2 text-[11px] text-[var(--muted-foreground)]">
                  <summary className="cursor-pointer">技术详情</summary>
                  <pre className="mb-0 mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-5">
                    {issue.technicalDetails.join("\n")}
                  </pre>
                </details>
              ) : null}
              <Button
                className="mt-3"
                onClick={onBackToConnections}
                size="sm"
                variant="secondary"
              >
                <ArrowLeft />
                返回检查服务器
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <details className="group mt-5 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-[var(--muted-foreground)] outline-none hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          查看文件变化和技术步骤
        </summary>
        <div className="mt-2 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
          {workspace.plan.changes.map((change) => (
            <div
              className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0"
              key={change.path}
            >
              <FileCode2 className="size-4 text-[var(--muted-foreground)]" />
              <code className="min-w-0 flex-1 truncate text-xs">
                {change.path}
              </code>
              <span className="text-xs text-[var(--muted-foreground)]">
                {change.kind === "create"
                  ? "新增"
                  : change.kind === "update"
                    ? "更新"
                    : "不变"}
              </span>
            </div>
          ))}
        </div>
      </details>

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3.5">
        <input
          checked={confirmed}
          className="mt-0.5 size-4 accent-[var(--accent)]"
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong className="block text-sm font-medium">
            我已查看本次变更
          </strong>
          <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
            允许写入部署文件并开始准备测试环境；可恢复的步骤失败后会从检查点继续。
          </span>
        </span>
      </label>

      <div className="mt-5 flex justify-end">
        <Button
          disabled={!confirmed || applying || !changed.length}
          onClick={onApply}
          size="lg"
        >
          {applying ? (
            <LoaderCircle className="animate-spin-slow" />
          ) : (
            <Rocket />
          )}
          {applying
            ? "正在准备首次部署"
            : issue
              ? "重新检查并继续"
              : "开始部署测试"}
        </Button>
      </div>
    </div>
  );
}

function SummaryRow({
  description,
  icon: Icon,
  last = false,
  status,
  title,
}: {
  description: string;
  icon: typeof Rocket;
  last?: boolean;
  status: string;
  title: string;
}) {
  return (
    <div
      className={`flex min-h-[65px] items-center gap-3 px-4 ${
        last ? "" : "border-b border-[var(--border)]"
      }`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-medium">{title}</strong>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--muted-foreground)]">
          {description}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
        {status}
      </span>
    </div>
  );
}
