import { isTauri } from "@tauri-apps/api/core";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  applyManifest,
  forgetProject,
  getPreflight,
  listRecentProjects,
  listDeploymentRuns,
  listServers,
  openProject,
  promoteProductionDeployment,
  previewManifest,
  refreshDeployment,
  saveProjectStep,
  selectProjectDirectory,
  startStagingDeployment,
} from "./api";
import { ProjectHome } from "./components/ProjectHome";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { ConnectionStep } from "./components/onboarding/ConnectionStep";
import { DeploymentProgress } from "./components/onboarding/DeploymentProgress";
import { InspectionStep } from "./components/onboarding/InspectionStep";
import { OnboardingLayout } from "./components/onboarding/OnboardingLayout";
import { RecommendationStep } from "./components/onboarding/RecommendationStep";
import { RequirementsStep } from "./components/onboarding/RequirementsStep";
import { ReviewStep } from "./components/onboarding/ReviewStep";
import { Button } from "./components/ui/button";
import type {
  OnboardingStep,
  DeploymentRun,
  RecentProject,
  ServerForm,
  SystemPreflight,
  WorkspacePreview,
} from "./types";

type AppScreen = "home" | "onboarding" | "workspace";

const onboardingSteps: OnboardingStep[] = [
  "inspection",
  "connections",
  "recommendation",
  "requirements",
  "review",
];

function App() {
  const [screen, setScreen] = useState<AppScreen>("home");
  const [step, setStep] = useState<OnboardingStep>("inspection");
  const [preflight, setPreflight] = useState<SystemPreflight | null>(null);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [workspace, setWorkspace] = useState<WorkspacePreview | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [connectionsReady, setConnectionsReady] = useState(false);
  const [lastServer, setLastServer] = useState<ServerForm | undefined>();
  const [deploymentRuns, setDeploymentRuns] = useState<DeploymentRun[]>([]);
  const [currentRun, setCurrentRun] = useState<DeploymentRun | null>(null);

  const reportError = useCallback((message: string) => {
    toast.error(message, { duration: 7000 });
  }, []);

  const handleConnectionState = useCallback(
    (state: { cnb: boolean; server: boolean; serverForm: ServerForm }) => {
      setConnectionsReady(state.cnb && state.server);
      setLastServer(state.serverForm);
    },
    [],
  );

  const refreshProjects = useCallback(async () => {
    const recent = await listRecentProjects();
    setProjects(recent);
    return recent;
  }, []);

  const loadProject = useCallback(
    async (path: string, resumeStep: OnboardingStep = "inspection") => {
      setLoading(true);
      try {
        const result = await openProject(path);
        setWorkspace(result);
        setProjectPath(path);
        const runs = await listDeploymentRuns(path);
        setDeploymentRuns(runs);
        const resumable = runs.find((run) =>
          ["queued", "running", "needs_action", "failed"].includes(run.status),
        );
        const effectiveStep =
          resumeStep === "deploying" && !resumable ? "review" : resumeStep;
        setCurrentRun(resumable ?? runs[0] ?? null);
        setStep(effectiveStep);
        setScreen(effectiveStep === "workspace" ? "workspace" : "onboarding");
        await refreshProjects();
      } catch (error) {
        reportError(toMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [refreshProjects, reportError],
  );

  useEffect(() => {
    let active = true;
    Promise.all([getPreflight(), listRecentProjects(), listServers()])
      .then(async ([system, recent, servers]) => {
        if (!active) return;
        setPreflight(system);
        setProjects(recent);
        const reusableServer = servers.find((server) => server.keyPathExists);
        if (reusableServer) {
          setLastServer({
            name: reusableServer.name,
            host: reusableServer.host,
            user: reusableServer.user,
            port: reusableServer.port,
            keyPath: reusableServer.keyPath,
            hostFingerprint: reusableServer.hostFingerprint,
          });
        }
        if (recent.length === 1 && recent[0].pathExists) {
          await loadProject(recent[0].path, recent[0].currentStep);
        }
      })
      .catch((error) => reportError(toMessage(error)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [loadProject, reportError]);

  async function selectProject() {
    const selected = await selectProjectDirectory();
    if (selected) await loadProject(selected);
  }

  async function forgetRecent(project: RecentProject) {
    try {
      await forgetProject(project.path);
      await refreshProjects();
      if (project.path === projectPath) {
        setWorkspace(null);
        setProjectPath("");
        setScreen("home");
      }
      toast.success("已移除本机项目记录");
    } catch (error) {
      reportError(toMessage(error));
    }
  }

  async function goToStep(next: OnboardingStep) {
    if (!projectPath) return;
    try {
      await saveProjectStep(projectPath, next);
      setStep(next);
      setScreen(next === "workspace" ? "workspace" : "onboarding");
      await refreshProjects();
    } catch (error) {
      reportError(toMessage(error));
    }
  }

  async function updateManifest(manifestYaml: string) {
    if (!projectPath) return false;
    setSaving(true);
    try {
      const result = await previewManifest(projectPath, manifestYaml);
      setWorkspace(result);
      toast.success("推荐方案已更新");
      return true;
    } catch (error) {
      reportError(toMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function applyCurrentPlan() {
    if (!workspace || !projectPath) return;
    setApplying(true);
    try {
      const result = await applyManifest(projectPath, workspace.manifestYaml);
      const refreshed = await openProject(projectPath);
      setWorkspace(refreshed);
      const run = await startStagingDeployment(projectPath);
      setCurrentRun(run);
      setDeploymentRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      await saveProjectStep(projectPath, "deploying");
      setStep("deploying");
      setScreen("onboarding");
      await refreshProjects();
      toast.success(`部署配置已生成，共更新 ${result.writtenFiles.length} 个文件`);
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      setApplying(false);
    }
  }

  const refreshCurrentDeployment = useCallback(async () => {
    if (!currentRun) return;
    try {
      const updated = await refreshDeployment(currentRun.id);
      setCurrentRun(updated);
      setDeploymentRuns((current) => [
        updated,
        ...current.filter((item) => item.id !== updated.id),
      ]);
    } catch (error) {
      reportError(toMessage(error));
    }
  }, [currentRun, reportError]);

  useEffect(() => {
    if (
      screen !== "onboarding" ||
      step !== "deploying" ||
      !currentRun ||
      !["queued", "running"].includes(currentRun.status)
    ) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshCurrentDeployment();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [currentRun, refreshCurrentDeployment, screen, step]);

  async function retryDeployment() {
    if (!projectPath) return;
    setApplying(true);
    try {
      const run = await startStagingDeployment(projectPath);
      setCurrentRun(run);
      setDeploymentRuns((current) => [run, ...current]);
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      setApplying(false);
    }
  }

  async function finishDeployment() {
    await goToStep("workspace");
  }

  async function promoteToProduction(source: DeploymentRun) {
    setApplying(true);
    try {
      const run = await promoteProductionDeployment(source.id);
      setCurrentRun(run);
      setDeploymentRuns((current) => [run, ...current]);
      await saveProjectStep(projectPath, "deploying");
      setStep("deploying");
      setScreen("onboarding");
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      setApplying(false);
    }
  }

  function backStep() {
    const index = onboardingSteps.indexOf(step);
    if (index > 0) void goToStep(onboardingSteps[index - 1]);
  }

  function nextStep() {
    const index = onboardingSteps.indexOf(step);
    if (index >= 0 && index < onboardingSteps.length - 1) {
      void goToStep(onboardingSteps[index + 1]);
    }
  }

  function renderOnboarding() {
    if (!workspace) return null;
    const footer =
      step === "review" || step === "deploying" ? (
        <span className="text-xs text-[var(--muted-foreground)]">
          {step === "deploying" ? "部署状态会自动保存" : "请在上方确认变更"}
        </span>
      ) : (
        <Button
          disabled={step === "connections" && !connectionsReady}
          onClick={nextStep}
        >
          {step === "inspection"
            ? "结果正确，继续"
            : step === "connections"
              ? "使用这些连接"
              : step === "recommendation"
                ? "使用推荐方案"
                : "查看部署计划"}
          <ArrowRight />
        </Button>
      );

    return (
      <OnboardingLayout
        footer={footer}
        onBack={
          step === "inspection" || step === "deploying" ? undefined : backStep
        }
        onClose={() => setScreen("home")}
        projectName={workspace.inspection.project_name}
        step={step}
      >
        {step === "inspection" ? <InspectionStep workspace={workspace} /> : null}
        {step === "connections" ? (
          <ConnectionStep
            initialServer={lastServer}
            onError={reportError}
            onStateChange={handleConnectionState}
          />
        ) : null}
        {step === "recommendation" ? (
          <RecommendationStep workspace={workspace} />
        ) : null}
        {step === "requirements" ? (
          <RequirementsStep
            onError={reportError}
            onUpdate={updateManifest}
            saving={saving}
            workspace={workspace}
          />
        ) : null}
        {step === "review" ? (
          <ReviewStep
            applying={applying}
            onApply={applyCurrentPlan}
            workspace={workspace}
          />
        ) : null}
        {step === "deploying" && currentRun ? (
          <DeploymentProgress
            onRefresh={refreshCurrentDeployment}
            onRetry={retryDeployment}
            onWorkspace={finishDeployment}
            run={currentRun}
          />
        ) : null}
      </OnboardingLayout>
    );
  }

  return (
    <>
      {screen === "home" ? (
        <ProjectHome
          loading={loading}
          onDemo={() => loadProject("/demo/ecat-energy")}
          onForget={forgetRecent}
          onOpen={(project) => loadProject(project.path, project.currentStep)}
          onSelect={selectProject}
          preflight={preflight}
          projects={projects}
          showDemo={!isTauri()}
        />
      ) : null}

      {screen === "onboarding" ? renderOnboarding() : null}

      {screen === "workspace" && workspace ? (
        <WorkspaceShell
          onDeploy={() => goToStep("review")}
          onForget={() => {
            const current = projects.find((project) => project.path === projectPath);
            if (current) void forgetRecent(current);
          }}
          onHome={() => setScreen("home")}
          onPromote={promoteToProduction}
          onRefresh={() => loadProject(projectPath, "workspace")}
          path={projectPath}
          preflight={preflight}
          runs={deploymentRuns}
          workspace={workspace}
        />
      ) : null}

      {loading && screen !== "home" ? (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-[var(--background)]/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <LoaderCircle className="size-5 animate-spin-slow" />
            正在只读识别项目
          </div>
        </div>
      ) : null}

      <Toaster
        closeButton
        position="top-right"
        richColors
        toastOptions={{ duration: 4500 }}
      />
    </>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default App;
