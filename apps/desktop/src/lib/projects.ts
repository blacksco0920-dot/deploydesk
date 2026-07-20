import type { DeploymentRun, RecentProject } from "../types";

export type ProjectSetupProgressStage =
  | "repository"
  | "registry"
  | "test-environment"
  | "remote"
  | "creation-page-opened"
  | "repository-ready"
  | "save-page-opened"
  | "first-deploy";

export interface ProjectSetupTask {
  environment: "staging" | "production";
  projectPath: string;
  stage: ProjectSetupProgressStage;
}

export interface ProjectVerificationTask {
  projectPath: string;
  runId: string;
}

function stringListFromSetting(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
    if (typeof parsed === "string") return [parsed];
  } catch {
    // Older builds stored one run id directly instead of a JSON array.
  }
  return [value];
}

export function verifiedRunIdsFromSetting(value: string | null) {
  return stringListFromSetting(value);
}

export function verifiedVersionKeysFromSetting(value: string | null) {
  return stringListFromSetting(value);
}

export function projectVerificationTask(
  project: RecentProject,
  verifiedRunSetting: string | null,
): ProjectVerificationTask | null {
  if (
    project.latestStatus !== "success" ||
    project.latestEnvironment !== "staging" ||
    !project.latestRunId ||
    verifiedRunIdsFromSetting(verifiedRunSetting).includes(project.latestRunId)
  ) {
    return null;
  }
  return { projectPath: project.path, runId: project.latestRunId };
}

export function deploymentVersionKey(
  run: Pick<DeploymentRun, "artifacts" | "candidateTag" | "commitSha" | "id">,
) {
  const artifacts = run.artifacts
    .filter((artifact) => artifact.digest.trim())
    .map(
      (artifact) =>
        `${artifact.service.trim()}\u0000${artifact.image.trim()}\u0000${artifact.digest.trim().toLowerCase()}`,
    )
    .sort();
  if (artifacts.length) return `images:${artifacts.join("\u0001")}`;
  if (run.commitSha) return `commit:${run.commitSha}`;
  if (run.candidateTag) return `candidate:${run.candidateTag}`;
  return `run:${run.id}`;
}

export function deploymentVersionVerified(
  runId: string,
  runs: Array<
    Pick<DeploymentRun, "artifacts" | "candidateTag" | "commitSha" | "id">
  >,
  verifiedRunIds: string[],
  verifiedVersionKeys: string[] = [],
) {
  const target = runs.find((run) => run.id === runId);
  if (!target) return verifiedRunIds.includes(runId);
  const targetVersion = deploymentVersionKey(target);
  if (verifiedVersionKeys.includes(targetVersion)) return true;
  return runs.some(
    (run) =>
      verifiedRunIds.includes(run.id) &&
      deploymentVersionKey(run) === targetVersion,
  );
}

export function projectSetupProgressStage(
  value: string | null,
): ProjectSetupProgressStage | null {
  return value === "repository" ||
    value === "registry" ||
    value === "test-environment" ||
    value === "remote" ||
    value === "creation-page-opened" ||
    value === "repository-ready" ||
    value === "save-page-opened" ||
    value === "first-deploy"
    ? value
    : null;
}

export function projectSetupStatus(task?: ProjectSetupTask) {
  if (task?.stage === "first-deploy") return "下一步：部署测试版";
  if (task?.stage === "repository") return "还差连接代码平台";
  if (task?.stage === "registry") return "还差保存项目版本";
  if (task?.stage === "test-environment") return "还差准备测试环境";
  if (task?.stage === "remote") return "还差开启自动部署";
  if (task?.stage === "creation-page-opened") return "还差网页创建";
  if (task?.stage === "repository-ready") return "还差保存配置";
  if (task?.stage === "save-page-opened") return "还差网页保存";
  return "";
}

export function isFirstDeployTask(task?: ProjectSetupTask) {
  return task?.stage === "first-deploy";
}

const GENERATED_VERSION_TITLES: Record<string, string> = {
  "initialize project for abcdeploy": "初始化 ABCDeploy 项目",
  "configure abcdeploy deployment": "完成首次上线配置",
  "update abcdeploy deployment": "更新上线配置",
  "update abcdeploy deployment config": "更新上线配置",
};

const GENERATED_FRIENDLY_VERSION_TITLES = new Set(
  Object.values(GENERATED_VERSION_TITLES),
);

export function friendlyVersionTitle(title?: string | null) {
  const normalized = title?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return "";
  const internal = [
    "api custom event",
    "custom event",
    "api trigger",
    "cnb custom event",
    "manual trigger",
  ];
  if (internal.includes(normalized.toLowerCase())) return "";
  if (GENERATED_VERSION_TITLES[normalized.toLowerCase()]) {
    return GENERATED_VERSION_TITLES[normalized.toLowerCase()];
  }
  return normalized;
}

export function primaryVersionTitle(title?: string | null) {
  const friendly = friendlyVersionTitle(title);
  if (!friendly) return "";
  if (
    GENERATED_VERSION_TITLES[title?.trim().toLowerCase() ?? ""] ||
    GENERATED_FRIENDLY_VERSION_TITLES.has(friendly)
  ) {
    return "";
  }
  return /[\u3400-\u9fff]/u.test(friendly) ||
    /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/i.test(friendly)
    ? friendly
    : "";
}

export function deploymentNeedsActionStatus(
  environment: DeploymentRun["environment"],
  actionKind?: string | null,
) {
  if (environment === "deployment") {
    if (
      actionKind === "route-check" ||
      actionKind === "route-repair" ||
      actionKind === "deployment-path-route-check" ||
      actionKind === "deployment-path-route-repair"
    ) {
      return "应用已部署，访问地址待处理";
    }
    if (
      actionKind === "route-takeover" ||
      actionKind === "deployment-path-route-takeover"
    ) {
      return "访问地址等待确认";
    }
    if (actionKind === "cnb-builds") return "还差代码平台授权";
    if (actionKind === "verify-release") return "部署结果还需要核对";
    return "上线需要处理";
  }
  if (actionKind === "route-check") {
    return environment === "production"
      ? "正式版已部署，还差地址"
      : "测试版已部署，还差地址";
  }
  if (actionKind === "route-repair") {
    return environment === "production"
      ? "正式版已部署，地址需修复"
      : "测试版已部署，地址需修复";
  }
  if (actionKind === "route-takeover") return "正式地址等待确认";
  if (actionKind === "local-preview") return "测试版已部署，等待验证";
  if (actionKind === "cloud-config" || actionKind === "cloud-setup") {
    return environment === "production"
      ? "正式配置还需要准备"
      : "测试配置还需要准备";
  }
  if (actionKind === "cnb-builds") return "还差代码平台授权";
  if (actionKind === "verify-release") return "部署结果还需要核对";
  if (actionKind === "artifact-mismatch") return "正式版本核对没有通过";
  if (actionKind === "redeploy-test") return "项目更新，需要重新测试";
  return environment === "production" ? "正式发布需要处理" : "测试部署需要处理";
}

export function recentProjectStatus(
  project: RecentProject,
  task?: Pick<DeploymentRun, "actionKind" | "environment" | "status">,
  setupTask?: ProjectSetupTask,
  verificationTask?: ProjectVerificationTask,
  releaseReady = false,
) {
  if (!project.pathExists) return "需要重新找到项目";
  if (task?.status === "queued" || task?.status === "running") {
    return task.environment === "deployment"
      ? "正在上线"
      : task.environment === "production"
        ? "正在发布正式版"
        : "正在部署测试版";
  }
  if (task?.status === "needs_action") {
    return deploymentNeedsActionStatus(task.environment, task.actionKind);
  }
  if (task?.status === "failed") {
    return task.environment === "deployment"
      ? "上次上线没有完成"
      : task.environment === "production"
        ? "正式发布没有完成"
        : "测试部署没有完成";
  }
  if (project.activeRunCount) return "正在部署";
  if (verificationTask) return "等待确认测试结果";
  if (setupTask) return projectSetupStatus(setupTask);
  if (
    releaseReady &&
    project.latestStatus === "success" &&
    project.latestEnvironment === "staging"
  ) {
    return "测试已通过，可发布";
  }
  if (project.latestStatus === "needs_action") {
    return project.latestEnvironment
      ? deploymentNeedsActionStatus(
          project.latestEnvironment,
          project.latestActionKind,
        )
      : "上线设置需要处理";
  }
  if (project.latestStatus === "failed") {
    return project.latestEnvironment === "deployment"
      ? "上次上线没有完成"
      : project.latestEnvironment === "production"
        ? "正式发布没有完成"
        : project.latestEnvironment === "staging"
          ? "测试部署没有完成"
          : "上次上线没有完成";
  }
  if (project.latestStatus === "success") {
    return project.latestEnvironment === "deployment"
      ? "已经上线"
      : project.latestEnvironment === "production"
        ? "正式版可以访问"
        : "测试版正在运行";
  }
  return project.currentStep === "workspace"
    ? "尚未开始上线"
    : "项目准备未完成";
}

export function preferredProjectTask(
  taskRuns: DeploymentRun[],
  projectPath: string,
) {
  const priority: Record<DeploymentRun["status"], number> = {
    needs_action: 4,
    failed: 3,
    running: 2,
    queued: 1,
    success: 0,
    cancelled: 0,
  };

  return taskRuns
    .filter((run) => run.projectPath === projectPath)
    .sort(
      (left, right) =>
        priority[right.status] - priority[left.status] ||
        right.updatedAt.localeCompare(left.updatedAt),
    )[0];
}
