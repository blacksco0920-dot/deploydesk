import {
  Check,
  Globe2,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseDocument } from "yaml";
import {
  generateRuntimeSecret,
  getRuntimeSecretStatus,
  storeRuntimeSecret,
} from "../../api";
import type { RuntimeSecretStatus, WorkspacePreview } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface RequirementsStepProps {
  onError: (message: string) => void;
  onUpdate: (manifestYaml: string) => Promise<boolean>;
  saving: boolean;
  workspace: WorkspacePreview;
}

type DeployEnvironment = RuntimeSecretStatus["environment"];

const environments: Array<{ id: DeployEnvironment; label: string }> = [
  { id: "staging", label: "测试" },
  { id: "production", label: "生产" },
];

export function RequirementsStep({
  onError,
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
  const variables = useMemo(
    () =>
      Array.from(
        new Map(
          workspace.inspection.environment_variables.map((variable) => [
            variable.name,
            variable,
          ]),
        ).values(),
      ),
    [workspace.inspection.environment_variables],
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
        域名可以稍后补充。测试与生产配置分别保存在系统密钥库，不会写入项目文件。
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
              {saving ? <LoaderCircle className="animate-spin-slow" /> : <Save />}
              保存域名
            </Button>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)] py-5">
        <SectionHeading
          description="内部安全密钥自动生成；第三方地址和凭据按环境分别保存。"
          icon={KeyRound}
          title="项目运行配置"
        />
        <div className="space-y-2 pl-7">
          {variables.map((variable) => (
            <ConfigurationInput
              generated={isGeneratedSecret(variable.name)}
              key={variable.name}
              onError={onError}
              path={workspace.inspection.project_root}
              secret={variable.secret}
              variable={variable.name}
            />
          ))}
          {!variables.length ? (
            <div className="flex items-center gap-2 rounded-md bg-[var(--success-soft)] px-3 py-2.5 text-xs text-[var(--success)]">
              <Check className="size-4" />
              当前项目没有需要补充的运行配置
            </div>
          ) : null}
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

function ConfigurationInput({
  generated,
  onError,
  path,
  secret,
  variable,
}: {
  generated: boolean;
  onError: (message: string) => void;
  path: string;
  secret: boolean;
  variable: string;
}) {
  const [stored, setStored] = useState<Record<DeployEnvironment, boolean>>({
    staging: false,
    production: false,
  });
  const [values, setValues] = useState<Record<DeployEnvironment, string>>({
    staging: "",
    production: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<DeployEnvironment | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all(
      environments.map(async ({ id }) => {
        const status = await getRuntimeSecretStatus(path, id, variable);
        if (!status.stored && generated) {
          return generateRuntimeSecret(path, id, variable);
        }
        return status;
      }),
    )
      .then((statuses) => {
        if (!active) return;
        setStored({
          staging: statuses.some(
            (status) => status.environment === "staging" && status.stored,
          ),
          production: statuses.some(
            (status) => status.environment === "production" && status.stored,
          ),
        });
      })
      .catch((error) => onError(toMessage(error)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [generated, onError, path, variable]);

  async function save(environment: DeployEnvironment) {
    const value = values[environment];
    if (!value.trim()) {
      onError(`请填写 ${variable} 的${environment === "staging" ? "测试" : "生产"}值`);
      return;
    }
    setSaving(environment);
    try {
      const status = await storeRuntimeSecret(
        path,
        environment,
        variable,
        value,
      );
      setStored((current) => ({ ...current, [environment]: status.stored }));
      setValues((current) => ({ ...current, [environment]: "" }));
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck
          className={`size-4 shrink-0 ${
            stored.staging && stored.production
              ? "text-[var(--success)]"
              : "text-[var(--subtle-foreground)]"
          }`}
        />
        <strong className="min-w-0 flex-1 truncate text-xs font-medium">
          {variable}
        </strong>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {loading
            ? "正在检查"
            : generated && stored.staging && stored.production
              ? "已自动生成独立值"
              : stored.staging && stored.production
                ? "两套环境已保存"
                : "等待补充"}
        </span>
      </div>

      {!generated && !loading ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {environments.map(({ id, label }) => (
            <label className="space-y-1.5" key={id}>
              <span className="text-[11px] font-medium">
                {label}环境
                {stored[id] ? " · 已保存" : ""}
              </span>
              <span className="flex gap-2">
                <Input
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [id]: event.target.value,
                    }))
                  }
                  placeholder={stored[id] ? "填写新值可替换" : "填写配置值"}
                  type={secret ? "password" : "text"}
                  value={values[id]}
                />
                <Button
                  disabled={saving === id || !values[id]}
                  onClick={() => save(id)}
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  {saving === id ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : (
                    <Save />
                  )}
                  <span className="sr-only">保存 {variable} {label}环境</span>
                </Button>
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isGeneratedSecret(variable: string) {
  return [
    "JWT_SECRET",
    "SESSION_SECRET",
    "COOKIE_SECRET",
    "ENCRYPTION_KEY",
    "CSRF_SECRET",
    "WEBHOOK_SECRET",
  ].some((suffix) => variable === suffix || variable.endsWith(`_${suffix}`));
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
