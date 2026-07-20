import { describe, expect, it } from "vitest";
import type { DeploymentRun, DeploymentRunStatus } from "../types";
import { deploymentVersionKey } from "./projects";
import {
  buildReleaseCenterModel,
  buildReleaseModel,
  projectSectionFromStoredScene,
  releaseCandidateVersions,
  releaseEnvironmentSummary,
  releasePendingRecords,
} from "./release-model";

describe("release model", () => {
  it("migrates the old deployment scenes without accepting unknown values", () => {
    expect(projectSectionFromStoredScene("test")).toBe("overview");
    expect(projectSectionFromStoredScene("production")).toBe("overview");
    expect(projectSectionFromStoredScene("local")).toBe("local");
    expect(projectSectionFromStoredScene("versions")).toBe("versions");
    expect(projectSectionFromStoredScene("settings")).toBe("settings");
    expect(projectSectionFromStoredScene("plan")).toBeUndefined();
    expect(projectSectionFromStoredScene(null)).toBeUndefined();
  });

  it("summarizes healthy, deploying and user-action environment states", () => {
    const healthy = run({ id: "healthy", status: "success", minute: 1 });
    const running = run({ id: "running", status: "running", minute: 2 });
    const needsAction = run({
      environment: "production",
      id: "production-needs-action",
      status: "needs_action",
      minute: 3,
      sourceRunId: healthy.id,
      artifacts: healthy.artifacts,
    });

    const staging = releaseEnvironmentSummary([running, healthy], "staging");
    expect(staging.state).toBe("deploying");
    expect(staging.latestRun?.id).toBe(running.id);
    expect(staging.deployedRun?.id).toBe(healthy.id);
    expect(staging.versionKey).toBe(deploymentVersionKey(healthy));

    const production = releaseEnvironmentSummary(
      [needsAction, healthy],
      "production",
    );
    expect(production.state).toBe("needs_action");
    expect(production.deployedRun).toBeNull();
    expect(production.versionKey).toBeNull();
  });

  it("does not let an older failure replace a newer healthy deployment", () => {
    const oldFailure = run({
      id: "old-failure",
      status: "failed",
      minute: 1,
    });
    const current = run({ id: "current", status: "success", minute: 2 });

    const summary = releaseEnvironmentSummary([oldFailure, current], "staging");
    expect(summary.state).toBe("healthy");
    expect(summary.latestRun?.id).toBe(current.id);
    expect(releasePendingRecords([oldFailure, current])).toEqual([]);
  });

  it("keeps a newer failed attempt actionable while preserving the live version", () => {
    const live = run({ id: "live", status: "success", minute: 1 });
    const failed = run({ id: "failed", status: "failed", minute: 2 });

    const model = buildReleaseModel([live, failed], []);
    expect(model.staging.state).toBe("failed");
    expect(model.staging.latestRun?.id).toBe(failed.id);
    expect(model.staging.deployedRun?.id).toBe(live.id);
    expect(model.pendingRecords).toMatchObject([
      {
        environment: "staging",
        requiresUserAction: true,
        run: { id: failed.id },
      },
    ]);
  });

  it("does not call a route-conflicted production candidate the online version", () => {
    const onlineSource = run({
      id: "online-source",
      minute: 1,
      status: "success",
    });
    const onlineProduction = run({
      environment: "production",
      id: "online-production",
      minute: 2,
      sourceRunId: onlineSource.id,
      status: "success",
    });
    const candidate = run({
      id: "candidate",
      minute: 3,
      status: "success",
    });
    const routeConflict = run({
      actionKind: "route-takeover",
      artifacts: candidate.artifacts,
      environment: "production",
      id: "route-conflict",
      issueCode: "AD-SRV-206",
      minute: 4,
      sourceRunId: candidate.id,
      status: "needs_action",
    });

    const production = releaseEnvironmentSummary(
      [routeConflict, candidate, onlineProduction, onlineSource],
      "production",
    );
    expect(production.latestRun?.id).toBe(routeConflict.id);
    expect(production.deployedRun?.id).toBe(onlineProduction.id);
    expect(production.versionKey).toBe(deploymentVersionKey(onlineSource));
  });

  it("keeps a version visible when services run but the address still needs work", () => {
    const candidate = run({
      id: "candidate",
      minute: 1,
      status: "success",
    });
    const addressPending = run({
      actionKind: "route-check",
      environment: "production",
      id: "address-pending",
      minute: 2,
      sourceRunId: candidate.id,
      status: "needs_action",
    });

    const production = releaseEnvironmentSummary(
      [candidate, addressPending],
      "production",
    );
    expect(production.latestRun?.id).toBe(addressPending.id);
    expect(production.deployedRun?.id).toBe(addressPending.id);
    expect(production.versionKey).toBe(deploymentVersionKey(candidate));
  });

  it("returns only verified successful versions as production candidates", () => {
    const current = run({ id: "current", status: "success", minute: 4 });
    const older = run({ id: "older", status: "success", minute: 2 });
    const unverified = run({
      id: "unverified",
      status: "success",
      minute: 3,
    });
    const failedRepeat = run({
      ...identityOf(older),
      id: "failed-repeat",
      status: "failed",
      minute: 5,
    });
    const production = run({
      environment: "production",
      id: "production",
      status: "success",
      minute: 6,
      sourceRunId: older.id,
    });

    const candidates = releaseCandidateVersions(
      [failedRepeat, production, current, unverified, older],
      [deploymentVersionKey(current), deploymentVersionKey(older)],
    );

    expect(candidates.map((candidate) => candidate.run.id)).toEqual([
      current.id,
      older.id,
    ]);
    expect(candidates[0]).toMatchObject({
      inStaging: true,
      inProduction: false,
    });
    expect(candidates[1]).toMatchObject({
      inStaging: false,
      inProduction: true,
    });
  });

  it("ignores production approval records when choosing test state and work", () => {
    const tested = run({ id: "tested", status: "success", minute: 1 });
    const approval = run({
      ...identityOf(tested),
      actionKind: "production-approval",
      id: "approval",
      status: "needs_action",
      minute: 2,
    });

    const model = buildReleaseModel(
      [approval, tested],
      [deploymentVersionKey(tested)],
    );
    expect(model.staging.state).toBe("healthy");
    expect(model.staging.latestRun?.id).toBe(tested.id);
    expect(model.pendingRecords).toEqual([]);
    expect(model.candidates.map((candidate) => candidate.run.id)).toEqual([
      tested.id,
    ]);
  });

  it("does not let a cancelled request hide an older active deployment", () => {
    const running = run({ id: "running", status: "running", minute: 1 });
    const cancelled = run({
      id: "cancelled",
      status: "cancelled",
      minute: 2,
    });

    const model = buildReleaseModel([cancelled, running], []);
    expect(model.staging.state).toBe("deploying");
    expect(model.staging.latestRun?.id).toBe(running.id);
    expect(model.pendingRecords).toMatchObject([
      {
        environment: "staging",
        requiresUserAction: false,
        run: { id: running.id },
      },
    ]);
  });

  it("keeps unfinished staging and production records independent", () => {
    const staging = run({
      id: "staging-running",
      status: "running",
      minute: 4,
    });
    const production = run({
      environment: "production",
      id: "production-needs-action",
      status: "needs_action",
      minute: 3,
    });

    expect(releasePendingRecords([production, staging])).toMatchObject([
      {
        environment: "staging",
        requiresUserAction: false,
        run: { id: staging.id },
      },
      {
        environment: "production",
        requiresUserAction: true,
        run: { id: production.id },
      },
    ]);
  });
});

describe("release center decision", () => {
  it("guides incomplete setup and starts the first test deployment when ready", () => {
    const incomplete = centerModel([], [], {
      ready: false,
      nextStep: "registry",
    });
    expect(incomplete).toMatchObject({
      phase: "setup",
      currentVersion: null,
      primaryAction: { kind: "continue-setup", step: "registry" },
      pendingTask: null,
    });

    const ready = centerModel([], [], { ready: true });
    expect(ready).toMatchObject({
      phase: "setup",
      currentVersion: null,
      primaryAction: {
        kind: "start-test-deployment",
        environment: "staging",
      },
    });
  });

  it("shows build and deploy progress as one current task", () => {
    const building = run({ id: "building", minute: 1, status: "running" });

    const model = centerModel([building]);
    expect(model).toMatchObject({
      phase: "build-deploy-progress",
      currentVersion: { run: { id: building.id } },
      primaryAction: {
        kind: "view-test-progress",
        runId: building.id,
      },
      pendingTask: { run: { id: building.id } },
    });
  });

  it("recovers a newer failed test task without losing the online test version", () => {
    const online = run({ id: "online", minute: 1, status: "success" });
    const failed = run({ id: "failed-candidate", minute: 2, status: "failed" });

    const model = centerModel([online, failed]);
    expect(model.phase).toBe("recover-test-task");
    expect(model.staging.deployedRun?.id).toBe(online.id);
    expect(model.staging.versionKey).toBe(deploymentVersionKey(online));
    expect(model.currentVersion?.run.id).toBe(failed.id);
    expect(model.primaryAction).toEqual({
      kind: "recover-test-task",
      environment: "staging",
      runId: failed.id,
    });
  });

  it("preserves runReachedEnvironment while a deployed test address needs work", () => {
    const addressPending = run({
      actionKind: "route-check",
      id: "test-address-pending",
      minute: 1,
      status: "needs_action",
    });

    const model = centerModel([addressPending]);
    expect(model.phase).toBe("recover-test-task");
    expect(model.staging.latestRun?.id).toBe(addressPending.id);
    expect(model.staging.deployedRun?.id).toBe(addressPending.id);
    expect(model.staging.versionKey).toBe(deploymentVersionKey(addressPending));
  });

  it("moves one tested version through awaiting, rejected and eligible states", () => {
    const tested = run({ id: "tested", minute: 1, status: "success" });
    const key = deploymentVersionKey(tested);

    expect(centerModel([tested])).toMatchObject({
      phase: "awaiting-test",
      currentVersion: { key, verification: "awaiting" },
      primaryAction: { kind: "open-test-version", versionKey: key },
    });
    expect(
      centerModel([tested], [{ versionKey: key, state: "rejected" }]),
    ).toMatchObject({
      phase: "test-rejected",
      currentVersion: { key, verification: "rejected" },
      primaryAction: { kind: "wait-for-new-version", versionKey: key },
    });
    expect(
      centerModel([tested], [{ versionKey: key, state: "passed" }]),
    ).toMatchObject({
      phase: "eligible",
      currentVersion: { key, verification: "passed" },
      primaryAction: { kind: "publish-version", versionKey: key },
    });
  });

  it("keeps historical qualified versions selectable when the latest test is rejected", () => {
    const qualified = run({ id: "qualified", minute: 1, status: "success" });
    const rejected = run({ id: "rejected", minute: 2, status: "success" });
    const qualifiedKey = deploymentVersionKey(qualified);
    const rejectedKey = deploymentVersionKey(rejected);

    const model = centerModel(
      [qualified, rejected],
      [
        { versionKey: qualifiedKey, state: "passed" },
        { versionKey: rejectedKey, state: "rejected" },
      ],
    );
    expect(model.phase).toBe("test-rejected");
    expect(model.currentVersion?.key).toBe(rejectedKey);
    expect(model.eligibleVersions.map(({ key }) => key)).toEqual([
      qualifiedKey,
    ]);
  });

  it("tracks production progress against the exact qualified source version", () => {
    const candidate = run({ id: "candidate", minute: 1, status: "success" });
    const production = run({
      environment: "production",
      id: "production-running",
      minute: 2,
      sourceRunId: candidate.id,
      status: "running",
    });
    const key = deploymentVersionKey(candidate);

    const model = centerModel(
      [candidate, production],
      [{ versionKey: key, state: "passed" }],
    );
    expect(model).toMatchObject({
      phase: "production-progress",
      currentVersion: { key },
      primaryAction: {
        kind: "view-production-progress",
        runId: production.id,
      },
      pendingTask: { run: { id: production.id } },
    });
  });

  it("recovers a failed production attempt while preserving the public online version", () => {
    const onlineSource = run({
      id: "online-source",
      minute: 1,
      status: "success",
    });
    const onlineProduction = run({
      environment: "production",
      id: "online-production",
      minute: 2,
      sourceRunId: onlineSource.id,
      status: "success",
    });
    const failedSource = run({
      id: "failed-source",
      minute: 3,
      status: "success",
    });
    const failedProduction = run({
      environment: "production",
      id: "failed-production",
      minute: 4,
      sourceRunId: failedSource.id,
      status: "failed",
    });

    const model = centerModel(
      [onlineSource, onlineProduction, failedSource, failedProduction],
      [
        { versionKey: deploymentVersionKey(onlineSource), state: "passed" },
        { versionKey: deploymentVersionKey(failedSource), state: "passed" },
      ],
    );
    expect(model.phase).toBe("recover-production-task");
    expect(model.production.deployedRun?.id).toBe(onlineProduction.id);
    expect(model.production.versionKey).toBe(
      deploymentVersionKey(onlineSource),
    );
    expect(model.currentVersion?.key).toBe(deploymentVersionKey(failedSource));
    expect(model.primaryAction).toMatchObject({
      kind: "recover-production-task",
      runId: failedProduction.id,
    });
  });

  it("keeps the new production version online when only its route check is pending", () => {
    const candidate = run({ id: "candidate", minute: 1, status: "success" });
    const routeCheck = run({
      actionKind: "route-check",
      environment: "production",
      id: "production-route-check",
      minute: 2,
      sourceRunId: candidate.id,
      status: "needs_action",
    });
    const key = deploymentVersionKey(candidate);

    const model = centerModel(
      [candidate, routeCheck],
      [{ versionKey: key, state: "passed" }],
    );
    expect(model.phase).toBe("recover-production-task");
    expect(model.production.deployedRun?.id).toBe(routeCheck.id);
    expect(model.production.versionKey).toBe(key);
    expect(model.currentVersion?.key).toBe(key);
  });

  it("keeps a finished deployment actionable while browser verification is pending", () => {
    const candidate = run({ id: "candidate", minute: 1, status: "success" });
    const production = run({
      environment: "production",
      id: "production",
      minute: 2,
      sourceRunId: candidate.id,
      status: "success",
    });
    const key = deploymentVersionKey(candidate);

    const model = buildReleaseCenterModel({
      setup: { ready: true },
      runs: [candidate, production],
      versionVerifications: [{ versionKey: key, state: "passed" }],
      productionWebPending: true,
      productionWebVersionKey: key,
    });
    expect(model).toMatchObject({
      phase: "recover-production-task",
      currentVersion: { key },
      primaryAction: {
        kind: "recover-production-task",
        runId: null,
        versionKey: key,
      },
      pendingTask: null,
      productionWebPending: true,
    });
  });

  it("reports healthy when production serves the current tested version", () => {
    const candidate = run({ id: "candidate", minute: 1, status: "success" });
    const production = run({
      environment: "production",
      id: "production",
      minute: 2,
      sourceRunId: candidate.id,
      status: "success",
    });
    const key = deploymentVersionKey(candidate);

    // Production itself is enough to restore a missing legacy verification
    // record, so reopening the client does not ask the user to retest it.
    const model = centerModel([candidate, production]);
    expect(model).toMatchObject({
      phase: "healthy",
      currentVersion: { key, inProduction: true, verification: "passed" },
      primaryAction: { kind: "view-production", versionKey: key },
    });
  });

  it("offers a newer qualified test version instead of treating older production as current", () => {
    const onlineSource = run({
      id: "online-source",
      minute: 1,
      status: "success",
    });
    const onlineProduction = run({
      environment: "production",
      id: "online-production",
      minute: 2,
      sourceRunId: onlineSource.id,
      status: "success",
    });
    const currentTest = run({
      id: "current-test",
      minute: 3,
      status: "success",
    });
    const currentKey = deploymentVersionKey(currentTest);

    const model = centerModel(
      [onlineSource, onlineProduction, currentTest],
      [{ versionKey: currentKey, state: "passed" }],
    );
    expect(model.phase).toBe("eligible");
    expect(model.currentVersion?.key).toBe(currentKey);
    expect(model.production.versionKey).toBe(
      deploymentVersionKey(onlineSource),
    );
  });
});

function centerModel(
  runs: readonly DeploymentRun[],
  versionVerifications: Parameters<
    typeof buildReleaseCenterModel
  >[0]["versionVerifications"] = [],
  setup: Parameters<typeof buildReleaseCenterModel>[0]["setup"] = {
    ready: true,
  },
) {
  return buildReleaseCenterModel({
    setup,
    runs,
    versionVerifications,
    productionWebPending: false,
  });
}

function identityOf(source: DeploymentRun) {
  return {
    artifacts: source.artifacts,
    candidateTag: source.candidateTag,
    commitSha: source.commitSha,
  };
}

function run({
  actionKind = null,
  artifacts,
  candidateTag,
  commitSha,
  environment = "staging",
  id,
  issueCode,
  minute,
  sourceRunId = null,
  status,
}: {
  actionKind?: string | null;
  artifacts?: DeploymentRun["artifacts"];
  candidateTag?: string | null;
  commitSha?: string | null;
  environment?: DeploymentRun["environment"];
  id: string;
  issueCode?: string | null;
  minute: number;
  sourceRunId?: string | null;
  status: DeploymentRunStatus;
}): DeploymentRun {
  const identity = id
    .replace(/[^a-z0-9]/gi, "")
    .padEnd(40, "0")
    .slice(0, 40);
  const timestamp = `2026-07-16T00:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
    projectPath: "/projects/demo",
    projectName: "demo",
    environment,
    status,
    currentStage: status === "success" ? "complete" : "deploy",
    buildSerial: id,
    commitSha: commitSha === undefined ? identity : commitSha,
    sourceRunId,
    candidateTag:
      candidateTag === undefined ? `deploydesk-${identity}` : candidateTag,
    artifacts:
      artifacts ??
      (environment === "staging"
        ? [
            {
              service: "api",
              image: "registry/demo/api",
              digest: `sha256:${identity.padEnd(64, "0")}`,
            },
          ]
        : []),
    actionKind,
    actionUrl: null,
    issueCode:
      issueCode === undefined
        ? status === "failed"
          ? "AD-TEST-001"
          : null
        : issueCode,
    repository: "demo/project",
    branch: "main",
    message: status,
    completedSteps: status === "success" ? ["healthcheck"] : [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}
