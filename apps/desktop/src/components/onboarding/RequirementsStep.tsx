import { Check, Globe2, KeyRound, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseDocument } from "yaml";
import { getSecretStatus, storeSecret } from "../../api";
import type { WorkspacePreview } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface RequirementsStepProps {
  onError: (message: string) => void;
  onUpdate: (manifestYaml: string) => Promise<boolean>;
  saving: boolean;
  workspace: WorkspacePreview;
}

export function RequirementsStep({
  onError,
  onUpdate,
  saving,
  workspace,
}: RequirementsStepProps) {
  const publicServices = useMemo(
    () =>
      workspace.inspection.services.filter((service) => service.kind !== "worker"),
    [workspace.inspection.services],
  );
  const initialDomains = useMemo(
    () => readDomains(workspace.manifestYaml, publicServices.map((service) => service.id)),
    [publicServices, workspace.manifestYaml],
  );
  const [domains, setDomains] = useState(initialDomains);
  const secrets = workspace.inspection.environment_variables.filter(
    (variable) => variable.secret,
  );

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
        域名现在可以留空，系统会先用服务器地址验证。第三方密钥只保存在这台电脑的系统密钥库中。
      </p>

      <section className="border-y border-[var(--border)] py-5">
        <div className="mb-4 flex items-start gap-3">
          <Globe2 className="mt-0.5 size-4 text-[var(--muted-foreground)]" />
          <div>
            <h2 className="m-0 text-sm font-semibold">访问域名</h2>
            <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
              正式域名稍后填写也可以，Caddy 会在 DNS 生效后自动申请 HTTPS。
            </p>
          </div>
        </div>
        <div className="space-y-4 pl-7">
          {publicServices.map((service) => (
            <div className="grid gap-3 sm:grid-cols-2" key={service.id}>
              <label className="space-y-1.5">
                <span className="text-xs font-medium">{service.id} 测试域名</span>
                <Input
                  onChange={(event) =>
                    setDomains((current) => ({
                      ...current,
                      staging: { ...current.staging, [service.id]: event.target.value },
                    }))
                  }
                  placeholder="可暂时留空"
                  value={domains.staging[service.id] ?? ""}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium">{service.id} 正式域名</span>
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
            <Button disabled={saving} onClick={saveDomains} size="sm" variant="secondary">
              {saving ? <LoaderCircle className="animate-spin-slow" /> : <Save />}
              保存域名
            </Button>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)] py-5">
        <div className="mb-4 flex items-start gap-3">
          <KeyRound className="mt-0.5 size-4 text-[var(--muted-foreground)]" />
          <div>
            <h2 className="m-0 text-sm font-semibold">第三方服务密钥</h2>
            <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
              系统只识别出变量名称，不会从项目文件中读取已有值。
            </p>
          </div>
        </div>
        <div className="space-y-2 pl-7">
          {secrets.map((variable) => (
            <SecretInput
              key={variable.name}
              onError={onError}
              project={workspace.inspection.project_name}
              variable={variable.name}
            />
          ))}
          {!secrets.length ? (
            <div className="flex items-center gap-2 rounded-md bg-[var(--success-soft)] px-3 py-2.5 text-xs text-[var(--success)]">
              <Check className="size-4" />
              当前项目没有需要人工填写的敏感变量
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SecretInput({
  onError,
  project,
  variable,
}: {
  onError: (message: string) => void;
  project: string;
  variable: string;
}) {
  const key = secretKey(project, variable);
  const [value, setValue] = useState("");
  const [stored, setStored] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSecretStatus(key)
      .then((status) => setStored(status.stored))
      .catch((error) => onError(toMessage(error)));
  }, [key, onError]);

  async function save() {
    if (!value.trim()) {
      onError(`请填写 ${variable}`);
      return;
    }
    setSaving(true);
    try {
      const status = await storeSecret(key, value);
      setStored(status.stored);
      setValue("");
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--border)] p-3">
      <ShieldCheck
        className={`size-4 shrink-0 ${
          stored ? "text-[var(--success)]" : "text-[var(--subtle-foreground)]"
        }`}
      />
      <span className="min-w-0 w-40 shrink-0">
        <strong className="block truncate text-xs font-medium">{variable}</strong>
        <span className="block text-[11px] text-[var(--muted-foreground)]">
          {stored ? "已安全保存" : "等待填写"}
        </span>
      </span>
      <Input
        className="min-w-0 flex-1"
        onChange={(event) => setValue(event.target.value)}
        placeholder={stored ? "填写新值可替换" : "粘贴密钥"}
        type="password"
        value={value}
      />
      <Button disabled={saving || !value} onClick={save} size="icon" variant="secondary">
        {saving ? <LoaderCircle className="animate-spin-slow" /> : <Save />}
        <span className="sr-only">保存 {variable}</span>
      </Button>
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
  const staging = routesToRecord(
    manifest.environments?.staging?.domains ?? [],
  );
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

function secretKey(project: string, variable: string) {
  return `runtime.${project.slice(0, 28)}.${variable.slice(0, 40)}`;
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
