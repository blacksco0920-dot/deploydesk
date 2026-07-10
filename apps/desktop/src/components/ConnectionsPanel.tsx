import {
  CheckCircle2,
  CircleAlert,
  CloudCog,
  Container,
  ExternalLink,
  FileKey2,
  FolderOpen,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Server,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import {
  bootstrapServerCaddy,
  checkDocker,
  checkServer,
  connectCnb,
  createCnbRepository,
  selectPrivateKey,
} from "../api";
import type { CnbRepositoryResult, ProviderCheck, ServerForm } from "../types";

interface ConnectionsPanelProps {
  onError: (message: string) => void;
  onRepositorySelected: (repository: string) => Promise<void>;
}

const emptyServer = (name: string): ServerForm => ({
  name,
  host: "",
  user: "ubuntu",
  port: 22,
  keyPath: "",
});

export function ConnectionsPanel({
  onError,
  onRepositorySelected,
}: ConnectionsPanelProps) {
  const [token, setToken] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [rememberToken, setRememberToken] = useState(true);
  const [cnbAccount, setCnbAccount] = useState<string | null>(null);
  const [cnbLoading, setCnbLoading] = useState(false);
  const [repositorySlug, setRepositorySlug] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryDescription, setRepositoryDescription] = useState("");
  const [privateRepository, setPrivateRepository] = useState(true);
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [createdRepository, setCreatedRepository] =
    useState<CnbRepositoryResult | null>(null);
  const [dockerCheck, setDockerCheck] = useState<ProviderCheck | null>(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [staging, setStaging] = useState(emptyServer("staging-server"));
  const [production, setProduction] = useState(
    emptyServer("production-server"),
  );
  const [serverChecks, setServerChecks] = useState<
    Record<string, ProviderCheck | undefined>
  >({});
  const [checkingServer, setCheckingServer] = useState<string | null>(null);
  const [bootstrapConfirmations, setBootstrapConfirmations] = useState<
    Record<string, boolean>
  >({});
  const [bootstrapChecks, setBootstrapChecks] = useState<
    Record<string, ProviderCheck | undefined>
  >({});
  const [bootstrappingServer, setBootstrappingServer] = useState<string | null>(
    null,
  );

  async function handleCnbConnect() {
    if (!token.trim()) {
      onError("请先填写 CNB 访问令牌");
      return;
    }
    setCnbLoading(true);
    try {
      const result = await connectCnb(token, rememberToken);
      setCnbAccount(result.displayName);
      setSessionToken(rememberToken ? "" : token);
      setToken("");
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setCnbLoading(false);
    }
  }

  async function handleRepositoryCreate() {
    if (!cnbAccount) {
      onError("请先验证并连接 CNB");
      return;
    }
    if (!repositorySlug.trim() || !repositoryName.trim()) {
      onError("请填写 CNB 所属组织或用户名，以及仓库名称");
      return;
    }
    setRepositoryLoading(true);
    setCreatedRepository(null);
    try {
      const result = await createCnbRepository({
        token: sessionToken,
        slug: repositorySlug,
        name: repositoryName,
        description: repositoryDescription,
        privateRepo: privateRepository,
      });
      await onRepositorySelected(result.repository);
      setCreatedRepository(result);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setRepositoryLoading(false);
    }
  }

  async function handleDockerCheck() {
    setDockerLoading(true);
    try {
      setDockerCheck(await checkDocker());
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setDockerLoading(false);
    }
  }

  async function chooseKey(
    form: ServerForm,
    update: (value: ServerForm) => void,
  ) {
    const selected = await selectPrivateKey();
    if (selected) update({ ...form, keyPath: selected });
  }

  async function handleServerCheck(form: ServerForm) {
    if (!form.host || !form.user || !form.keyPath) {
      onError("请填写服务器地址、用户名并选择 SSH 私钥");
      return;
    }
    setCheckingServer(form.name);
    try {
      const result = await checkServer(form);
      setServerChecks((current) => ({ ...current, [form.name]: result }));
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setCheckingServer(null);
    }
  }

  async function handleCaddyBootstrap(form: ServerForm) {
    if (!bootstrapConfirmations[form.name]) {
      onError("初始化 Caddy 前请勾选明确授权");
      return;
    }
    setBootstrappingServer(form.name);
    try {
      const result = await bootstrapServerCaddy(form);
      setBootstrapChecks((current) => ({ ...current, [form.name]: result }));
      if (!result.ok) onError(result.summary);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setBootstrappingServer(null);
    }
  }

  return (
    <div className="content-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">服务连接</span>
          <h1>构建、镜像和服务器</h1>
          <p>
            默认只验证权限；服务器初始化必须单独勾选确认，不会直接部署业务。
          </p>
        </div>
      </header>

      <section className="connection-section">
        <div className="connection-heading">
          <span className="connection-icon cnb">
            <CloudCog size={20} />
          </span>
          <div>
            <h2>CNB 云原生构建</h2>
            <p>用于创建仓库、构建镜像和查询发布状态。</p>
          </div>
          <ConnectionBadge ok={Boolean(cnbAccount)} />
        </div>
        <div className="connection-body two-columns">
          <label className="field-wide">
            CNB 访问令牌
            <span className="input-with-icon">
              <KeyRound size={16} />
              <input
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
                placeholder="仅发送给本机 Rust 进程"
                type="password"
                value={token}
              />
            </span>
          </label>
          <div className="connection-actions">
            <label className="checkbox-line">
              <input
                checked={rememberToken}
                onChange={(event) => setRememberToken(event.target.checked)}
                type="checkbox"
              />
              <span>保存到系统密钥库</span>
            </label>
            <button
              className="secondary-action"
              disabled={cnbLoading}
              onClick={handleCnbConnect}
              type="button"
            >
              {cnbLoading ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              {cnbAccount ? `已连接 ${cnbAccount}` : "验证并连接"}
            </button>
          </div>
        </div>
        <button
          className="inline-link"
          onClick={() =>
            openUrl("https://docs.cnb.cool/zh/guide/token.html").catch(() =>
              onError("无法打开 CNB 官方说明"),
            )
          }
          type="button"
        >
          获取访问令牌
          <ExternalLink size={14} />
        </button>
        {cnbAccount ? (
          <div className="repository-setup">
            <div className="repository-setup-heading">
              <GitBranch size={18} />
              <div>
                <strong>创建 CNB 项目仓库</strong>
                <span>已有仓库可直接在“环境配置”中填写，无需重复创建。</span>
              </div>
            </div>
            <div className="repository-form">
              <label>
                所属组织或用户名
                <input
                  autoComplete="off"
                  onChange={(event) => setRepositorySlug(event.target.value)}
                  placeholder="例如：your-team"
                  value={repositorySlug}
                />
              </label>
              <label>
                仓库名称
                <input
                  autoComplete="off"
                  onChange={(event) => setRepositoryName(event.target.value)}
                  placeholder="例如：my-project"
                  value={repositoryName}
                />
              </label>
              <label className="field-wide">
                仓库说明（可选）
                <input
                  onChange={(event) =>
                    setRepositoryDescription(event.target.value)
                  }
                  placeholder="这个仓库将用于项目代码和自动构建"
                  value={repositoryDescription}
                />
              </label>
            </div>
            <div className="repository-actions">
              <label className="checkbox-line">
                <input
                  checked={privateRepository}
                  onChange={(event) =>
                    setPrivateRepository(event.target.checked)
                  }
                  type="checkbox"
                />
                <LockKeyhole size={14} />
                <span>创建为私有仓库</span>
              </label>
              <button
                className="secondary-action"
                disabled={repositoryLoading}
                onClick={handleRepositoryCreate}
                type="button"
              >
                {repositoryLoading ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Plus size={17} />
                )}
                {repositoryLoading ? "正在创建" : "创建并选用"}
              </button>
            </div>
            {createdRepository ? (
              <span className="repository-success">
                <CheckCircle2 size={15} />
                已创建 {createdRepository.repository}（
                {createdRepository.visibility === "private" ? "私有" : "公开"}
                ），并写入当前部署计划
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="connection-section">
        <div className="connection-heading">
          <span className="connection-icon registry">
            <Container size={20} />
          </span>
          <div>
            <h2>镜像与本地预览</h2>
            <p>默认使用 CNB Docker 制品库，本地 Docker 仅用于完整预览。</p>
          </div>
          <ConnectionBadge ok={dockerCheck?.ok ?? false} optional />
        </div>
        <div className="provider-line">
          <div>
            <strong>CNB Docker 制品库</strong>
            <span>流水线使用 CNB 内置推送凭据</span>
          </div>
          <span className="tag success">默认</span>
        </div>
        <div className="provider-line">
          <div>
            <strong>本机 Docker</strong>
            <span>{dockerCheck?.summary ?? "尚未检查"}</span>
          </div>
          <button
            className="secondary-action compact"
            disabled={dockerLoading}
            onClick={handleDockerCheck}
            type="button"
          >
            {dockerLoading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Container size={16} />
            )}
            检查 Docker
          </button>
        </div>
      </section>

      <section className="connection-section">
        <div className="connection-heading">
          <span className="connection-icon server">
            <Server size={20} />
          </span>
          <div>
            <h2>目标服务器</h2>
            <p>测试和生产可以绑定同一台主机，但始终使用不同命名空间。</p>
          </div>
        </div>
        <div className="server-forms">
          <ServerConnectionForm
            check={serverChecks[staging.name]}
            bootstrapCheck={bootstrapChecks[staging.name]}
            bootstrapConfirmed={Boolean(bootstrapConfirmations[staging.name])}
            bootstrapLoading={bootstrappingServer === staging.name}
            form={staging}
            label="测试服务器"
            loading={checkingServer === staging.name}
            onChange={setStaging}
            onChooseKey={() => chooseKey(staging, setStaging)}
            onCheck={() => handleServerCheck(staging)}
            onBootstrap={() => handleCaddyBootstrap(staging)}
            onBootstrapConfirm={(confirmed) =>
              setBootstrapConfirmations((current) => ({
                ...current,
                [staging.name]: confirmed,
              }))
            }
          />
          <ServerConnectionForm
            check={serverChecks[production.name]}
            bootstrapCheck={bootstrapChecks[production.name]}
            bootstrapConfirmed={Boolean(
              bootstrapConfirmations[production.name],
            )}
            bootstrapLoading={bootstrappingServer === production.name}
            form={production}
            label="生产服务器"
            loading={checkingServer === production.name}
            onChange={setProduction}
            onChooseKey={() => chooseKey(production, setProduction)}
            onCheck={() => handleServerCheck(production)}
            onBootstrap={() => handleCaddyBootstrap(production)}
            onBootstrapConfirm={(confirmed) =>
              setBootstrapConfirmations((current) => ({
                ...current,
                [production.name]: confirmed,
              }))
            }
          />
        </div>
      </section>
    </div>
  );
}

interface ServerConnectionFormProps {
  label: string;
  form: ServerForm;
  check?: ProviderCheck;
  bootstrapCheck?: ProviderCheck;
  bootstrapConfirmed: boolean;
  bootstrapLoading: boolean;
  loading: boolean;
  onChange: (form: ServerForm) => void;
  onChooseKey: () => void;
  onCheck: () => void;
  onBootstrap: () => void;
  onBootstrapConfirm: (confirmed: boolean) => void;
}

function ServerConnectionForm({
  label,
  form,
  check,
  bootstrapCheck,
  bootstrapConfirmed,
  bootstrapLoading,
  loading,
  onChange,
  onChooseKey,
  onCheck,
  onBootstrap,
  onBootstrapConfirm,
}: ServerConnectionFormProps) {
  return (
    <div className="server-form">
      <div className="server-form-title">
        <div>
          <strong>{label}</strong>
          <span className="mono">{form.name}</span>
        </div>
        {check ? <ConnectionBadge ok={check.ok} /> : null}
      </div>
      <div className="form-grid">
        <label>
          地址
          <input
            onChange={(event) =>
              onChange({ ...form, host: event.target.value })
            }
            placeholder="服务器 IP 或域名"
            value={form.host}
          />
        </label>
        <label>
          用户名
          <input
            onChange={(event) =>
              onChange({ ...form, user: event.target.value })
            }
            value={form.user}
          />
        </label>
        <label className="field-wide">
          SSH 私钥
          <span className="file-input">
            <FileKey2 size={16} />
            <input
              onChange={(event) =>
                onChange({ ...form, keyPath: event.target.value })
              }
              placeholder="选择本机私钥文件"
              value={form.keyPath}
            />
            <button onClick={onChooseKey} title="选择 SSH 私钥" type="button">
              <FolderOpen size={16} />
            </button>
          </span>
        </label>
      </div>
      <button
        className="secondary-action compact"
        disabled={loading}
        onClick={onCheck}
        type="button"
      >
        {loading ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <ShieldCheck size={16} />
        )}
        验证 SSH
      </button>
      {check ? (
        <span
          className={check.ok ? "check-message success" : "check-message error"}
        >
          {check.summary}
        </span>
      ) : null}
      {check?.ok ? (
        <div className="bootstrap-actions">
          <label className="checkbox-line">
            <input
              checked={bootstrapConfirmed}
              onChange={(event) => onBootstrapConfirm(event.target.checked)}
              type="checkbox"
            />
            <span>允许创建 ~/.deploydesk 和独立 Caddy 容器</span>
          </label>
          <button
            className="secondary-action compact"
            disabled={!bootstrapConfirmed || bootstrapLoading}
            onClick={onBootstrap}
            type="button"
          >
            {bootstrapLoading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ServerCog size={16} />
            )}
            {bootstrapLoading ? "正在初始化" : "初始化 Caddy"}
          </button>
          {bootstrapCheck ? (
            <span
              className={
                bootstrapCheck.ok
                  ? "check-message success"
                  : "check-message error"
              }
            >
              {bootstrapCheck.summary}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionBadge({
  ok,
  optional = false,
}: {
  ok: boolean;
  optional?: boolean;
}) {
  return (
    <span className={ok ? "connection-badge connected" : "connection-badge"}>
      {ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
      {ok ? "已连接" : optional ? "可选" : "待连接"}
    </span>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
