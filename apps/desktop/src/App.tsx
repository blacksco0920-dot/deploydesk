import {
  CheckCircle2,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  applyManifest,
  getPreflight,
  openProject,
  previewManifest,
  selectProjectDirectory,
} from "./api";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { EnvironmentEditor } from "./components/EnvironmentEditor";
import { PlanPanel } from "./components/PlanPanel";
import { ProjectOverview } from "./components/ProjectOverview";
import { Sidebar } from "./components/Sidebar";
import { WelcomePanel } from "./components/WelcomePanel";
import type {
  ApplyResult,
  NavigationSection,
  SystemPreflight,
  WorkspacePreview,
} from "./types";
import "./App.css";

const sectionNames: Record<NavigationSection, string> = {
  overview: "项目识别",
  environments: "环境配置",
  connections: "服务连接",
  plan: "部署计划",
};

function App() {
  const [active, setActive] = useState<NavigationSection>("overview");
  const [preflight, setPreflight] = useState<SystemPreflight | null>(null);
  const [workspace, setWorkspace] = useState<WorkspacePreview | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    getPreflight()
      .then(setPreflight)
      .catch((reason) => setError(toMessage(reason)));
  }, []);

  async function selectProject() {
    setError(null);
    const selected = await selectProjectDirectory();
    if (!selected) return;
    await loadProject(selected);
  }

  async function loadProject(path: string) {
    setLoading(true);
    setError(null);
    setNotice(null);
    setApplyResult(null);
    try {
      const result = await openProject(path);
      setWorkspace(result);
      setProjectPath(path);
      setActive("overview");
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  async function updateManifest(manifestYaml: string) {
    if (!projectPath) return;
    setSaving(true);
    setError(null);
    try {
      const result = await previewManifest(projectPath, manifestYaml);
      setWorkspace(result);
      setNotice("环境配置已更新，部署计划已重新计算。");
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function applyCurrentPlan() {
    if (!workspace || !projectPath) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyManifest(
        projectPath,
        workspace.manifestYaml,
      );
      setApplyResult(result);
      const refreshed = await openProject(projectPath);
      setWorkspace(refreshed);
      setNotice("部署配置已写入，原文件已自动备份。");
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setApplying(false);
    }
  }

  function renderContent() {
    if (!workspace) {
      return (
        <WelcomePanel
          loading={loading}
          onDemo={() => loadProject("/demo/ecat-energy")}
          onSelect={selectProject}
          showDemo={!isTauri()}
        />
      );
    }
    switch (active) {
      case "overview":
        return <ProjectOverview workspace={workspace} />;
      case "environments":
        return (
          <EnvironmentEditor
            onSave={updateManifest}
            saving={saving}
            workspace={workspace}
          />
        );
      case "connections":
        return <ConnectionsPanel onError={setError} />;
      case "plan":
        return (
          <PlanPanel
            applying={applying}
            applyResult={applyResult}
            onApply={applyCurrentPlan}
            workspace={workspace}
          />
        );
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        active={active}
        hasWorkspace={Boolean(workspace)}
        onChange={setActive}
        preflight={preflight}
      />
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{workspace?.inspection.project_name ?? "工作区"}</span>
            <span>/</span>
            <strong>{sectionNames[active]}</strong>
          </div>
          <div className="topbar-actions">
            {workspace ? (
              <button
                className="icon-action"
                onClick={() => loadProject(projectPath)}
                title="重新识别项目"
                type="button"
              >
                <RefreshCw size={17} />
              </button>
            ) : null}
            <button
              className="secondary-action compact"
              onClick={selectProject}
              type="button"
            >
              <FolderOpen size={16} />
              {workspace ? "切换项目" : "选择项目"}
            </button>
          </div>
        </header>
        <main className="main-content">{renderContent()}</main>
      </div>

      {loading ? (
        <div className="loading-layer" role="status">
          <LoaderCircle className="spin" size={25} />
          <span>正在只读识别项目</span>
        </div>
      ) : null}
      {error ? (
        <div className="toast error-toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="关闭" type="button">
            <X size={16} />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="toast success-toast" role="status">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} title="关闭" type="button">
            <X size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default App;
