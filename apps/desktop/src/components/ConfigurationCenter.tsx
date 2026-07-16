import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteConfigProfile,
  listConfigProfiles,
  saveConfigProfile,
} from "../api";
import type { ConfigProfile } from "../types";
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

export function ConfigurationCenter({ onError }: ConfigurationCenterProps) {
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ConfigProfile | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConfigProfile | null>(
    null,
  );
  const [draft, setDraft] = useState<ConfigurationDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [showValue, setShowValue] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProfiles((await listConfigProfiles()).filter(isUserConfiguration));
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await refresh();
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
      await refresh();
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
            可选工具 · 保存后可在项目中直接选择
          </span>
        </div>
        {profiles.length ? (
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
        <div className="mx-auto w-full max-w-[920px] px-6 py-8">
          <div className="mb-8 flex items-end justify-between gap-5 max-[760px]:flex-col max-[760px]:items-stretch">
            <div>
              <h1 className="m-0 text-2xl font-semibold">常用配置</h1>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">
                这里不是上线前置步骤。项目缺少配置时可以直接填写；只有经常重复使用的值，才需要保存到这里。
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

          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
              <LoaderCircle className="animate-spin-slow" />
              正在读取配置
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
