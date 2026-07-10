import {
  Check,
  Cloud,
  GitBranch,
  HardDrive,
  Laptop,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { parseDocument } from "yaml";
import { useEffect, useState } from "react";
import type { WorkspacePreview } from "../types";

interface EnvironmentEditorProps {
  workspace: WorkspacePreview;
  saving: boolean;
  onSave: (manifestYaml: string) => Promise<void>;
}

interface Draft {
  integrationBranch: string;
  stableBranch: string;
  stagingServer: string;
  productionServer: string;
  stagingDomains: Record<string, string>;
  productionDomains: Record<string, string>;
  stagingSecretsRef: string;
  productionSecretsRef: string;
  productionMode: "automatic" | "approval";
}

export function EnvironmentEditor({
  workspace,
  saving,
  onSave,
}: EnvironmentEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => readDraft(workspace));

  useEffect(() => {
    setDraft(readDraft(workspace));
  }, [workspace]);

  async function save() {
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(["source", "integration_branch"], draft.integrationBranch);
    document.setIn(["source", "stable_branch"], draft.stableBranch);
    document.setIn(
      ["environments", "staging", "branch"],
      draft.integrationBranch,
    );
    document.setIn(
      ["environments", "production", "branch"],
      draft.stableBranch,
    );
    document.setIn(
      ["environments", "staging", "target", "server"],
      draft.stagingServer,
    );
    document.setIn(
      ["environments", "production", "target", "server"],
      draft.productionServer,
    );
    document.setIn(
      ["environments", "staging", "domains"],
      domainRoutes(draft.stagingDomains),
    );
    document.setIn(
      ["environments", "production", "domains"],
      domainRoutes(draft.productionDomains),
    );
    document.setIn(
      ["environments", "staging", "secrets_ref"],
      draft.stagingSecretsRef,
    );
    document.setIn(
      ["environments", "production", "secrets_ref"],
      draft.productionSecretsRef,
    );
    document.setIn(["release", "production_mode"], draft.productionMode);
    document.setIn(
      ["environments", "production", "approval_required"],
      draft.productionMode === "approval",
    );
    document.setIn(
      ["environments", "production", "auto_deploy"],
      draft.productionMode === "automatic",
    );
    await onSave(document.toString({ lineWidth: 0 }));
  }

  return (
    <div className="content-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">环境配置</span>
          <h1>开发、测试和生产</h1>
          <p>环境独立保存服务器、域名、数据库、密钥和发布版本。</p>
        </div>
        <button
          className="primary-action"
          disabled={saving}
          onClick={save}
          type="button"
        >
          <RefreshCw className={saving ? "spin" : ""} size={17} />
          {saving ? "正在更新计划" : "更新部署计划"}
        </button>
      </header>

      <section className="environment-list">
        <article className="environment-row">
          <div className="environment-title">
            <span className="environment-icon local">
              <Laptop size={19} />
            </span>
            <div>
              <h2>开发环境</h2>
              <span>development</span>
            </div>
          </div>
          <div className="environment-fields development-fields">
            <label>
              运行位置
              <span className="readonly-field">
                <HardDrive size={16} /> 本机
              </span>
            </label>
            <label>
              开发方式
              <span className="readonly-field">热更新 + 共享基础设施</span>
            </label>
          </div>
          <div className="environment-policy">
            <span className="policy-state neutral">
              <Check size={15} /> 不自动发布
            </span>
          </div>
        </article>

        <article className="environment-row">
          <div className="environment-title">
            <span className="environment-icon staging">
              <Server size={19} />
            </span>
            <div>
              <h2>测试环境</h2>
              <span>staging</span>
            </div>
          </div>
          <div className="environment-fields">
            <label>
              触发分支
              <span className="input-with-icon">
                <GitBranch size={16} />
                <input
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      integrationBranch: event.target.value,
                    })
                  }
                  value={draft.integrationBranch}
                />
              </span>
            </label>
            <label>
              逻辑服务器
              <input
                onChange={(event) =>
                  setDraft({ ...draft, stagingServer: event.target.value })
                }
                value={draft.stagingServer}
              />
            </label>
          </div>
          <div className="domain-grid">
            {workspace.inspection.services.map((service) => (
              <label key={`staging-${service.id}`}>
                {service.id} 域名
                <input
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      stagingDomains: {
                        ...draft.stagingDomains,
                        [service.id]: event.target.value,
                      },
                    })
                  }
                  placeholder={`${service.id}.test.example.com`}
                  value={draft.stagingDomains[service.id] ?? ""}
                />
              </label>
            ))}
            <label className="field-wide">
              CNB 密钥文件
              <input
                onChange={(event) =>
                  setDraft({ ...draft, stagingSecretsRef: event.target.value })
                }
                placeholder="https://cnb.cool/组织/密钥仓库/-/blob/main/env.staging.yml"
                value={draft.stagingSecretsRef}
              />
            </label>
          </div>
          <div className="environment-policy">
            <span className="policy-state success">
              <Check size={15} /> 推送后自动部署
            </span>
          </div>
        </article>

        <article className="environment-row production-row">
          <div className="environment-title">
            <span className="environment-icon production">
              <Cloud size={19} />
            </span>
            <div>
              <h2>生产环境</h2>
              <span>production</span>
            </div>
          </div>
          <div className="environment-fields">
            <label>
              稳定分支
              <span className="input-with-icon">
                <GitBranch size={16} />
                <input
                  onChange={(event) =>
                    setDraft({ ...draft, stableBranch: event.target.value })
                  }
                  value={draft.stableBranch}
                />
              </span>
            </label>
            <label>
              逻辑服务器
              <input
                onChange={(event) =>
                  setDraft({ ...draft, productionServer: event.target.value })
                }
                value={draft.productionServer}
              />
            </label>
          </div>
          <div className="domain-grid">
            {workspace.inspection.services.map((service) => (
              <label key={`production-${service.id}`}>
                {service.id} 域名
                <input
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      productionDomains: {
                        ...draft.productionDomains,
                        [service.id]: event.target.value,
                      },
                    })
                  }
                  placeholder={`${service.id}.example.com`}
                  value={draft.productionDomains[service.id] ?? ""}
                />
              </label>
            ))}
            <label className="field-wide">
              CNB 密钥文件
              <input
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    productionSecretsRef: event.target.value,
                  })
                }
                placeholder="https://cnb.cool/组织/密钥仓库/-/blob/main/env.production.yml"
                value={draft.productionSecretsRef}
              />
            </label>
          </div>
          <div className="production-mode">
            <span>发布方式</span>
            <div className="segmented-control">
              <button
                className={
                  draft.productionMode === "approval" ? "selected" : ""
                }
                onClick={() =>
                  setDraft({ ...draft, productionMode: "approval" })
                }
                type="button"
              >
                <ShieldCheck size={15} /> 审批发布
              </button>
              <button
                className={
                  draft.productionMode === "automatic" ? "selected" : ""
                }
                onClick={() =>
                  setDraft({ ...draft, productionMode: "automatic" })
                }
                type="button"
              >
                <Check size={15} /> 自动发布
              </button>
            </div>
          </div>
        </article>
      </section>

      <section className="isolation-summary">
        <ShieldCheck size={20} />
        <div>
          <strong>隔离规则已启用</strong>
          <span>测试与生产使用不同命名空间、数据库、密钥文件和发布记录。</span>
        </div>
      </section>
    </div>
  );
}

function readDraft(workspace: WorkspacePreview): Draft {
  const document = parseDocument(workspace.manifestYaml);
  const manifest = document.toJS() as Record<string, any>;
  return {
    integrationBranch: manifest.source?.integration_branch ?? "test",
    stableBranch: manifest.source?.stable_branch ?? "main",
    stagingServer:
      manifest.environments?.staging?.target?.server ?? "staging-server",
    productionServer:
      manifest.environments?.production?.target?.server ??
      "production-server",
    stagingDomains: routesToRecord(
      manifest.environments?.staging?.domains ?? [],
    ),
    productionDomains: routesToRecord(
      manifest.environments?.production?.domains ?? [],
    ),
    stagingSecretsRef:
      manifest.environments?.staging?.secrets_ref ??
      "https://cnb.cool/replace-me/secret/-/blob/main/env.staging.yml",
    productionSecretsRef:
      manifest.environments?.production?.secrets_ref ??
      "https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
    productionMode: manifest.release?.production_mode ?? "approval",
  };
}

function routesToRecord(
  routes: Array<{ service?: string; host?: string }>,
): Record<string, string> {
  return Object.fromEntries(
    routes
      .filter((route) => route.service && route.host)
      .map((route) => [route.service as string, route.host as string]),
  );
}

function domainRoutes(domains: Record<string, string>) {
  return Object.entries(domains)
    .filter(([, host]) => host.trim())
    .map(([service, host]) => ({ service, host: host.trim(), path: "/" }));
}
