import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Code2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteConfigProfile,
  listConnections,
  listConfigProfiles,
  saveConfigProfile,
} from "../api";
import type {
  ConfigProfile,
  ConnectionKind,
  ConnectionResource,
} from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ConfigurationCenterProps {
  onError: (message: string) => void;
}

interface ConfigurationDraft {
  description: string;
  key: string;
  value: string;
}

const emptyDraft: ConfigurationDraft = { description: "", key: "", value: "" };

type ConfigurationCenterView = "connections" | "configurations";

export function ConfigurationCenter({ onError }: ConfigurationCenterProps) {
  const [view, setView] = useState<ConfigurationCenterView>("connections");
  const [connections, setConnections] = useState<ConnectionResource[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ConfigProfile | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConfigProfile | null>(
    null,
  );
  const [draft, setDraft] = useState<ConfigurationDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [showValue, setShowValue] = useState(false);

  const refreshConnections = useCallback(async () => {
    setConnectionsLoading(true);
    try {
      setConnections(await listConnections());
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setConnectionsLoading(false);
    }
  }, [onError]);

  const refreshProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      setProfiles((await listConfigProfiles()).filter(isUserConfiguration));
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setProfilesLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshConnections();
    void refreshProfiles();
  }, [refreshConnections, refreshProfiles]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLocaleLowerCase().includes(normalized) ||
        configurationKey(profile).toLocaleLowerCase().includes(normalized),
    );
  }, [profiles, query]);

  function openEditor(profile: ConfigProfile | "new") {
    setShowValue(false);
    setEditing(profile);
    setDraft(
      profile === "new"
        ? emptyDraft
        : {
            description: profile.name,
            key: configurationKey(profile),
            value: profile.values.env_value ?? "",
          },
    );
  }

  async function save() {
    const key = draft.key.trim().toUpperCase();
    if (!draft.description.trim() || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      onError("请填写配置说明，并使用正确的配置名称");
      return;
    }
    const existing = editing === "new" ? undefined : (editing ?? undefined);
    const secret =
      Boolean(existing?.configuredSecretFields.includes(key)) ||
      Boolean(existing?.secretFields.includes(key)) ||
      isSensitiveConfiguration(key, draft.value);
    if (!draft.value && !existing?.configuredSecretFields.includes(key)) {
      onError("请填写配置值");
      return;
    }
    setSaving(true);
    try {
      await saveConfigProfile({
        id: existing?.id,
        kind: "custom",
        provider: "environment",
        name: draft.description.trim(),
        scope: "any",
        values: secret
          ? { env_name: key }
          : { env_name: key, env_value: draft.value },
        secretFields: secret ? [key] : [],
        secrets: secret && draft.value ? { [key]: draft.value } : {},
        isDefault: existing?.isDefault ?? profiles.length === 0,
      });
      setEditing(null);
      setDraft(emptyDraft);
      await refreshProfiles();
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!pendingDelete) return;
    setSaving(true);
    try {
      await deleteConfigProfile(pendingDelete.id);
      setPendingDelete(null);
      await refreshProfiles();
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const editingProfile = editing && editing !== "new" ? editing : null;
  const draftIsSensitive =
    Boolean(editingProfile && configurationIsSecret(editingProfile)) ||
    isSensitiveConfiguration(draft.key, draft.value);
  const draftValueLabel =
    draft.description.trim() || draft.key.trim() || "当前配置";

  return (
    <div className="grid h-full min-h-0 grid-rows-[58px_minmax(0,1fr)] bg-[var(--background)]">
      <header
        className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6"
        data-tauri-drag-region
      >
        <div>
          <strong className="block text-sm font-semibold">配置中心</strong>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            可复用资源 · 保存后可在项目中直接选择
          </span>
        </div>
        {view === "configurations" && profiles.length ? (
          <Button
            onClick={() => openEditor("new")}
            size="sm"
            variant="secondary"
          >
            <Plus />
            添加配置
          </Button>
        ) : null}
      </header>

      <main className="min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-[1040px] px-6 py-7">
          <div
            aria-label="配置中心分类"
            className="mb-7 flex w-fit rounded-lg bg-[var(--muted)] p-1"
            role="tablist"
          >
            <CenterTab
              active={view === "connections"}
              label="可复用连接"
              onClick={() => setView("connections")}
            />
            <CenterTab
              active={view === "configurations"}
              label="常用配置"
              onClick={() => setView("configurations")}
            />
          </div>

          {view === "connections" ? (
            <ConnectionsPanel
              connections={connections}
              loading={connectionsLoading}
              onRefresh={() => void refreshConnections()}
            />
          ) : (
            <section aria-label="常用配置">
              <div className="mb-8 flex items-end justify-between gap-5 max-[760px]:flex-col max-[760px]:items-stretch">
                <div>
                  <h1 className="m-0 text-2xl font-semibold">常用配置</h1>
                  <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">
                    环境变量模板单独保存在这里，不会被当作账号或服务器连接。项目缺值时可以直接引用。
                  </p>
                </div>
                {profiles.length > 5 ? (
                  <label className="relative block w-56 max-[760px]:w-full">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--subtle-foreground)]" />
                    <Input
                      aria-label="搜索配置"
                      className="pl-9"
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索说明或配置名称"
                      value={query}
                    />
                  </label>
                ) : null}
              </div>

              {profilesLoading ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                  <LoaderCircle className="animate-spin-slow" />
                  正在读取常用配置
                </div>
              ) : filtered.length ? (
                <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                  <div className="grid grid-cols-[minmax(180px,1.4fr)_minmax(170px,1fr)_minmax(150px,1fr)_80px] gap-4 border-b border-[var(--border)] bg-[var(--muted)] px-4 py-2.5 text-[11px] font-medium text-[var(--muted-foreground)] max-[760px]:hidden">
                    <span>配置说明</span>
                    <span>配置名称</span>
                    <span>配置值</span>
                    <span className="text-right">操作</span>
                  </div>
                  {filtered.map((profile) => {
                    const key = configurationKey(profile);
                    const secret = profile.secretFields.includes(key);
                    return (
                      <div
                        className="grid min-h-[66px] grid-cols-[minmax(180px,1.4fr)_minmax(170px,1fr)_minmax(150px,1fr)_80px] items-center gap-4 border-b border-[var(--border)] px-4 last:border-b-0 max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:gap-x-3 max-[760px]:gap-y-1 max-[760px]:py-3"
                        key={profile.id}
                      >
                        <strong className="truncate text-sm font-medium max-[760px]:col-start-1">
                          {profile.name}
                        </strong>
                        <code className="truncate text-xs text-[var(--muted-foreground)] max-[760px]:col-start-1">
                          {key}
                        </code>
                        <span className="truncate text-xs text-[var(--muted-foreground)] max-[760px]:col-start-1">
                          {secret ? "••••••••" : profile.values.env_value}
                        </span>
                        <div className="flex justify-end gap-1 max-[760px]:col-start-2 max-[760px]:row-span-3 max-[760px]:row-start-1 max-[760px]:self-center">
                          <Button
                            aria-label={`编辑 ${profile.name}`}
                            onClick={() => openEditor(profile)}
                            size="icon"
                            variant="ghost"
                          >
                            <Pencil />
                          </Button>
                          <Button
                            aria-label={`删除 ${profile.name}`}
                            onClick={() => setPendingDelete(profile)}
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : (
                <section className="flex min-h-[300px] flex-col items-center justify-center border-y border-[var(--border)] text-center">
                  <span className="mb-4 grid size-11 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                    <KeyRound className="size-5" />
                  </span>
                  <h2 className="m-0 text-base font-semibold">
                    暂时不需要添加配置
                  </h2>
                  <p className="mb-5 mt-2 max-w-md text-sm leading-6 text-[var(--muted-foreground)]">
                    先在项目中正常填写即可。以后遇到经常重复使用的值，再保存到这里方便复用。
                  </p>
                  <Button onClick={() => openEditor("new")} variant="secondary">
                    <Plus />
                    保存一项常用配置
                  </Button>
                </section>
              )}
            </section>
          )}
        </div>
      </main>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setShowValue(false);
          }
        }}
        open={Boolean(editing)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "添加配置" : "编辑配置"}
            </DialogTitle>
            <DialogDescription>
              配置名称需要与项目配置文件中的名称完全一致。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="configuration-description">配置说明</Label>
              <Input
                id="configuration-description"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="例如：测试环境账号"
                value={draft.description}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="configuration-key">配置名称</Label>
              <Input
                id="configuration-key"
                onChange={(event) => {
                  setShowValue(false);
                  setDraft((current) => ({
                    ...current,
                    key: event.target.value.toUpperCase(),
                  }));
                }}
                placeholder="例如 SERVICE_ACCESS_KEY"
                value={draft.key}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="configuration-value">配置值</Label>
              <div className="relative">
                <Input
                  className={
                    draftIsSensitive && draft.value ? "pr-10" : undefined
                  }
                  id="configuration-value"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      value: event.target.value,
                    }))
                  }
                  placeholder={
                    editingProfile && configurationIsSecret(editingProfile)
                      ? "已安全保存，留空表示不修改"
                      : "输入配置值"
                  }
                  type={draftIsSensitive && !showValue ? "password" : "text"}
                  value={draft.value}
                />
                {draftIsSensitive && draft.value ? (
                  <button
                    aria-label={`${showValue ? "隐藏" : "显示"}${draftValueLabel}配置值`}
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-[var(--muted-foreground)] outline-none hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]"
                    onClick={() => setShowValue((current) => !current)}
                    type="button"
                  >
                    {showValue ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                ) : null}
              </div>
              {draftIsSensitive ? (
                <p className="m-0 text-[11px] text-[var(--muted-foreground)]">
                  系统识别为敏感配置，保存后不会显示原文。
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setEditing(null)} variant="secondary">
              取消
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <LoaderCircle className="animate-spin-slow" /> : null}
              保存配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setPendingDelete(null)}
        open={Boolean(pendingDelete)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条配置？</DialogTitle>
            <DialogDescription>
              删除“{pendingDelete?.name}
              ”只会移除以后复用的入口，不会清除已经保存到项目中的配置。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPendingDelete(null)} variant="secondary">
              取消
            </Button>
            <Button
              disabled={saving}
              onClick={() => void remove()}
              variant="destructive"
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CenterTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={`min-w-28 rounded-md px-4 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
        active
          ? "bg-[var(--surface)] font-medium text-[var(--foreground)] shadow-sm"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      }`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

const connectionSections: Array<{
  description: string;
  empty: string;
  icon: typeof Code2;
  kind: ConnectionKind;
  singleton: boolean;
  title: string;
}> = [
  {
    kind: "source",
    title: "代码平台",
    description: "读取项目代码并触发自动构建",
    empty: "还没有保存代码平台连接",
    icon: Code2,
    singleton: true,
  },
  {
    kind: "registry",
    title: "版本仓库",
    description: "保存每次上线生成的可运行版本",
    empty: "还没有保存版本仓库连接",
    icon: Package,
    singleton: true,
  },
  {
    kind: "server",
    title: "运行服务器",
    description: "运行项目并提供访问地址",
    empty: "还没有保存运行服务器",
    icon: Server,
    singleton: false,
  },
];

function ConnectionsPanel({
  connections,
  loading,
  onRefresh,
}: {
  connections: ConnectionResource[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <section aria-label="可复用连接">
      <div className="mb-7 flex items-end justify-between gap-5 max-[760px]:flex-col max-[760px]:items-stretch">
        <div>
          <h1 className="m-0 text-2xl font-semibold">可复用连接</h1>
          <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">
            账号或服务器验证一次后，会保存为连接，其他项目可以直接选择，不需要重复填写凭据。
          </p>
        </div>
        <Button
          disabled={loading}
          onClick={onRefresh}
          size="sm"
          variant="secondary"
        >
          <RefreshCw className={loading ? "animate-spin-slow" : undefined} />
          刷新状态
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="animate-spin-slow" />
          正在读取已保存连接
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          {connectionSections.map((section) => {
            const sectionConnections = connections.filter(
              (connection) => connection.kind === section.kind,
            );
            return (
              <ConnectionSection
                connections={sectionConnections}
                key={section.kind}
                section={section}
              />
            );
          })}
        </div>
      )}

      <div className="mt-5 rounded-lg border border-[var(--accent)]/20 bg-[var(--info-soft)] px-4 py-3 text-xs leading-5 text-[var(--muted-foreground)]">
        新连接仍从项目的部署线路中完成验证并保存。当前版本分别维护一个 CNB
        账号连接和一个 TCR
        登录；这里展示当前真实保存状态，不提供虚假的多账号入口。
      </div>
    </section>
  );
}

function ConnectionSection({
  connections,
  section,
}: {
  connections: ConnectionResource[];
  section: (typeof connectionSections)[number];
}) {
  const Icon = section.icon;
  return (
    <section className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <header className="flex items-start gap-3 border-b border-[var(--border)] pb-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">{section.title}</h2>
          <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            {section.description}
          </p>
        </div>
      </header>

      {connections.length ? (
        <div className="divide-y divide-[var(--border)]">
          {connections.map((connection) => (
            <ConnectionCard
              connection={connection}
              key={connection.id}
              label={section.singleton ? "当前已保存连接" : "已保存服务器"}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-36 flex-col justify-center py-4">
          <strong className="text-sm font-medium">{section.empty}</strong>
          <span className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            在项目部署线路中验证成功后，会自动出现在这里。
          </span>
        </div>
      )}
    </section>
  );
}

function ConnectionCard({
  connection,
  label,
}: {
  connection: ConnectionResource;
  label: string;
}) {
  const status = connectionStatus(connection);
  const StatusIcon = status.icon;
  const detail = connectionDetail(connection);
  return (
    <article className="py-4 first:pt-4 last:pb-1">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-[var(--muted-foreground)]">
          {label}
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${status.className}`}
        >
          <StatusIcon className="size-3" />
          {status.label}
        </span>
      </div>
      <strong className="block truncate text-sm font-semibold">
        {connection.name}
      </strong>
      <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
        {providerName(connection.provider)}
        {detail ? ` · ${detail}` : ""}
      </span>
      {connection.lastCheckedAt ? (
        <span className="mt-2 block text-[10px] text-[var(--subtle-foreground)]">
          最近验证 {formatCheckedAt(connection.lastCheckedAt)}
        </span>
      ) : null}
    </article>
  );
}

function connectionStatus(connection: ConnectionResource) {
  switch (connection.status) {
    case "ready":
      return {
        className: "bg-[var(--success-soft)] text-[var(--success)]",
        icon: CheckCircle2,
        label: "连接正常",
      };
    case "configured":
      return {
        className: "bg-[var(--muted)] text-[var(--muted-foreground)]",
        icon: CircleDashed,
        label: "已保存",
      };
    case "needs_authorization":
      return {
        className: "bg-[var(--warning-soft)] text-[var(--warning)]",
        icon: AlertCircle,
        label: "需要授权",
      };
    case "error":
      return {
        className: "bg-[var(--warning-soft)] text-[var(--warning)]",
        icon: AlertCircle,
        label: "连接异常",
      };
    default:
      return {
        className: "bg-[var(--muted)] text-[var(--muted-foreground)]",
        icon: CircleDashed,
        label: "等待验证",
      };
  }
}

function connectionDetail(connection: ConnectionResource) {
  if (connection.kind === "server") {
    const host = connection.metadata.host;
    if (!host) return "";
    const user = connection.metadata.user;
    const port = connection.metadata.port;
    return `${user ? `${user}@` : ""}${host}${port ? `:${port}` : ""}`;
  }
  if (connection.kind === "source") {
    return connection.metadata.namespace || connection.metadata.username || "";
  }
  return connection.metadata.namespace || connection.metadata.endpoint || "";
}

function providerName(provider: string) {
  switch (provider.toLocaleLowerCase()) {
    case "cnb":
      return "CNB";
    case "tcr":
      return "腾讯云 TCR";
    case "ssh":
      return "SSH";
    default:
      return provider.toUpperCase();
  }
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function isUserConfiguration(profile: ConfigProfile) {
  return profile.kind === "custom" && Boolean(configurationKey(profile));
}

function configurationKey(profile: ConfigProfile) {
  return profile.values.env_name ?? profile.secretFields[0] ?? "";
}

function configurationIsSecret(profile: ConfigProfile) {
  const key = configurationKey(profile);
  return (
    profile.secretFields.includes(key) ||
    profile.configuredSecretFields.includes(key)
  );
}

export function isSensitiveConfiguration(key: string, value = "") {
  const normalizedKey = key.trim().toUpperCase();
  if (
    /(?:^|_)(?:SECRET(?:_ID|_KEY)?|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|CREDENTIALS?)$/.test(
      normalizedKey,
    )
  ) {
    return true;
  }
  const connectionService =
    /(?:^|_)(?:DATABASE|DB|POSTGRESQL?|MYSQL|MARIADB|MONGO(?:DB)?|REDIS|CACHE|AMQP|RABBITMQ|KAFKA)(?:_|$)/.test(
      normalizedKey,
    );
  const connectionFormat =
    /(?:^|_)(?:URL|URI|DSN|CONNECTION(?:_STRING)?)(?:_|$)/.test(normalizedKey);
  if (connectionService && connectionFormat) return true;

  try {
    const parsed = new URL(value.trim());
    if (parsed.username || parsed.password) return true;
    return Array.from(parsed.searchParams.entries()).some(
      ([name, parameterValue]) =>
        Boolean(parameterValue) &&
        /^(?:access_?token|api_?key|password|passwd|secret)$/i.test(name),
    );
  } catch {
    return false;
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
