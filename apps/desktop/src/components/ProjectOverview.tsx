import {
  Boxes,
  CheckCircle2,
  FileKey2,
  Layers3,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { Framework, WorkspacePreview } from "../types";

const frameworkNames: Record<Framework, string> = {
  nest_js: "NestJS",
  next_js: "Next.js",
  vite: "Vite",
  uni_app: "UniApp",
  taro: "Taro",
  prisma: "Prisma",
  pnpm_workspace: "pnpm workspace",
};

interface ProjectOverviewProps {
  workspace: WorkspacePreview;
}

export function ProjectOverview({ workspace }: ProjectOverviewProps) {
  const { inspection } = workspace;
  const secretCount = inspection.environment_variables.filter(
    (variable) => variable.secret,
  ).length;
  const uniqueFrameworks = Array.from(
    new Set(inspection.frameworks.map((item) => item.framework)),
  );

  return (
    <div className="content-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">项目识别</span>
          <h1>{inspection.project_name}</h1>
          <p className="path-line" title={inspection.project_root}>
            {inspection.project_root}
          </p>
        </div>
        <div className="heading-status success">
          <CheckCircle2 size={18} />
          <span>只读识别完成</span>
        </div>
      </header>

      <section className="metric-strip" aria-label="项目摘要">
        <div>
          <Boxes size={18} />
          <strong>{inspection.services.length}</strong>
          <span>可部署服务</span>
        </div>
        <div>
          <Layers3 size={18} />
          <strong>{uniqueFrameworks.length}</strong>
          <span>技术能力</span>
        </div>
        <div>
          <FileKey2 size={18} />
          <strong>{inspection.environment_variables.length}</strong>
          <span>环境变量</span>
        </div>
        <div>
          <ShieldCheck size={18} />
          <strong>{secretCount}</strong>
          <span>敏感变量名</span>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>识别到的服务</h2>
            <p>镜像会分别构建，运行时共享环境级网络。</p>
          </div>
        </div>
        <div className="data-table service-table">
          <div className="table-row table-head">
            <span>服务</span>
            <span>框架</span>
            <span>项目路径</span>
            <span>容器端口</span>
            <span>Dockerfile</span>
          </div>
          {inspection.services.map((service) => (
            <div className="table-row" key={`${service.path}-${service.id}`}>
              <span className="service-name">
                <strong>{service.id}</strong>
                <small>{service.kind}</small>
              </span>
              <span>
                <span className="tag neutral">
                  {frameworkNames[service.framework]}
                </span>
              </span>
              <span className="mono truncate" title={service.path}>
                {service.path}
              </span>
              <span className="mono">{service.suggested_port}</span>
              <span className={service.dockerfile ? "file-ok" : "file-pending"}>
                {service.dockerfile ? "已存在" : "待生成"}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="content-section split-section">
        <div>
          <div className="section-heading">
            <div>
              <h2>技术识别</h2>
              <p>基于依赖、脚本和文件结构确定。</p>
            </div>
          </div>
          <div className="framework-list">
            {uniqueFrameworks.map((framework) => {
              const best = inspection.frameworks
                .filter((item) => item.framework === framework)
                .sort((left, right) => right.confidence - left.confidence)[0];
              return (
                <div className="framework-item" key={framework}>
                  <span>{frameworkNames[framework]}</span>
                  <strong>{best?.confidence ?? 0}%</strong>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="section-heading">
            <div>
              <h2>识别结果</h2>
              <p>敏感变量只记录名称，不读取值。</p>
            </div>
          </div>
          <div className="result-list">
            <div className="result-line success">
              <CheckCircle2 size={17} />
              <span>{inspection.dockerfiles.length} 个 Dockerfile 可复用</span>
            </div>
            <div className="result-line success">
              <CheckCircle2 size={17} />
              <span>{inspection.prisma_schemas.length} 个 Prisma Schema</span>
            </div>
            {inspection.diagnostics.map((diagnostic) => (
              <div
                className={`result-line ${diagnostic.level}`}
                key={`${diagnostic.code}-${diagnostic.path ?? "root"}`}
              >
                <TriangleAlert size={17} />
                <span>{diagnostic.message}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
