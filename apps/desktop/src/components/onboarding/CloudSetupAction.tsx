import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  FileKey2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ensureCnbRepository,
  getCnbAccount,
  prepareCnbSecretBundle,
} from "../../api";
import type { ServerForm, WorkspacePreview } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface CloudSetupActionProps {
  completing: boolean;
  onBackToRequirements: () => void;
  onComplete: (
    codeRepository: string,
    secretRepository: string,
  ) => Promise<void>;
  onError: (message: string) => void;
  path: string;
  server: ServerForm;
  workspace: WorkspacePreview;
}

type DeployEnvironment = "staging" | "production";

export function CloudSetupAction({
  completing,
  onBackToRequirements,
  onComplete,
  onError,
  path,
  server,
  workspace,
}: CloudSetupActionProps) {
  const projectName = workspace.inspection.project_name;
  const [username, setUsername] = useState("");
  const [secretRepository, setSecretRepository] = useState("");
  const [codeRepository, setCodeRepository] = useState("");
  const [codeReady, setCodeReady] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [preparingCode, setPreparingCode] = useState(false);
  const [copying, setCopying] = useState<DeployEnvironment | null>(null);
  const [copied, setCopied] = useState<Record<DeployEnvironment, boolean>>({
    staging: false,
    production: false,
  });
  const [pasted, setPasted] = useState<Record<DeployEnvironment, boolean>>({
    staging: false,
    production: false,
  });
  const [missing, setMissing] = useState<string[]>([]);
  const [deployFingerprint, setDeployFingerprint] = useState("");

  const suggestedSecretName = useMemo(
    () => `${projectName}-deploy-secrets`.slice(0, 100),
    [projectName],
  );

  useEffect(() => {
    getCnbAccount()
      .then((account) => {
        if (!account.connected || !account.username) {
          throw new Error("CNB 登录状态已失效，请返回连接步骤重新授权");
        }
        setUsername(account.username);
        setCodeRepository(`${account.username}/${projectName}`);
        setSecretRepository(`${account.username}/${suggestedSecretName}`);
      })
      .catch((error) => onError(toMessage(error)))
      .finally(() => setLoadingAccount(false));
  }, [onError, projectName, suggestedSecretName]);

  async function prepareCodeRepository() {
    if (!username) return;
    setPreparingCode(true);
    try {
      const result = await ensureCnbRepository(username, projectName);
      setCodeRepository(result.repository);
      setCodeReady(true);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setPreparingCode(false);
    }
  }

  async function copyEnvironment(environment: DeployEnvironment) {
    if (!validRepository(secretRepository)) {
      onError("请填写完整的 CNB 密钥仓库路径，例如 team/project-secrets");
      return;
    }
    setCopying(environment);
    setMissing([]);
    try {
      const bundle = await prepareCnbSecretBundle(
        path,
        environment,
        secretRepository,
        server,
      );
      if (bundle.missingVariables.length) {
        setMissing(bundle.missingVariables);
        onError(`还缺 ${bundle.missingVariables.join("、")} 的环境配置`);
        return;
      }
      await navigator.clipboard.writeText(bundle.content);
      bundle.content = "";
      setDeployFingerprint(bundle.deployKeyFingerprint);
      setCopied((current) => ({ ...current, [environment]: true }));
      try {
        await openUrl(`https://cnb.cool/${secretRepository}`);
      } catch {
        window.open(
          `https://cnb.cool/${secretRepository}`,
          "_blank",
          "noopener,noreferrer",
        );
      }
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setCopying(null);
    }
  }

  async function finish() {
    if (!codeReady || !pasted.staging || !pasted.production) return;
    await onComplete(codeRepository, secretRepository);
  }

  return (
    <div>
      <span className="mb-4 grid size-10 place-items-center rounded-lg bg-[var(--warning-soft)] text-[var(--warning)]">
        <ShieldCheck className="size-5" />
      </span>
      <h1 className="m-0 text-2xl font-semibold">保存一次安全部署配置</h1>
      <p className="mb-8 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        CNB
        要求这一步在受审计网页完成。按顺序保存测试和正式配置后，后续项目部署不再重复准备服务器。
      </p>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <SetupRow
          description={
            codeReady
              ? `已使用 ${codeRepository}`
              : "用于接收代码并构建不可变镜像"
          }
          done={codeReady}
          icon={Cloud}
          title="准备私有构建仓库"
        >
          <Button
            disabled={loadingAccount || preparingCode}
            onClick={prepareCodeRepository}
            size="sm"
            variant="secondary"
          >
            {preparingCode ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : codeReady ? (
              <Check />
            ) : (
              <Cloud />
            )}
            {codeReady ? "已准备" : "自动准备"}
          </Button>
        </SetupRow>

        <div className="border-t border-[var(--border)] px-4 py-4">
          <div className="flex items-start gap-3">
            <FileKey2 className="mt-0.5 size-4 shrink-0 text-[var(--muted-foreground)]" />
            <div className="min-w-0 flex-1">
              <strong className="block text-sm font-medium">
                准备安全配置仓库
              </strong>
              <span className="mt-0.5 block text-xs leading-5 text-[var(--muted-foreground)]">
                打开后选择“密钥仓库”，名称建议使用 {suggestedSecretName}
              </span>
            </div>
            <Button
              onClick={() => openUrl("https://cnb.cool/new/repos")}
              size="sm"
              variant="secondary"
            >
              <ExternalLink />
              去创建
            </Button>
          </div>
          <label className="mt-3 block space-y-1.5 pl-7">
            <span className="text-xs font-medium">密钥仓库路径</span>
            <Input
              onChange={(event) => {
                setSecretRepository(event.target.value.trim());
                setCopied({ staging: false, production: false });
                setPasted({ staging: false, production: false });
              }}
              placeholder="所属组织/仓库名"
              value={secretRepository}
            />
          </label>
        </div>

        {(["staging", "production"] as const).map((environment) => {
          const label = environment === "staging" ? "测试" : "生产";
          const filename = `env.${environment}.yml`;
          return (
            <div
              className="border-t border-[var(--border)] px-4 py-4"
              key={environment}
            >
              <div className="flex flex-wrap items-center gap-3 pl-7">
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">
                    保存{label}环境配置
                  </strong>
                  <code className="mt-0.5 block text-[11px] text-[var(--muted-foreground)]">
                    {filename}
                  </code>
                </span>
                <Button
                  disabled={copying === environment}
                  onClick={() => copyEnvironment(environment)}
                  size="sm"
                  variant="secondary"
                >
                  {copying === environment ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : copied[environment] ? (
                    <Check />
                  ) : (
                    <Copy />
                  )}
                  {copied[environment] ? "已复制并打开" : "复制并打开 CNB"}
                </Button>
                <Button
                  disabled={!validRepository(secretRepository)}
                  onClick={() =>
                    openUrl(`https://cnb.cool/${secretRepository}`)
                  }
                  size="icon"
                  title="打开密钥仓库"
                  variant="ghost"
                >
                  <ExternalLink />
                </Button>
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 pl-7 text-xs text-[var(--muted-foreground)]">
                <input
                  checked={pasted[environment]}
                  className="size-4 accent-[var(--accent)]"
                  disabled={!copied[environment]}
                  onChange={(event) =>
                    setPasted((current) => ({
                      ...current,
                      [environment]: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                我已新建 {filename}，粘贴并保存
              </label>
            </div>
          );
        })}
      </section>

      {missing.length ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-[var(--warning-soft)] px-3 py-2.5 text-xs text-[var(--warning)]">
          <span className="min-w-0">还缺：{missing.join("、")}</span>
          <Button onClick={onBackToRequirements} size="sm" variant="secondary">
            <RefreshCw />
            返回补充
          </Button>
        </div>
      ) : null}

      {deployFingerprint ? (
        <p className="mb-0 mt-4 text-[11px] text-[var(--subtle-foreground)]">
          持续部署专用身份：{deployFingerprint}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Button
          disabled={
            completing || !codeReady || !pasted.staging || !pasted.production
          }
          onClick={finish}
          size="lg"
        >
          {completing ? (
            <LoaderCircle className="animate-spin-slow" />
          ) : (
            <Check />
          )}
          {completing ? "正在验证并继续" : "完成并继续部署"}
        </Button>
      </div>
    </div>
  );
}

function SetupRow({
  children,
  description,
  done,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  description: string;
  done: boolean;
  icon: typeof Cloud;
  title: string;
}) {
  return (
    <div className="flex min-h-[68px] items-center gap-3 px-4">
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-md ${
          done
            ? "bg-[var(--success-soft)] text-[var(--success)]"
            : "bg-[var(--muted)] text-[var(--muted-foreground)]"
        }`}
      >
        {done ? <Check className="size-4" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-medium">{title}</strong>
        <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">
          {description}
        </span>
      </span>
      {children}
    </div>
  );
}

function validRepository(value: string) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
