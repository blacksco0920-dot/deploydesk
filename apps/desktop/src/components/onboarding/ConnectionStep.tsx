import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  FileKey2,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  Server,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  checkServer,
  connectCnb,
  discoverSshIdentities,
  generateSshIdentity,
  getCnbAccount,
  selectPrivateKey,
} from "../../api";
import type {
  CnbAccount,
  GeneratedSshIdentity,
  ProviderCheck,
  ServerForm,
  SshIdentity,
} from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

interface ConnectionState {
  cnb: boolean;
  server: boolean;
  serverForm: ServerForm;
}

interface ConnectionStepProps {
  initialServer?: Partial<ServerForm>;
  onError: (message: string) => void;
  onStateChange: (state: ConnectionState) => void;
}

const emptyServer: ServerForm = {
  name: "default-server",
  host: "",
  user: "ubuntu",
  port: 22,
  keyPath: "",
};

export function ConnectionStep({
  initialServer,
  onError,
  onStateChange,
}: ConnectionStepProps) {
  const [cnb, setCnb] = useState<CnbAccount>({
    connected: false,
    displayName: "尚未连接",
    username: "",
  });
  const [checkingCnb, setCheckingCnb] = useState(true);
  const [cnbDialog, setCnbDialog] = useState(false);
  const [token, setToken] = useState("");
  const [rememberToken, setRememberToken] = useState(true);
  const [connectingCnb, setConnectingCnb] = useState(false);
  const [identities, setIdentities] = useState<SshIdentity[]>([]);
  const [identityDialog, setIdentityDialog] = useState(false);
  const [generated, setGenerated] = useState<GeneratedSshIdentity | null>(null);
  const [server, setServer] = useState<ServerForm>({
    ...emptyServer,
    ...initialServer,
  });
  const [serverCheck, setServerCheck] = useState<ProviderCheck | null>(null);
  const [checkingServer, setCheckingServer] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([getCnbAccount(), discoverSshIdentities()])
      .then(([account, found]) => {
        setCnb(account);
        setIdentities(found);
        const preferred =
          found.find((identity) => identity.managed) ?? found[0] ?? null;
        if (preferred) {
          setServer((current) =>
            current.keyPath ? current : { ...current, keyPath: preferred.path },
          );
        }
      })
      .catch((error) => onError(toMessage(error)))
      .finally(() => setCheckingCnb(false));
  }, [onError]);

  useEffect(() => {
    if (!initialServer?.host) return;
    setServer((current) =>
      current.host ? current : { ...current, ...initialServer },
    );
  }, [initialServer]);

  useEffect(() => {
    onStateChange({
      cnb: cnb.connected,
      server: serverCheck?.ok ?? false,
      serverForm: server,
    });
  }, [cnb.connected, onStateChange, server, serverCheck?.ok]);

  const selectedIdentity = useMemo(
    () => identities.find((identity) => identity.path === server.keyPath),
    [identities, server.keyPath],
  );

  async function handleCnbConnect() {
    if (!token.trim()) {
      onError("请粘贴刚刚创建的 CNB 访问令牌");
      return;
    }
    setConnectingCnb(true);
    try {
      const account = await connectCnb(token, rememberToken);
      setCnb(account);
      setToken("");
      setCnbDialog(false);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setConnectingCnb(false);
    }
  }

  async function handleGenerateIdentity() {
    try {
      const result = await generateSshIdentity();
      setGenerated(result);
      setIdentities((current) => [
        result.identity,
        ...current.filter((identity) => identity.path !== result.identity.path),
      ]);
      setServer((current) => ({ ...current, keyPath: result.identity.path }));
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function handleManualIdentity() {
    const selected = await selectPrivateKey(server.keyPath || undefined);
    if (!selected) return;
    const identity: SshIdentity = {
      name: selected.split(/[\\/]/).pop() ?? "SSH 私钥",
      path: selected,
      source: "手动选择",
      fingerprint: null,
      managed: false,
    };
    setIdentities((current) => [
      identity,
      ...current.filter((item) => item.path !== selected),
    ]);
    setServer((current) => ({ ...current, keyPath: selected }));
    setIdentityDialog(false);
  }

  async function handleServerCheck() {
    if (!server.host.trim()) {
      onError("请填写服务器 IP 或域名");
      return;
    }
    if (!server.keyPath) {
      onError("还没有可用的安全凭据，请先创建或选择 SSH 身份");
      return;
    }
    setCheckingServer(true);
    setServerCheck(null);
    try {
      const result = await checkServer(server);
      setServerCheck(result);
      if (result.provider === "ssh-host-key" && result.details[0]) {
        setServer((current) => ({
          ...current,
          hostFingerprint: result.details[0],
        }));
        return;
      }
      if (!result.ok) onError(result.summary);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setCheckingServer(false);
    }
  }

  async function copyPublicKey() {
    if (!generated?.publicKey) return;
    await navigator.clipboard.writeText(generated.publicKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <ShieldCheck className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">连接构建服务和目标服务器</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        已连接的资源以后可以直接复用。令牌存入系统密钥库，服务器密码不会保存。
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <ConnectionRow
          description={
            cnb.connected
              ? `已连接账号 ${cnb.displayName}`
              : "用于构建镜像并记录发布状态"
          }
          icon={Cloud}
          loading={checkingCnb}
          ok={cnb.connected}
          title="CNB 云原生构建"
        >
          <Button
            onClick={() => setCnbDialog(true)}
            size="sm"
            variant="secondary"
          >
            {cnb.connected ? "重新授权" : "连接"}
          </Button>
        </ConnectionRow>

        <div className="border-t border-[var(--border)]">
          <ConnectionRow
            description={
              serverCheck?.ok
                ? serverCheck.summary
                : "只需填写地址，安全凭据由系统自动查找"
            }
            icon={Server}
            loading={checkingServer}
            ok={serverCheck?.ok ?? false}
            title="目标服务器"
          />
          <div className="grid gap-4 bg-[var(--muted)] px-4 py-4 sm:grid-cols-[1fr_130px]">
            <label className="space-y-1.5">
              <span className="text-xs font-medium">服务器 IP 或域名</span>
              <Input
                autoComplete="off"
                onChange={(event) => {
                  setServer((current) => ({
                    ...current,
                    host: event.target.value,
                    hostFingerprint: undefined,
                  }));
                  setServerCheck(null);
                }}
                placeholder="例如 123.123.123.123"
                value={server.host}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">登录用户</span>
              <Input
                autoComplete="username"
                onChange={(event) => {
                  setServer((current) => ({
                    ...current,
                    user: event.target.value,
                    hostFingerprint: undefined,
                  }));
                  setServerCheck(null);
                }}
                value={server.user}
              />
            </label>

            <div className="flex min-w-0 items-center gap-3 sm:col-span-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--surface)] text-[var(--muted-foreground)]">
                <FileKey2 className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs font-medium">
                  {selectedIdentity
                    ? `已自动选择 ${selectedIdentity.name}`
                    : "尚未找到 SSH 身份"}
                </strong>
                <span className="mt-0.5 block truncate text-[11px] text-[var(--muted-foreground)]">
                  {selectedIdentity?.fingerprint ??
                    "私钥不会离开这台电脑，也不会写入项目目录"}
                </span>
              </span>
              {!selectedIdentity ? (
                <Button
                  onClick={handleGenerateIdentity}
                  size="sm"
                  variant="secondary"
                >
                  <KeyRound />
                  创建安全连接
                </Button>
              ) : null}
              <Button
                aria-label="选择其他 SSH 身份"
                onClick={() => setIdentityDialog(true)}
                size="icon"
                variant="ghost"
              >
                <Settings2 />
              </Button>
              <Button
                disabled={checkingServer}
                onClick={handleServerCheck}
                size="sm"
              >
                {checkingServer ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <ShieldCheck />
                )}
                {serverCheck?.provider === "ssh-host-key"
                  ? "确认并连接"
                  : "验证连接"}
              </Button>
            </div>

            {serverCheck?.provider === "ssh-host-key" ? (
              <div className="flex items-start gap-3 rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] p-3 sm:col-span-2">
                <Fingerprint className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <strong className="block text-xs font-medium">
                    确认服务器身份
                  </strong>
                  <code className="mt-1 block break-all text-[11px] text-[var(--muted-foreground)]">
                    {serverCheck.details[0]}
                  </code>
                </span>
              </div>
            ) : null}

            {generated ? (
              <div className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 sm:col-span-2">
                <span className="min-w-0 flex-1 text-xs leading-5 text-[var(--muted-foreground)]">
                  若服务器暂不接受这把密钥，请将公钥添加到云服务器控制台，然后再次验证。
                </span>
                <Button onClick={copyPublicKey} size="sm" variant="secondary">
                  {copied ? <Check /> : <Copy />}
                  {copied ? "已复制" : "复制公钥"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-[var(--muted-foreground)]">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
        当前步骤只验证连接，不会安装软件、修改服务器配置或部署业务。
      </div>

      <Dialog onOpenChange={setCnbDialog} open={cnbDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>连接 CNB</DialogTitle>
            <DialogDescription>
              CNB
              暂未提供适合公开桌面客户端的免密授权流程，因此当前需要创建一次访问令牌。应用只会验证权限并保存到系统密钥库。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button
              className="w-full justify-between"
              onClick={() =>
                openExternal("https://cnb.cool/profile/token", onError)
              }
              variant="secondary"
            >
              打开 CNB 访问令牌页面
              <ExternalLink />
            </Button>
            <div className="space-y-1.5">
              <Label htmlFor="cnb-token">访问令牌</Label>
              <Input
                autoComplete="off"
                id="cnb-token"
                onChange={(event) => setToken(event.target.value)}
                placeholder="创建后粘贴到这里"
                type="password"
                value={token}
              />
              <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
                建议设置有效期，并仅授予仓库读取、管理和构建触发所需权限。
              </p>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-md border border-[var(--border)] p-3">
              <span>
                <strong className="block text-sm font-medium">
                  记住这次连接
                </strong>
                <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                  安全保存在系统钥匙串或凭据管理器中
                </span>
              </span>
              <Switch
                checked={rememberToken}
                onCheckedChange={setRememberToken}
              />
            </label>
          </div>
          <DialogFooter>
            <Button onClick={() => setCnbDialog(false)} variant="secondary">
              取消
            </Button>
            <Button
              disabled={connectingCnb || !token.trim()}
              onClick={handleCnbConnect}
            >
              {connectingCnb ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <ShieldCheck />
              )}
              验证并连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setIdentityDialog} open={identityDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择安全凭据</DialogTitle>
            <DialogDescription>
              系统已经检查这台电脑常见的 SSH 目录。通常使用推荐项即可。
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-md border border-[var(--border)]">
            {identities.map((identity) => (
              <button
                className="flex w-full items-center gap-3 border-b border-[var(--border)] px-3 py-3 text-left last:border-b-0 hover:bg-[var(--muted)]"
                key={identity.path}
                onClick={() => {
                  setServer((current) => ({
                    ...current,
                    keyPath: identity.path,
                  }));
                  setServerCheck(null);
                  setIdentityDialog(false);
                }}
                type="button"
              >
                <FileKey2 className="size-4 text-[var(--muted-foreground)]" />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium">
                    {identity.name}
                  </strong>
                  <span className="block truncate text-xs text-[var(--muted-foreground)]">
                    {identity.source}
                  </span>
                </span>
                {identity.path === server.keyPath ? (
                  <Check className="size-4 text-[var(--accent)]" />
                ) : null}
              </button>
            ))}
            {!identities.length ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
                没有发现已有 SSH 身份
              </div>
            ) : null}
          </div>
          <DialogFooter className="justify-between">
            <Button onClick={handleGenerateIdentity} variant="secondary">
              <KeyRound />
              创建专用身份
            </Button>
            <Button onClick={handleManualIdentity} variant="ghost">
              手动选择文件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionRow({
  children,
  description,
  icon: Icon,
  loading,
  ok,
  title,
}: {
  children?: React.ReactNode;
  description: string;
  icon: typeof Cloud;
  loading: boolean;
  ok: boolean;
  title: string;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-3 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium">{title}</strong>
        <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">
          {description}
        </span>
      </span>
      {loading ? (
        <LoaderCircle className="size-4 animate-spin-slow text-[var(--subtle-foreground)]" />
      ) : ok ? (
        <span className="flex items-center gap-1.5 text-xs text-[var(--success)]">
          <CheckCircle2 className="size-4" />
          已连接
        </span>
      ) : null}
      {children}
    </div>
  );
}

function openExternal(url: string, onError: (message: string) => void) {
  openUrl(url).catch(() => {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) onError("无法打开 CNB 页面，请稍后重试");
  });
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
