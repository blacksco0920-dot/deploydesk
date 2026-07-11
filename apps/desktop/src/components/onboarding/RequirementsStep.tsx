import {
  CheckCircle2,
  FileCode2,
  Globe2,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseDocument } from "yaml";
import { loadRuntimeConfig, storeRuntimeConfig } from "../../api";
import type { RuntimeConfigFile, WorkspacePreview } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface RequirementsStepProps {
  onError: (message: string) => void;
  onReadinessChange: (ready: boolean) => void;
  onUpdate: (manifestYaml: string) => Promise<boolean>;
  saving: boolean;
  workspace: WorkspacePreview;
}

type DeployEnvironment = RuntimeConfigFile["environment"];

const environments: Array<{ id: DeployEnvironment; label: string }> = [
  { id: "staging", label: "测试" },
  { id: "production", label: "生产" },
];

export function RequirementsStep({
  onError,
  onReadinessChange,
  onUpdate,
  saving,
  workspace,
}: RequirementsStepProps) {
  const publicServices = useMemo(
    () =>
      workspace.inspection.services.filter(
        (service) => service.kind !== "worker",
      ),
    [workspace.inspection.services],
  );
  const initialDomains = useMemo(
    () =>
      readDomains(
        workspace.manifestYaml,
        publicServices.map((service) => service.id),
      ),
    [publicServices, workspace.manifestYaml],
  );
  const [domains, setDomains] = useState(initialDomains);

  useEffect(() => setDomains(initialDomains), [initialDomains]);

  async function saveDomains() {
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", "staging", "domains"],
      publicServices
        .filter((service) => domains.staging[service.id]?.trim())
        .map((service) => ({
          service: service.id,
          host: domains.staging[service.id].trim(),
          path: "/",
        })),
    );
    document.setIn(
      ["environments", "production", "domains"],
      publicServices
        .filter((service) => domains.production[service.id]?.trim())
        .map((service) => ({
          service: service.id,
          host: domains.production[service.id].trim(),
          path: "/",
        })),
    );
    await onUpdate(document.toString({ lineWidth: 0 }));
  }

  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <Globe2 className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">只补充系统无法知道的信息</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        域名可以稍后补充。测试与生产各自使用一份完整配置文件，并安全保存在系统密钥库。
      </p>

      <section className="border-y border-[var(--border)] py-5">
        <SectionHeading
          description="Caddy 会在解析生效后自动申请 HTTPS。"
          icon={Globe2}
          title="访问域名"
        />
        <div className="space-y-4 pl-7">
          {publicServices.map((service) => (
            <div className="grid gap-3 sm:grid-cols-2" key={service.id}>
              <label className="space-y-1.5">
                <span className="text-xs font-medium">
                  {service.id} 测试域名
                </span>
                <Input
                  onChange={(event) =>
                    setDomains((current) => ({
                      ...current,
                      staging: {
                        ...current.staging,
                        [service.id]: event.target.value,
                      },
                    }))
                  }
                  placeholder="可暂时留空"
                  value={domains.staging[service.id] ?? ""}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium">
                  {service.id} 正式域名
                </span>
                <Input
                  onChange={(event) =>
                    setDomains((current) => ({
                      ...current,
                      production: {
                        ...current.production,
                        [service.id]: event.target.value,
                      },
                    }))
                  }
                  placeholder="例如 app.example.com"
                  value={domains.production[service.id] ?? ""}
                />
              </label>
            </div>
          ))}
          <div className="flex justify-end">
            <Button
              disabled={saving}
              onClick={saveDomains}
              size="sm"
              variant="secondary"
            >
              {saving ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Save />
              )}
              保存域名
            </Button>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)] py-5">
        <SectionHeading
          description="直接编辑完整文件，项目中的注释、自定义字段和高级配置都会保留。"
          icon={KeyRound}
          title="项目运行配置文件"
        />
        <div className="pl-7">
          <div className="mb-4 grid gap-4 border-l-2 border-[var(--accent)] pl-4 sm:grid-cols-2">
            <div>
              <strong className="text-xs font-semibold">
                这个文件有什么用
              </strong>
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                容器启动时用它连接数据库、缓存和第三方服务，也可设置端口、功能开关等运行参数。
              </p>
            </div>
            <div>
              <strong className="text-xs font-semibold">
                什么时候需要修改
              </strong>
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                首次部署、测试与生产参数不同，或更换 API
                密钥、服务地址和业务配置时修改。
              </p>
            </div>
          </div>
          <RuntimeConfigEditor
            onError={onError}
            onReadinessChange={onReadinessChange}
            path={workspace.inspection.project_root}
          />
        </div>
      </section>
    </div>
  );
}

function SectionHeading({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Globe2;
  title: string;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <Icon className="mt-0.5 size-4 text-[var(--muted-foreground)]" />
      <div>
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
          {description}
        </p>
      </div>
    </div>
  );
}

function RuntimeConfigEditor({
  onError,
  onReadinessChange,
  path,
}: {
  onError: (message: string) => void;
  onReadinessChange: (ready: boolean) => void;
  path: string;
}) {
  const [activeEnvironment, setActiveEnvironment] =
    useState<DeployEnvironment>("staging");
  const [documents, setDocuments] = useState<Record<
    DeployEnvironment,
    RuntimeConfigFile
  > | null>(null);
  const [drafts, setDrafts] = useState<Record<DeployEnvironment, string>>({
    staging: "",
    production: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<DeployEnvironment | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all(environments.map(({ id }) => loadRuntimeConfig(path, id)))
      .then(([staging, production]) => {
        if (!active) return;
        setDocuments({ staging, production });
        setDrafts({
          staging: staging.content,
          production: production.content,
        });
      })
      .catch((error) => onError(toMessage(error)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [onError, path]);

  const document = documents?.[activeEnvironment];
  const draft = drafts[activeEnvironment];
  const dirty = Boolean(document && draft !== document.content);
  const environmentLabel = environments.find(
    ({ id }) => id === activeEnvironment,
  )?.label;
  const savedEnvironments = environments.filter(({ id }) => {
    const current = documents?.[id];
    return Boolean(current?.stored && drafts[id] === current.content);
  }).length;
  const ready = savedEnvironments === environments.length;

  useEffect(() => {
    onReadinessChange(ready);
  }, [onReadinessChange, ready]);

  async function save() {
    if (!draft.trim()) {
      onError(`请填写${environmentLabel}环境的运行配置文件`);
      return;
    }
    setSaving(activeEnvironment);
    try {
      const status = await storeRuntimeConfig(path, activeEnvironment, draft);
      setDocuments((current) =>
        current
          ? {
              ...current,
              [activeEnvironment]: {
                ...current[activeEnvironment],
                content: draft,
                stored: status.stored,
              },
            }
          : current,
      );
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(null);
    }
  }

  function restoreTemplate() {
    if (!document) return;
    setDrafts((current) => ({
      ...current,
      [activeEnvironment]: document.templateContent,
    }));
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          aria-label="选择运行环境"
          className="inline-flex w-fit rounded-md bg-[var(--muted)] p-1"
          role="tablist"
        >
          {environments.map(({ id, label }) => (
            <button
              aria-selected={activeEnvironment === id}
              className={`flex h-7 min-w-20 items-center justify-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${
                activeEnvironment === id
                  ? "bg-[var(--surface-raised)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
              key={id}
              onClick={() => setActiveEnvironment(id)}
              role="tab"
              type="button"
            >
              {label}环境
              {documents?.[id]?.stored &&
              drafts[id] === documents[id].content ? (
                <CheckCircle2
                  aria-hidden="true"
                  className="size-3.5 text-[var(--success)]"
                />
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
          <ShieldCheck
            className={`size-4 ${
              document?.stored && !dirty
                ? "text-[var(--success)]"
                : "text-[var(--subtle-foreground)]"
            }`}
          />
          {loading
            ? "正在读取项目模板"
            : dirty
              ? "有未保存修改"
              : document?.stored
                ? "已保存到系统密钥库"
                : "基于项目模板，尚未保存"}
        </div>
      </div>

      <div className="p-4">
        <div className="mb-3 flex min-w-0 items-start gap-2">
          <FileCode2 className="mt-0.5 size-4 shrink-0 text-[var(--muted-foreground)]" />
          <div className="min-w-0">
            <strong className="block text-xs font-semibold">
              {document?.filename ?? `.env.${activeEnvironment}`}
            </strong>
            <p className="mb-0 mt-0.5 break-all text-[11px] leading-5 text-[var(--muted-foreground)]">
              {document?.sourceFiles.length
                ? `根据 ${document.sourceFiles.join("、")} 创建，原文件不会被修改`
                : "项目没有提供配置模板，ABCDeploy 已生成一份基础文件"}
            </p>
          </div>
        </div>

        <textarea
          aria-label={`${environmentLabel}环境运行配置文件`}
          autoCapitalize="off"
          autoComplete="off"
          className="block min-h-64 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2.5 font-mono text-xs leading-5 text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--subtle-foreground)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--focus)] disabled:cursor-wait disabled:opacity-60"
          disabled={loading || !document}
          onChange={(event) =>
            setDrafts((current) => ({
              ...current,
              [activeEnvironment]: event.target.value,
            }))
          }
          placeholder="正在读取配置文件..."
          spellCheck={false}
          value={draft}
          wrap="off"
        />

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="m-0 text-[11px] leading-5 text-[var(--muted-foreground)]">
              保存后整份文件会在部署时写为 `.runtime.env`；请勿把真实密钥提交到
              Git。
            </p>
            <p
              className={`m-0 mt-1 text-[11px] font-medium ${ready ? "text-[var(--success)]" : "text-[var(--warning)]"}`}
              role="status"
            >
              {ready
                ? "测试和生产配置均已安全保存"
                : `已保存 ${savedEnvironments}/2 份，请分别确认测试和生产配置`}
            </p>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              disabled={
                loading || !document || draft === document.templateContent
              }
              onClick={restoreTemplate}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RotateCcw />
              恢复项目模板
            </Button>
            <Button
              disabled={
                loading ||
                !document ||
                saving !== null ||
                (!dirty && document.stored)
              }
              onClick={save}
              size="sm"
              type="button"
              variant="secondary"
            >
              {saving === activeEnvironment ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Save />
              )}
              保存{environmentLabel}配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function readDomains(manifestYaml: string, services: string[]) {
  const document = parseDocument(manifestYaml);
  const manifest = document.toJS() as {
    environments?: {
      staging?: { domains?: Array<{ service?: string; host?: string }> };
      production?: { domains?: Array<{ service?: string; host?: string }> };
    };
  };
  const staging = routesToRecord(manifest.environments?.staging?.domains ?? []);
  const production = routesToRecord(
    manifest.environments?.production?.domains ?? [],
  );
  for (const service of services) {
    staging[service] ??= "";
    production[service] ??= "";
  }
  return { staging, production };
}

function routesToRecord(routes: Array<{ service?: string; host?: string }>) {
  if (!Array.isArray(routes)) return {};
  return Object.fromEntries(
    routes
      .filter((route) => route.service && route.host)
      .map((route) => [route.service as string, route.host as string]),
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
