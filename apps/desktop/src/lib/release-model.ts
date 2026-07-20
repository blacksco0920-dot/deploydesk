import type { DeploymentRun } from "../types";
import { deploymentVersionKey } from "./projects";

export type ProjectSection = "overview" | "local" | "versions" | "settings";

export type ReleaseEnvironment = DeploymentRun["environment"];

export type ReleaseEnvironmentState =
  "empty" | "deploying" | "needs_action" | "failed" | "healthy";

export interface ReleaseEnvironmentSummary {
  environment: ReleaseEnvironment;
  state: ReleaseEnvironmentState;
  /** The newest relevant attempt, including an attempt that did not finish. */
  latestRun: DeploymentRun | null;
  /** The newest version known to have reached this environment. */
  deployedRun: DeploymentRun | null;
  /** Immutable version identity running in the environment, when known. */
  versionKey: string | null;
}

export interface ReleaseCandidateVersion {
  key: string;
  run: DeploymentRun;
  inProduction: boolean;
  inStaging: boolean;
}

export interface ReleasePendingRecord {
  environment: ReleaseEnvironment;
  requiresUserAction: boolean;
  run: DeploymentRun;
}

export interface ReleaseModel {
  staging: ReleaseEnvironmentSummary;
  production: ReleaseEnvironmentSummary;
  candidates: ReleaseCandidateVersion[];
  pendingRecords: ReleasePendingRecord[];
}

export type ReleaseVersionVerificationState =
  "awaiting" | "passed" | "rejected";

export interface ReleaseVersionVerification {
  versionKey: string;
  state: ReleaseVersionVerificationState;
}

export interface ReleaseSetupReadiness {
  ready: boolean;
  /** Stable setup step id supplied by the setup model, when known. */
  nextStep?: string | null;
}

export type ReleaseCenterPhase =
  | "setup"
  | "build-deploy-progress"
  | "recover-test-task"
  | "awaiting-test"
  | "test-rejected"
  | "eligible"
  | "production-progress"
  | "recover-production-task"
  | "healthy";

export interface ReleaseCenterVersion extends ReleaseCandidateVersion {
  verification: ReleaseVersionVerificationState;
}

export type ReleaseCenterPrimaryAction =
  | { kind: "continue-setup"; step: string | null }
  | { kind: "start-test-deployment"; environment: "staging" }
  | {
      kind: "view-test-progress";
      environment: "staging";
      runId: string;
    }
  | {
      kind: "recover-test-task";
      environment: "staging";
      runId: string;
    }
  | {
      kind: "open-test-version";
      environment: "staging";
      versionKey: string;
    }
  | { kind: "wait-for-new-version"; versionKey: string }
  | {
      kind: "publish-version";
      environment: "production";
      versionKey: string;
    }
  | {
      kind: "view-production-progress";
      environment: "production";
      runId: string;
    }
  | {
      kind: "recover-production-task";
      environment: "production";
      runId: string | null;
      versionKey: string | null;
    }
  | {
      kind: "view-production";
      environment: "production";
      versionKey: string | null;
    };

export interface BuildReleaseCenterModelInput {
  setup: ReleaseSetupReadiness;
  runs: readonly DeploymentRun[];
  versionVerifications: readonly ReleaseVersionVerification[];
  /** An address / browser verification handoff that still needs attention. */
  productionWebPending: boolean;
  /** The pending production version, if the web handoff stores it. */
  productionWebVersionKey?: string | null;
}

/**
 * The single decision that should drive the release centre's hero state.
 * `staging` and `production` deliberately keep the online version separate
 * from `pendingTask`: a failed newer attempt must not erase what is serving.
 */
export interface ReleaseCenterModel {
  phase: ReleaseCenterPhase;
  currentVersion: ReleaseCenterVersion | null;
  primaryAction: ReleaseCenterPrimaryAction;
  setup: ReleaseSetupReadiness;
  staging: ReleaseEnvironmentSummary;
  production: ReleaseEnvironmentSummary;
  versions: ReleaseCenterVersion[];
  /** All historically qualified versions, including the one now in production. */
  eligibleVersions: ReleaseCenterVersion[];
  pendingTask: ReleasePendingRecord | null;
  productionWebPending: boolean;
}

/**
 * Converts both the previous four-scene navigation and the new project
 * navigation into one durable section. Unknown values stay undefined so the
 * caller can deliberately choose its own default (normally `overview`).
 */
export function projectSectionFromStoredScene(
  value: string | null | undefined,
): ProjectSection | undefined {
  if (value === "local" || value === "versions" || value === "settings") {
    return value;
  }
  if (value === "overview" || value === "test" || value === "production") {
    return "overview";
  }
  return undefined;
}

export function releaseEnvironmentSummary(
  runs: readonly DeploymentRun[],
  environment: ReleaseEnvironment,
): ReleaseEnvironmentSummary {
  const relevant = sortedRuns(runs).filter(
    (run) => run.environment === environment && isReleaseRun(run),
  );
  // A cancelled request never changes what is running and should not replace a
  // healthy environment with an alarming but actionless state.
  const latestRun = relevant.find((run) => run.status !== "cancelled") ?? null;
  const deployedRun = relevant.find(runReachedEnvironment) ?? null;

  return {
    environment,
    state: environmentState(latestRun),
    latestRun,
    deployedRun,
    versionKey: deployedRun ? environmentVersionKey(deployedRun, runs) : null,
  };
}

export function releaseCandidateVersions(
  runs: readonly DeploymentRun[],
  verifiedVersionKeys: ReadonlySet<string> | readonly string[],
): ReleaseCandidateVersion[] {
  const verified =
    verifiedVersionKeys instanceof Set
      ? verifiedVersionKeys
      : new Set(verifiedVersionKeys);
  const staging = releaseEnvironmentSummary(runs, "staging");
  const production = releaseEnvironmentSummary(runs, "production");
  const versions = new Map<string, DeploymentRun>();

  for (const run of sortedRuns(runs)) {
    if (
      run.environment !== "staging" ||
      run.status !== "success" ||
      !isReleaseRun(run)
    ) {
      continue;
    }
    const key = deploymentVersionKey(run);
    if (!verified.has(key) || versions.has(key)) continue;
    versions.set(key, run);
  }

  return Array.from(versions, ([key, run]) => ({
    key,
    run,
    inStaging: staging.versionKey === key,
    inProduction: production.versionKey === key,
  }));
}

/**
 * Returns at most one current unfinished record per environment. Older
 * failures are deployment history once a newer attempt exists, so they must
 * not make the project look unhealthy or steal the primary recovery action.
 */
export function releasePendingRecords(
  runs: readonly DeploymentRun[],
): ReleasePendingRecord[] {
  return (["staging", "production"] as const)
    .flatMap((environment) => {
      const latest = sortedRuns(runs).find(
        (run) =>
          run.environment === environment &&
          run.status !== "cancelled" &&
          isReleaseRun(run),
      );
      if (
        !latest ||
        !["queued", "running", "needs_action", "failed"].includes(latest.status)
      ) {
        return [];
      }
      return [
        {
          environment,
          requiresUserAction:
            latest.status === "needs_action" || latest.status === "failed",
          run: latest,
        },
      ];
    })
    .sort((left, right) => compareRuns(right.run, left.run));
}

export function buildReleaseModel(
  runs: readonly DeploymentRun[],
  verifiedVersionKeys: ReadonlySet<string> | readonly string[],
): ReleaseModel {
  return {
    staging: releaseEnvironmentSummary(runs, "staging"),
    production: releaseEnvironmentSummary(runs, "production"),
    candidates: releaseCandidateVersions(runs, verifiedVersionKeys),
    pendingRecords: releasePendingRecords(runs),
  };
}

export function buildReleaseCenterModel({
  setup,
  runs,
  versionVerifications,
  productionWebPending,
  productionWebVersionKey = null,
}: BuildReleaseCenterModelInput): ReleaseCenterModel {
  const verificationByVersion = new Map(
    versionVerifications.map(({ versionKey, state }) => [versionKey, state]),
  );
  const passedVersionKeys = new Set(
    versionVerifications
      .filter(({ state }) => state === "passed")
      .map(({ versionKey }) => versionKey),
  );
  const release = buildReleaseModel(runs, passedVersionKeys);
  const versions = releaseCenterVersions(
    runs,
    verificationByVersion,
    release.staging,
    release.production,
  );
  const eligibleVersions = versions.filter(
    ({ verification }) => verification === "passed",
  );
  const stagingTask = release.pendingRecords.find(
    ({ environment }) => environment === "staging",
  );
  const productionTask = release.pendingRecords.find(
    ({ environment }) => environment === "production",
  );
  const modelBase = {
    setup,
    staging: release.staging,
    production: release.production,
    versions,
    eligibleVersions,
    productionWebPending,
  };
  const versionForRun = (run: DeploymentRun | null | undefined) =>
    releaseCenterVersionForRun(
      run,
      runs,
      verificationByVersion,
      release.staging,
      release.production,
      versions,
    );

  // Production recovery has priority because it can affect a public service.
  // A web handoff can remain pending after the deployment task itself ended.
  if (productionWebPending) {
    const explicitVersion = productionWebVersionKey
      ? (versions.find(({ key }) => key === productionWebVersionKey) ?? null)
      : null;
    const currentVersion =
      explicitVersion ??
      versionForRun(productionTask?.run ?? release.production.latestRun) ??
      eligibleVersions.find(({ inProduction }) => !inProduction) ??
      versionForRun(release.production.deployedRun);
    return {
      ...modelBase,
      phase: "recover-production-task",
      currentVersion,
      primaryAction: {
        kind: "recover-production-task",
        environment: "production",
        runId: productionTask?.run.id ?? null,
        versionKey: currentVersion?.key ?? productionWebVersionKey,
      },
      pendingTask: productionTask ?? null,
    };
  }

  if (productionTask) {
    const currentVersion = versionForRun(productionTask.run);
    if (productionTask.requiresUserAction) {
      return {
        ...modelBase,
        phase: "recover-production-task",
        currentVersion,
        primaryAction: {
          kind: "recover-production-task",
          environment: "production",
          runId: productionTask.run.id,
          versionKey: currentVersion?.key ?? null,
        },
        pendingTask: productionTask,
      };
    }
    return {
      ...modelBase,
      phase: "production-progress",
      currentVersion,
      primaryAction: {
        kind: "view-production-progress",
        environment: "production",
        runId: productionTask.run.id,
      },
      pendingTask: productionTask,
    };
  }

  if (stagingTask) {
    const currentVersion = versionForRun(stagingTask.run);
    if (stagingTask.requiresUserAction) {
      return {
        ...modelBase,
        phase: "recover-test-task",
        currentVersion,
        primaryAction: {
          kind: "recover-test-task",
          environment: "staging",
          runId: stagingTask.run.id,
        },
        pendingTask: stagingTask,
      };
    }
    return {
      ...modelBase,
      phase: "build-deploy-progress",
      currentVersion,
      primaryAction: {
        kind: "view-test-progress",
        environment: "staging",
        runId: stagingTask.run.id,
      },
      pendingTask: stagingTask,
    };
  }

  if (!setup.ready) {
    return {
      ...modelBase,
      phase: "setup",
      currentVersion: null,
      primaryAction: {
        kind: "continue-setup",
        step: setup.nextStep ?? null,
      },
      pendingTask: null,
    };
  }

  const stagingVersion = versionForRun(release.staging.deployedRun);
  if (stagingVersion?.verification === "awaiting") {
    return {
      ...modelBase,
      phase: "awaiting-test",
      currentVersion: stagingVersion,
      primaryAction: {
        kind: "open-test-version",
        environment: "staging",
        versionKey: stagingVersion.key,
      },
      pendingTask: null,
    };
  }
  if (stagingVersion?.verification === "rejected") {
    return {
      ...modelBase,
      phase: "test-rejected",
      currentVersion: stagingVersion,
      primaryAction: {
        kind: "wait-for-new-version",
        versionKey: stagingVersion.key,
      },
      pendingTask: null,
    };
  }
  if (
    stagingVersion?.verification === "passed" &&
    !stagingVersion.inProduction
  ) {
    return {
      ...modelBase,
      phase: "eligible",
      currentVersion: stagingVersion,
      primaryAction: {
        kind: "publish-version",
        environment: "production",
        versionKey: stagingVersion.key,
      },
      pendingTask: null,
    };
  }

  // A qualified historical version can still be released even if it is no
  // longer the version currently running in the test environment.
  const historicalCandidate = !stagingVersion
    ? eligibleVersions.find(({ inProduction }) => !inProduction)
    : null;
  if (historicalCandidate) {
    return {
      ...modelBase,
      phase: "eligible",
      currentVersion: historicalCandidate,
      primaryAction: {
        kind: "publish-version",
        environment: "production",
        versionKey: historicalCandidate.key,
      },
      pendingTask: null,
    };
  }

  const productionVersion = versionForRun(release.production.deployedRun);
  if (productionVersion) {
    return {
      ...modelBase,
      phase: "healthy",
      currentVersion: productionVersion,
      primaryAction: {
        kind: "view-production",
        environment: "production",
        versionKey: productionVersion.key,
      },
      pendingTask: null,
    };
  }

  return {
    ...modelBase,
    phase: "setup",
    currentVersion: null,
    primaryAction: {
      kind: "start-test-deployment",
      environment: "staging",
    },
    pendingTask: null,
  };
}

function environmentState(run: DeploymentRun | null): ReleaseEnvironmentState {
  if (!run) return "empty";
  if (run.status === "queued" || run.status === "running") return "deploying";
  if (run.status === "needs_action") return "needs_action";
  if (run.status === "failed") return "failed";
  return run.status === "success" ? "healthy" : "empty";
}

function releaseCenterVersions(
  runs: readonly DeploymentRun[],
  verificationByVersion: ReadonlyMap<string, ReleaseVersionVerificationState>,
  staging: ReleaseEnvironmentSummary,
  production: ReleaseEnvironmentSummary,
) {
  const versions = new Map<string, ReleaseCenterVersion>();
  for (const run of sortedRuns(runs)) {
    if (
      run.environment !== "staging" ||
      run.status !== "success" ||
      !isReleaseRun(run)
    ) {
      continue;
    }
    const key = deploymentVersionKey(run);
    if (versions.has(key)) continue;
    versions.set(key, {
      key,
      run,
      // Reaching production proves that the version passed the release gate,
      // even if an older client did not persist the verification record.
      verification:
        verificationByVersion.get(key) ??
        (production.versionKey === key ? "passed" : "awaiting"),
      inStaging: staging.versionKey === key,
      inProduction: production.versionKey === key,
    });
  }
  return Array.from(versions.values());
}

function releaseCenterVersionForRun(
  run: DeploymentRun | null | undefined,
  allRuns: readonly DeploymentRun[],
  verificationByVersion: ReadonlyMap<string, ReleaseVersionVerificationState>,
  staging: ReleaseEnvironmentSummary,
  production: ReleaseEnvironmentSummary,
  versions: readonly ReleaseCenterVersion[],
): ReleaseCenterVersion | null {
  if (!run) return null;
  const source =
    run.environment === "production" ? sourceStagingRun(run, allRuns) : run;
  if (!source) {
    const sourceKey = run.sourceRunId
      ? versions.find(
          ({ key }) =>
            key === run.sourceRunId || key === `run:${run.sourceRunId}`,
        )
      : null;
    return sourceKey ?? null;
  }
  const key = deploymentVersionKey(source);
  const known = versions.find((version) => version.key === key);
  if (known) return known;
  return {
    key,
    run: source,
    verification: verificationByVersion.get(key) ?? "awaiting",
    inStaging: staging.versionKey === key,
    inProduction: production.versionKey === key,
  };
}

function sourceStagingRun(
  run: DeploymentRun,
  allRuns: readonly DeploymentRun[],
) {
  if (!run.sourceRunId) return null;
  return (
    allRuns.find(
      (candidate) =>
        candidate.environment === "staging" && candidate.id === run.sourceRunId,
    ) ??
    allRuns.find(
      (candidate) =>
        candidate.environment === "staging" &&
        deploymentVersionKey(candidate) === run.sourceRunId,
    ) ??
    null
  );
}

/**
 * A deployment task can pause after the services are already running. In
 * those cases the environment has reached the candidate version even though
 * the overall task still needs the user to finish an address or verification
 * step. Earlier blockers (authorization, configuration, route takeover) must
 * never replace the version that is actually online.
 */
function runReachedEnvironment(run: DeploymentRun) {
  if (run.status === "success") return true;
  if (run.status !== "needs_action") return false;
  return ["local-preview", "route-check", "route-repair"].includes(
    run.actionKind ?? "",
  );
}

function environmentVersionKey(
  run: DeploymentRun,
  allRuns: readonly DeploymentRun[],
) {
  if (run.environment === "staging") return deploymentVersionKey(run);
  if (!run.sourceRunId) return null;
  const source = allRuns.find(
    (candidate) =>
      candidate.id === run.sourceRunId && candidate.environment === "staging",
  );
  return source ? deploymentVersionKey(source) : `run:${run.sourceRunId}`;
}

function isReleaseRun(run: DeploymentRun) {
  return !(
    run.environment === "staging" && run.actionKind === "production-approval"
  );
}

function sortedRuns(runs: readonly DeploymentRun[]) {
  return [...runs].sort((left, right) => compareRuns(right, left));
}

function compareRuns(left: DeploymentRun, right: DeploymentRun) {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}
