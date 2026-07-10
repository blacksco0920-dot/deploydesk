import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileWarning,
  GitCompareArrows,
  KeyRound,
  LoaderCircle,
  Network,
  Rocket,
  Server,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ApplyResult,
  FileChange,
  UserAction,
  WorkspacePreview,
} from "../types";

interface PlanPanelProps {
  workspace: WorkspacePreview;
  applying: boolean;
  applyResult: ApplyResult | null;
  onApply: () => Promise<void>;
}

export function PlanPanel({
  workspace,
  applying,
  applyResult,
  onApply,
}: PlanPanelProps) {
  const changedFiles = useMemo(
    () => workspace.plan.changes.filter((change) => change.kind !== "unchanged"),
    [workspace.plan.changes],
  );
  const [selectedPath, setSelectedPath] = useState(
    changedFiles[0]?.path ?? workspace.plan.changes[0]?.path ?? "",
  );
  const [view, setView] = useState<"before" | "after">("after");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!workspace.plan.changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(
        changedFiles[0]?.path ?? workspace.plan.changes[0]?.path ?? "",
      );
    }
    setConfirmed(false);
  }, [changedFiles, selectedPath, workspace.plan.changes]);

  const selected = workspace.plan.changes.find(
    (change) => change.path === selectedPath,
  );

  return (
    <div className="content-stack plan-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">部署计划</span>
          <h1>确认后再写入项目</h1>
          <p>
            计划 {workspace.plan.id}，{changedFiles.length} 个文件会发生变化。
          </p>
        </div>
        <span className="heading-status neutral">
          <GitCompareArrows size={18} />
          纯预览
        </span>
      </header>

      {applyResult ? (
        <section className="apply-success">
          <CheckCircle2 size={21} />
          <div>
            <strong>部署配置已写入</strong>
            <span>
              {applyResult.writtenFiles.length} 个文件已更新，原文件已自动备份。
            </span>
          </div>
        </section>
      ) : null}

      <section className="plan-columns">
        <div className="action-panel">
          <div className="section-heading">
            <div>
              <h2>需要你处理</h2>
              <p>只有这些步骤需要人工输入或确认。</p>
            </div>
            <span className="count-badge">{workspace.plan.user_actions.length}</span>
          </div>
          <div className="action-list">
            {workspace.plan.user_actions.map((action) => (
              <ActionItem action={action} key={action.id} />
            ))}
          </div>
        </div>

        <div className="pipeline-panel">
          <div className="section-heading">
            <div>
              <h2>自动执行</h2>
              <p>失败时保留完成位置和上一个健康版本。</p>
            </div>
          </div>
          <div className="pipeline-list">
            {workspace.plan.steps.map((step, index) => (
              <div className="pipeline-step" key={step.id}>
                <span className="step-number">{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <span>{step.detail}</span>
                </div>
                <span className="executor-tag">{executorName(step.executor)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="diff-section">
        <div className="section-heading">
          <div>
            <h2>文件变化</h2>
            <p>敏感内容会在进入预览前自动脱敏。</p>
          </div>
          <div className="segmented-control compact-control">
            <button
              className={view === "before" ? "selected" : ""}
              disabled={!selected?.before}
              onClick={() => setView("before")}
              type="button"
            >
              写入前
            </button>
            <button
              className={view === "after" ? "selected" : ""}
              onClick={() => setView("after")}
              type="button"
            >
              写入后
            </button>
          </div>
        </div>
        <div className="diff-workbench">
          <div className="file-list" role="listbox" aria-label="变更文件">
            {workspace.plan.changes.map((change) => (
              <button
                aria-selected={selectedPath === change.path}
                className={selectedPath === change.path ? "selected" : ""}
                key={change.path}
                onClick={() => {
                  setSelectedPath(change.path);
                  if (!change.before) setView("after");
                }}
                type="button"
              >
                <FileChangeIcon change={change} />
                <span title={change.path}>{change.path}</span>
                <small>{changeLabel(change)}</small>
              </button>
            ))}
          </div>
          <div className="code-preview">
            <div className="code-preview-title">
              <FileCode2 size={15} />
              <span>{selected?.path ?? "未选择文件"}</span>
            </div>
            <pre>
              <code>
                {selected
                  ? view === "before"
                    ? selected.before ?? "此文件尚不存在"
                    : selected.after
                  : "暂无变化"}
              </code>
            </pre>
          </div>
        </div>
      </section>

      {workspace.plan.warnings.length ? (
        <section className="warning-list">
          {workspace.plan.warnings.map((warning) => (
            <div key={warning}>
              <AlertTriangle size={17} />
              <span>{warning}</span>
            </div>
          ))}
        </section>
      ) : null}

      <footer className="apply-bar">
        <label className="checkbox-line confirmation-line">
          <input
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
          />
          <span>我已查看文件变化，允许写入项目；现有文件将自动备份。</span>
        </label>
        <button
          className="primary-action"
          disabled={!confirmed || applying || changedFiles.length === 0}
          onClick={onApply}
          type="button"
        >
          {applying ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Rocket size={17} />
          )}
          {applying ? "正在写入" : "应用部署配置"}
        </button>
      </footer>
    </div>
  );
}

function ActionItem({ action }: { action: UserAction }) {
  const Icon = {
    authorization: KeyRound,
    server: Server,
    dns: Network,
    secret: ShieldCheck,
    approval: UserCheck,
  }[action.category];
  return (
    <div className="action-item">
      <span className={`action-icon ${action.category}`}>
        <Icon size={17} />
      </span>
      <div>
        <strong>{action.title}</strong>
        <span>{action.detail}</span>
      </div>
      <span className={action.required ? "required-tag" : "optional-tag"}>
        {action.required ? "必需" : "可选"}
      </span>
      <ChevronRight size={16} />
    </div>
  );
}

function FileChangeIcon({ change }: { change: FileChange }) {
  if (change.kind === "create") return <FilePlus2 size={16} />;
  if (change.kind === "update") return <FileWarning size={16} />;
  return <CheckCircle2 size={16} />;
}

function changeLabel(change: FileChange) {
  if (change.kind === "create") return "新增";
  if (change.kind === "update") return "更新";
  return "一致";
}

function executorName(executor: string) {
  return {
    local: "本机",
    cnb: "CNB",
    server: "服务器",
    user: "人工",
  }[executor];
}
