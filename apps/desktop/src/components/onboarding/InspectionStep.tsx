import {
  Boxes,
  CheckCircle2,
  ChevronRight,
  Database,
  FileKey2,
  ScanSearch,
} from "lucide-react";
import type { Framework, WorkspacePreview } from "../../types";

const frameworkNames: Record<Framework, string> = {
  nest_js: "NestJS",
  next_js: "Next.js",
  vite: "Vite",
  uni_app: "UniApp",
  taro: "Taro",
  prisma: "Prisma",
  pnpm_workspace: "pnpm 工作区",
};

export function InspectionStep({ workspace }: { workspace: WorkspacePreview }) {
  const { inspection } = workspace;
  const secretCount = inspection.environment_variables.filter(
    (variable) => variable.secret,
  ).length;

  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <ScanSearch className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">项目结构已经识别完成</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        发现 {inspection.services.length}{" "}
        个可部署服务。系统只读取了文件结构和变量名称，没有读取任何密钥值。
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {inspection.services.map((service) => (
          <div
            className="flex min-h-[66px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0"
            key={`${service.path}-${service.id}`}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]">
              <Boxes className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm font-medium">
                {service.id}
              </strong>
              <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">
                {frameworkNames[service.framework]} ·{" "}
                {service.path || "项目根目录"}
              </span>
            </span>
            <span className="text-xs text-[var(--subtle-foreground)]">
              {service.kind === "api" ? "接口服务" : "网页服务"}
            </span>
            <CheckCircle2 className="size-4 text-[var(--success)]" />
          </div>
        ))}
      </section>

      <div className="mt-5 grid grid-cols-3 divide-x divide-[var(--border)] border-y border-[var(--border)] py-4">
        <Summary
          icon={Database}
          label="数据库结构"
          value={inspection.prisma_schemas.length}
        />
        <Summary
          icon={FileKey2}
          label="环境变量"
          value={inspection.environment_variables.length}
        />
        <Summary icon={FileKey2} label="敏感变量" value={secretCount} />
      </div>

      <details className="group mt-5 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-[var(--muted-foreground)] outline-none hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          查看识别依据和技术细节
        </summary>
        <div className="mt-2 space-y-2 border-l border-[var(--border)] pl-5 text-xs leading-6 text-[var(--muted-foreground)]">
          {inspection.frameworks.map((item) => (
            <p className="m-0" key={`${item.framework}-${item.path}`}>
              <strong className="text-[var(--foreground)]">
                {frameworkNames[item.framework]}
              </strong>
              {` · ${item.confidence}% · ${item.evidence.join("，")}`}
            </p>
          ))}
          {!inspection.frameworks.length ? (
            <p className="m-0">未识别到已知框架。</p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Boxes;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-center gap-2 px-2">
      <Icon className="size-4 text-[var(--subtle-foreground)]" />
      <span className="text-sm font-medium">{value}</span>
      <span className="hidden text-xs text-[var(--muted-foreground)] sm:inline">
        {label}
      </span>
    </div>
  );
}
