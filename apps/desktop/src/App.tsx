import { isTauri } from "@tauri-apps/api/core";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { parseDocument } from "yaml";
import {
  applyManifest,
  bindProjectServer,
  bootstrapServerCaddy,
  enableCnbAutoTrigger,
  forgetProject,
  getPreflight,
  getAppSetting,
  listActiveDeploymentRuns,
  listRecentProjects,
  listDeploymentRuns,
  listServers,
  openProject,
  promoteProductionDeployment,
  previewManifest,
  preparePipelineIdentity,
  refreshDeployment,
  resumeStagingDeployment,
  rollbackEnvironment,
  saveProjectStep,
  setAppSetting,
  selectProjectDirectory,
  startStagingDeployment,
  syncExternalDeployments,
  syncProjectToCnb,
} from "./api";
import { AppShell } from "./components/AppShell";
import { ProjectHome } from "./components/ProjectHome";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { ConnectionStep } from "./components/onboarding/ConnectionStep";
import { CloudSetupAction } from "./components/onboarding/CloudSetupAction";
import { DeploymentProgress } from "./components/onboarding/DeploymentProgress";
import { InspectionStep } from "./components/onboarding/InspectionStep";
import { OnboardingLayout } from "./components/onboarding/OnboardingLayout";
import { RecommendationStep } from "./components/onboarding/RecommendationStep";
import { RequirementsStep } from "./components/onboarding/RequirementsStep";
import { ReviewStep } from "./components/onboarding/ReviewStep";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { issueFromProvider, issueFromUnknown } from "./lib/errors";
import type {
  OnboardingStep,
  DeploymentRun,
  RecentProject,
  ServerForm,
  SystemPreflight,
  UserFacingIssue,
  WorkspacePreview,
} from "./types";

type AppScreen = "home" | "onboarding" | "workspace";

interface PendingCloudSetup {
  codeRepository: string;
  secretRepository: string;
  issue: UserFacingIssue;
}

interface PendingDeploymentSync {
  repository: string;
  branch: string;
  writtenFiles: number;
  issue: UserFacingIssue;
}

export function shouldRefreshDeploymentStatus(
  screen: AppScreen,
  step: OnboardingStep,
) {
  return screen === "workspace" || step === "deploying";
}

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
  const [requirementsReady, setRequirementsReady] = useState(false);
  const [registryChoice, setRegistryChoice] = useState<{
    mode: "tcr" | "cnb";
    namespace: string;
  }>({ mode: "tcr", namespace: "" });
  const [lastServer, setLastServer] = useState<ServerForm | undefined>();
  const [deploymentRuns, setDeploymentRuns] = useState<DeploymentRun[]>([]);
  const [currentRun, setCurrentRun] = useState<DeploymentRun | null>(null);
  const [deploymentIssue, setDeploymentIssue] =
    useState<UserFacingIssue | null>(null);
  const [pendingCloudSetup, setPendingCloudSetup] =
    useState<PendingCloudSetup | null>(null);
  const [pendingDeploymentSync, setPendingDeploymentSync] =
    useState<PendingDeploymentSync | null>(null);

  const reportError = useCallback((message: string) => {
    const issue = issueFromUnknown(message, "当前步骤没有完成");
    const nextStep = issue.nextSteps[0];
    toast.error(`${issue.code} · ${issue.title}`, {
      description: [issue.message, nextStep ? `下一步：${nextStep}` : ""]
        .filter(Boolean)
        .join(" "),
      duration: 9000,
    });
  }, []);

  const reportDeploymentIssue = useCallback((issue: UserFacingIssue) => {
    setDeploymentIssue(issue);
    toast.error(`${issue.code} · ${issue.title}`, {
      description: issue.message,
      duration: 9000,
    });
  }, []);

  const handleConnectionState = useCallback(
    (state: {
      cnb: boolean;
      registry: boolean;
      registryMode: "tcr" | "cnb";
      registryNamespace: string;
      server: boolean;
      serverForm: ServerForm;
    }) => {
      setConnectionsReady(state.cnb && state.registry && state.server);
      setRegistryChoice({
        mode: state.registryMode,
        namespace: state.registryNamespace,
      });
      setLastServer(state.serverForm);
      if (state.server) setDeploymentIssue(null);
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
      setDeploymentIssue(null);
      setRequirementsReady(false);
      try {
        const result = await openProject(path);
        setWorkspace(result);
        setProjectPath(path);
        await setAppSetting("active-project", path);
        if (
          result.manifestExists &&
          (resumeStep === "deploying" || resumeStep === "workspace")
        ) {
          await syncExternalDeployments(path).catch(() => []);
        }
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
    Promise.all([
      getPreflight(),
      listRecentProjects(),
      listServers(),
      getAppSetting("active-project"),
    ])
      .then(async ([system, recent, servers, activeProject]) => {
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
        const resumable =
          recent.find(
            (project) => project.path === activeProject && project.pathExists,
          ) ?? (recent.length === 1 && recent[0].pathExists ? recent[0] : null);
        if (resumable) {
          await loadProject(resumable.path, resumable.currentStep);
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
        await setAppSetting("active-project", "");
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
    if (!lastServer?.host || !lastServer.hostFingerprint) {
      reportDeploymentIssue({
        code: "AD-SSH-104",
        title: "目标服务器尚未通过身份验证",
        message: "ABCDeploy 还不能确认即将修改的是你选择的那台服务器。",
        nextSteps: ["返回服务器连接步骤，重新验证地址和服务器指纹"],
        technicalDetails: [],
        retryable: true,
      });
      return;
    }
    setDeploymentIssue(null);
    setApplying(true);
    try {
      const serverSetup = await bootstrapServerCaddy(lastServer);
      if (!serverSetup.ok) {
        reportDeploymentIssue(issueFromProvider(serverSetup));
        return;
      }
      await Promise.all([
        bindProjectServer(projectPath, "staging", lastServer),
        bindProjectServer(projectPath, "production", lastServer),
      ]);
      await preparePipelineIdentity(projectPath, lastServer);
      const result = await applyManifest(projectPath, workspace.manifestYaml);
      const refreshed = await openProject(projectPath);
      setWorkspace(refreshed);
      if (currentRun?.actionKind === "cloud-setup") {
        await saveProjectStep(projectPath, "deploying");
        setStep("deploying");
        setScreen("onboarding");
        toast.success("项目配置已更新，可以继续完成 CNB 保护配置");
        return;
      }
      const document = parseDocument(refreshed.manifestYaml);
      const data = document.toJS() as {
        providers?: { build?: { repository?: string } };
        source?: { release_branch?: string };
      };
      const repository = data.providers?.build?.repository?.trim();
      if (!repository) throw new Error("CNB 代码仓库尚未配置");
      const branch = data.source?.release_branch ?? "main";
      try {
        await syncAndStartStaging(repository, branch, false);
      } catch (error) {
        const issue = issueFromUnknown(error, "项目代码尚未同步");
        if (issue.code === "AD-GIT-101") {
          setPendingDeploymentSync({
            repository,
            branch,
            writtenFiles: result.writtenFiles.length,
            issue,
          });
          return;
        }
        throw error;
      }
      toast.success(
        `服务器与部署配置已准备完成，共更新 ${result.writtenFiles.length} 个文件`,
      );
    } catch (error) {
      reportDeploymentIssue(issueFromUnknown(error, "首次部署未能开始"));
    } finally {
      setApplying(false);
    }
  }

  async function syncAndStartStaging(
    repository: string,
    branch: string,
    allowUncommitted: boolean,
  ) {
    const source = await syncProjectToCnb(
      projectPath,
      repository,
      branch,
      allowUncommitted,
    );
    const run = await startStagingDeployment(
      projectPath,
      source.commitSha,
      true,
    );
    setCurrentRun(run);
    setDeploymentRuns((current) => [
      run,
      ...current.filter((item) => item.id !== run.id),
    ]);
    await saveProjectStep(projectPath, "deploying");
    setStep("deploying");
    setScreen("onboarding");
    await refreshProjects();
  }

  async function continuePendingDeploymentSync() {
    if (!pendingDeploymentSync) return;
    const pending = pendingDeploymentSync;
    setPendingDeploymentSync(null);
    setApplying(true);
    try {
      await syncAndStartStaging(pending.repository, pending.branch, true);
      toast.success(
        `已部署最近一次提交，共更新 ${pending.writtenFiles} 个部署文件`,
      );
    } catch (error) {
      reportDeploymentIssue(issueFromUnknown(error, "测试部署未能开始"));
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

  const refreshWorkspaceDeployments = useCallback(async () => {
    const activeRuns = await listActiveDeploymentRuns();
    if (!activeRuns.length) return;
    const results = await Promise.allSettled(
      activeRuns.map((run) => refreshDeployment(run.id)),
    );
    const updatedRuns = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const visible = updatedRuns.filter(
      (run) => run.projectPath === projectPath,
    );
    if (visible.length) {
      setDeploymentRuns((current) => {
        const updates = new Map(visible.map((run) => [run.id, run]));
        return [
          ...visible,
          ...current.filter((run) => !updates.has(run.id)),
        ].sort(
          (left, right) =>
            new Date(right.startedAt).getTime() -
            new Date(left.startedAt).getTime(),
        );
      });
      setCurrentRun(
        (current) =>
          updatedRuns.find((run) => run.id === current?.id) ?? current,
      );
    }
    await refreshProjects();
  }, [projectPath, refreshProjects]);

  useEffect(() => {
    if (!shouldRefreshDeploymentStatus(screen, step)) return;
    const timer = window.setInterval(() => {
      void refreshWorkspaceDeployments().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshWorkspaceDeployments, screen, step]);

  async function retryDeployment() {
    if (!projectPath) return;
    setApplying(true);
    try {
      if (
        currentRun?.actionKind === "route-check" ||
        currentRun?.actionKind === "verify-release" ||
        currentRun?.actionKind === "artifact-mismatch"
      ) {
        await refreshCurrentDeployment();
        return;
      }
      const source =
        currentRun?.environment === "production" && currentRun.sourceRunId
          ? deploymentRuns.find((run) => run.id === currentRun.sourceRunId)
          : null;
      const run = source
        ? await promoteProductionDeployment(source.id)
        : await startStagingDeployment(projectPath);
      setCurrentRun(run);
      setDeploymentRuns((current) => [run, ...current]);
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      setApplying(false);
    }
  }

  async function completeCloudSetup(
    codeRepository: string,
    secretRepository: string,
    allowUncommitted = false,
  ) {
    if (!workspace || !projectPath || !currentRun) return;
    setApplying(true);
    try {
      const document = parseDocument(workspace.manifestYaml);
      document.setIn(["providers", "build", "repository"], codeRepository);
      const data = document.toJS() as {
        providers?: { registry?: { kind?: string } };
        source?: { release_branch?: string };
      };
      if (data.providers?.registry?.kind === "cnb") {
        document.setIn(["providers", "registry", "repository"], codeRepository);
      }
      document.setIn(
        ["environments", "staging", "secrets_ref"],
        `https://cnb.cool/${secretRepository}/-/blob/main/env.staging.yml`,
      );
      document.setIn(
        ["environments", "production", "secrets_ref"],
        `https://cnb.cool/${secretRepository}/-/blob/main/env.production.yml`,
      );
      const manifestYaml = document.toString({ lineWidth: 0 });
      const preview = await previewManifest(projectPath, manifestYaml);
      if (!preview.validation.valid) {
        throw new Error("持续部署配置校验未通过，请检查密钥仓库路径");
      }
      await applyManifest(projectPath, manifestYaml);
      const branch = data.source?.release_branch ?? "main";
      const source = await syncProjectToCnb(
        projectPath,
        codeRepository,
        branch,
        allowUncommitted,
      );
      const autoTrigger = await enableCnbAutoTrigger(codeRepository);
      if (!autoTrigger.ok) throw new Error(autoTrigger.summary);
      const refreshed = await openProject(projectPath);
      setWorkspace(refreshed);
      const run = await resumeStagingDeployment(
        currentRun.id,
        source.commitSha,
      );
      setCurrentRun(run);
      setDeploymentRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      setPendingCloudSetup(null);
      toast.success("持续部署连接已完成，测试环境开始构建");
    } catch (error) {
      const issue = issueFromUnknown(error, "持续部署连接没有完成");
      if (issue.code === "AD-GIT-101" && !allowUncommitted) {
        setPendingCloudSetup({ codeRepository, secretRepository, issue });
        return;
      }
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

  async function rollbackProjectEnvironment(
    environment: DeploymentRun["environment"],
  ) {
    if (!lastServer?.hostFingerprint) {
      reportError("目标服务器身份需要重新验证后才能回滚");
      return;
    }
    setApplying(true);
    try {
      const run = await rollbackEnvironment(
        projectPath,
        environment,
        lastServer,
      );
      setDeploymentRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      if (run.status === "success") {
        toast.success(run.message);
      } else {
        reportError(run.message);
      }
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

  async function nextStep() {
    const index = onboardingSteps.indexOf(step);
    if (index >= 0 && index < onboardingSteps.length - 1) {
      try {
        if (step === "connections" && workspace) {
          const document = parseDocument(workspace.manifestYaml);
          if (registryChoice.mode === "tcr") {
            document.setIn(["providers", "registry"], {
              kind: "tcr",
              registry: "ccr.ccs.tencentyun.com",
              namespace: registryChoice.namespace,
            });
          } else {
            const repository = document.getIn([
              "providers",
              "build",
              "repository",
            ]);
            document.setIn(["providers", "registry"], {
              kind: "cnb",
              repository:
                typeof repository === "string"
                  ? repository
                  : `owner/${workspace.inspection.project_name}`,
            });
          }
          const preview = await previewManifest(
            projectPath,
            document.toString({ lineWidth: 0 }),
          );
          setWorkspace(preview);
        }
        await goToStep(onboardingSteps[index + 1]);
      } catch (error) {
        reportError(toMessage(error));
      }
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
          disabled={
            (step === "connections" && !connectionsReady) ||
            (step === "requirements" && !requirementsReady)
          }
          onClick={nextStep}
          title={
            step === "requirements" && !requirementsReady
              ? "请先保存测试和生产两份运行配置"
              : undefined
          }
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
        {step === "inspection" ? (
          <InspectionStep workspace={workspace} />
        ) : null}
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
            onReadinessChange={setRequirementsReady}
            onUpdate={updateManifest}
            saving={saving}
            workspace={workspace}
          />
        ) : null}
        {step === "review" ? (
          <ReviewStep
            applying={applying}
            issue={deploymentIssue}
            onApply={applyCurrentPlan}
            onBackToConnections={() => goToStep("connections")}
            workspace={workspace}
          />
        ) : null}
        {step === "deploying" &&
        currentRun?.actionKind === "cloud-setup" &&
        lastServer ? (
          <CloudSetupAction
            completing={applying}
            onBackToRequirements={() => goToStep("requirements")}
            onComplete={completeCloudSetup}
            onError={reportError}
            path={projectPath}
            server={lastServer}
            workspace={workspace}
          />
        ) : null}
        {step === "deploying" &&
        currentRun &&
        currentRun.actionKind !== "cloud-setup" ? (
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

  function renderScreenContent() {
    if (screen === "home") {
      return (
        <ProjectHome
          embedded={projects.length > 0}
          loading={loading}
          onDemo={() => loadProject("/demo/ecat-energy")}
          onForget={forgetRecent}
          onOpen={(project) => loadProject(project.path, project.currentStep)}
          onSelect={selectProject}
          preflight={preflight}
          projects={projects}
          showDemo={!isTauri()}
        />
      );
    }
    if (screen === "onboarding") return renderOnboarding();
    if (screen === "workspace" && workspace) {
      return (
        <WorkspaceShell
          onDeploy={() => goToStep("review")}
          onForget={() => {
            const current = projects.find(
              (project) => project.path === projectPath,
            );
            if (current) void forgetRecent(current);
          }}
          onPromote={promoteToProduction}
          onRollback={rollbackProjectEnvironment}
          onRefresh={() => loadProject(projectPath, "workspace")}
          path={projectPath}
          runs={deploymentRuns}
          workspace={workspace}
        />
      );
    }
    return null;
  }

  const content = renderScreenContent();

  return (
    <>
      {projects.length ? (
        <AppShell
          activePath={screen === "home" ? "" : projectPath}
          loading={loading}
          onAddProject={selectProject}
          onOpenProject={(project) =>
            loadProject(project.path, project.currentStep)
          }
          onShowProjects={() => setScreen("home")}
          preflight={preflight}
          projects={projects}
        >
          {content}
        </AppShell>
      ) : (
        content
      )}

      {loading && screen !== "home" ? (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-[var(--background)]/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <LoaderCircle className="size-5 animate-spin-slow" />
            正在只读识别项目
          </div>
        </div>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingCloudSetup(null);
            setPendingDeploymentSync(null);
          }
        }}
        open={Boolean(pendingCloudSetup || pendingDeploymentSync)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingCloudSetup?.issue.title ??
                pendingDeploymentSync?.issue.title}
            </DialogTitle>
            <DialogDescription>
              {pendingCloudSetup?.issue.message ??
                pendingDeploymentSync?.issue.message}
            </DialogDescription>
          </DialogHeader>
          <p className="m-0 text-sm leading-6 text-[var(--muted-foreground)]">
            继续后，这些本地改动不会上传；CNB 将部署 Git
            中最近一次已提交的业务代码，ABCDeploy 生成的部署配置仍会单独保存。
          </p>
          <DialogFooter>
            <Button
              disabled={applying}
              onClick={() => {
                setPendingCloudSetup(null);
                setPendingDeploymentSync(null);
              }}
              variant="secondary"
            >
              暂不部署
            </Button>
            <Button
              disabled={
                applying || (!pendingCloudSetup && !pendingDeploymentSync)
              }
              onClick={() => {
                if (pendingCloudSetup) {
                  const setup = pendingCloudSetup;
                  setPendingCloudSetup(null);
                  void completeCloudSetup(
                    setup.codeRepository,
                    setup.secretRepository,
                    true,
                  );
                  return;
                }
                void continuePendingDeploymentSync();
              }}
            >
              {applying ? <LoaderCircle className="animate-spin-slow" /> : null}
              部署已提交版本
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
