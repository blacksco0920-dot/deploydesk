import {
  Check,
  ChevronRight,
  CloudUpload,
  GitCommitHorizontal,
  Laptop,
  RotateCcw,
  Server,
  ShieldCheck,
} from "lucide-react";
import type { WorkspacePreview } from "../../types";

export function RecommendationStep({
  workspace,
}: {
  workspace: WorkspacePreview;
}) {
  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <CloudUpload className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">推荐方案已经准备好</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        先自动部署测试环境，确认正常后再发布同一个镜像到生产，避免上线未经验证的代码。
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-[var(--accent)]" />
            适合第一次部署的稳妥方案
          </span>
          <span className="rounded-md bg-[var(--accent-soft)] px-2 py-1 text-xs font-medium text-[var(--accent)]">
            推荐
          </span>
        </div>
        <PlanRow
          description="改代码和调试都留在本机，不影响线上服务"
          icon={Laptop}
          title="开发环境在这台电脑"
        />
        <PlanRow
          description="main 的每次稳定更新只构建一个不可变镜像"
          icon={GitCommitHorizontal}
          title="代码只构建一次"
        />
        <PlanRow
          description={`自动启动 ${workspace.inspection.services.length} 个服务并完成健康检查`}
          icon={Server}
          title="先部署测试环境"
        />
        <PlanRow
          description="测试通过后由你确认，不重新构建生产镜像"
          icon={CloudUpload}
          title="同一版本晋级生产"
        />
        <PlanRow
          description="健康检查失败时恢复上一个正常版本，数据不会自动删除"
          icon={RotateCcw}
          title="发布失败可以回退"
          last
        />
      </section>

      <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-[var(--muted-foreground)]">
        <Check className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
        测试和生产拥有各自的域名、数据库、变量和存储，只复用已经验证过的程序镜像。
      </div>

      <details className="group mt-4 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-[var(--muted-foreground)] outline-none hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          调整分支、自动发布和服务器隔离方式
        </summary>
        <div className="mt-2 border-l border-[var(--border)] pl-5 text-xs leading-6 text-[var(--muted-foreground)]">
          高级配置会保留在项目工作台中。首次部署先采用推荐值，部署前仍会展示所有实际文件和远程操作。
        </div>
      </details>
    </div>
  );
}

function PlanRow({
  description,
  icon: Icon,
  last = false,
  title,
}: {
  description: string;
  icon: typeof Laptop;
  last?: boolean;
  title: string;
}) {
  return (
    <div
      className={`flex min-h-[64px] items-center gap-3 px-4 ${
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
      <Check className="size-4 shrink-0 text-[var(--success)]" />
    </div>
  );
}
