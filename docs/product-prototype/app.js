const CURRENT_TEST_VERSION = "7 月 18 日 19:13 版本";
const HISTORY_VERSION = "7 月 17 日 10:42 版本";
const EXISTING_PRODUCTION_VERSION = "7 月 15 日 18:20 版本";
const CURRENT_SOURCE_COMMIT = "3951fbbb3951fbbb3951fbbb3951fbbb3951fbbb";
const CURRENT_TEST_VERSION_ID = "ver-shop-20260718-1913";
const HISTORY_VERSION_ID = "ver-shop-20260717-1042";
const EXISTING_PRODUCTION_VERSION_ID = "ver-shop-20260715-1820";
const PROJECT_ID = "project-shop-demo";
const PROJECT_PAGES = new Set(["release", "local", "versions", "settings"]);
const STORAGE_KEY = "abcdeploy-product-prototype-v6";
const VERSION_FIXTURES = {
  [CURRENT_TEST_VERSION_ID]: {
    displayName: CURRENT_TEST_VERSION,
    sourceCommit: CURRENT_SOURCE_COMMIT,
    digestHex: "7f3a91c2".repeat(8),
  },
  [HISTORY_VERSION_ID]: {
    displayName: HISTORY_VERSION,
    sourceCommit: "6a2c9e4d6a2c9e4d6a2c9e4d6a2c9e4d6a2c9e4d",
    digestHex: "5bc177e8".repeat(8),
  },
  [EXISTING_PRODUCTION_VERSION_ID]: {
    displayName: EXISTING_PRODUCTION_VERSION,
    sourceCommit: "1b7d3f8a1b7d3f8a1b7d3f8a1b7d3f8a1b7d3f8a",
    digestHex: "28ad4b10".repeat(8),
  },
};
const REQUIRED_CONFIG_KEYS = {
  staging: ["PROVIDER_API_KEY", "ADMIN_PASSWORD"],
  production: ["PROVIDER_API_KEY", "ADMIN_PASSWORD"],
};
const EXISTING_DISCOVERY_ID = "discovery-shop-existing-20260718";
const PROJECT_WORKSPACE_EXCLUDED_KEYS = new Set([
  "projects",
  "currentProjectId",
  "projectWorkspacesById",
  "page",
  "sheet",
  "returnFocusAction",
  "sourceVerificationReturnSheet",
  "sourceVerificationResumeAction",
  "credentialHelpTarget",
  "credentialHelpReturnSheet",
  "formErrors",
  "configProfiles",
  "serverConnections",
  "serverEvidenceByRevision",
  "codeConnectionStatus",
  "codeConnection",
  "registryConnectionStatus",
  "registryConnection",
  "activeRegistryConnectionId",
  "registryConnectionsById",
  "registryEvidenceByRevision",
]);

function projectRecord(sourceState = state) {
  const projectId = sourceState.currentProjectId ?? PROJECT_ID;
  return sourceState.projects?.find((project) => project.id === projectId)
    ?? { id: projectId, name: "项目", services: 1, serviceIds: ["app"], repositoryScope: null };
}

function projectSlug(sourceState = state) {
  const id = projectRecord(sourceState).id;
  if (id === PROJECT_ID) return "shop";
  return id.replace(/^project-/, "").replace(/-demo$/, "") || "app";
}

function defaultStagingAddress(sourceState = state) {
  return `https://${projectSlug(sourceState)}-test.example.net`;
}

function stagingAddress(sourceState = state) {
  return sourceState.environmentBindings?.staging?.address ?? defaultStagingAddress(sourceState);
}

function projectServiceDefinitions(sourceState = state) {
  const definitions = {
    api: ["后端服务", "http://localhost:3000"],
    web: ["网页服务", "http://localhost:5173"],
    ocr: ["OCR 服务", "http://localhost:8901"],
  };
  return (projectRecord(sourceState).serviceIds ?? Object.keys(sourceState.localServices ?? {}))
    .map((id) => [id, definitions[id]?.[0] ?? id, definitions[id]?.[1] ?? "本机服务"]);
}

function currentTestVersionId(sourceState = state) {
  return projectRecord(sourceState).id === PROJECT_ID
    ? CURRENT_TEST_VERSION_ID
    : `ver-${projectSlug(sourceState)}-20260718-1913`;
}

function versionFixture(versionId, sourceState = state) {
  if (VERSION_FIXTURES[versionId]) return VERSION_FIXTURES[versionId];
  if (versionId === currentTestVersionId(sourceState)) return VERSION_FIXTURES[CURRENT_TEST_VERSION_ID];
  return null;
}

function expectedSourceIdentity(sourceState = state) {
  const connection = sourceState.codeConnection;
  const project = projectRecord(sourceState);
  if (!connection || !project.repositoryScope) return null;
  return {
    id: `source-${project.id}`,
    projectId: project.id,
    codeConnectionId: connection.id,
    repositoryScope: project.repositoryScope,
  };
}

function codeAccountConnectionReady(sourceState = state) {
  return Boolean(
    sourceState.codeConnectionStatus === "ready"
      && sourceState.codeConnection?.status === "ready",
  );
}

function normalizedCodeConnection(connection) {
  if (!connection) return null;
  const { repositoryScope: _legacyRepositoryScope, ...accountConnection } = connection;
  return accountConnection;
}

function normalizedSourceBinding(binding, sourceState) {
  if (!binding) return null;
  const expected = expectedSourceIdentity(sourceState);
  const evidence = binding.evidenceId ? sourceState.sourceEvidenceById?.[binding.evidenceId] : null;
  const evidenceComplete = Boolean(
    binding.evidenceId
      && binding.verifiedAt
      && binding.verifiedConnectionRevision
      && evidence
      && evidence.sourceBindingId === binding.id
      && evidence.projectId === binding.projectId
      && evidence.sourceBindingRevision === binding.revision
      && evidence.codeConnectionId === binding.codeConnectionId
      && evidence.codeConnectionRevision === `${evidence.codeConnectionId}@${evidence.sourceBindingRevision}`
      && evidence.codeConnectionRevision === binding.verifiedConnectionRevision
      && evidence.repositoryScope === binding.repositoryScope
      && evidence.localRepositoryScope === binding.repositoryScope
      && evidence.providerRepositoryScope === binding.repositoryScope
      && evidence.verifiedAt === binding.verifiedAt
      && evidence.providerRead === "passed",
  );
  const identityMatches = Boolean(
    expected
      && binding.id === expected.id
      && binding.projectId === expected.projectId
      && binding.codeConnectionId === expected.codeConnectionId
      && binding.repositoryScope === expected.repositoryScope,
  );
  const revisionMatches = Boolean(
    sourceState.codeConnection
      && binding.revision === sourceState.codeConnection.revision
      && binding.verifiedConnectionRevision === codeConnectionRevision(sourceState),
  );
  const verified = Boolean(binding.verified && evidenceComplete && identityMatches && revisionMatches);
  return {
    ...binding,
    verified,
    verificationStatus: verified ? "passed" : "pending",
    verifiedConnectionRevision: verified ? binding.verifiedConnectionRevision : null,
    verifiedAt: verified ? binding.verifiedAt : null,
    evidenceId: verified ? binding.evidenceId : null,
    verifiedFrom: verified ? binding.verifiedFrom : null,
  };
}

function connectedCodeAccount(sourceState = state, status = "ready", revision = null) {
  const previous = normalizedCodeConnection(sourceState.codeConnection);
  const codeConnection = {
    ...(previous ?? {
      id: "code-cnb-account",
      provider: "CNB",
      capabilities: ["read-repository", "trigger-build", "read-build-result"],
    }),
    status,
    verifiedAt: status === "ready" ? "刚刚" : previous?.verifiedAt ?? "7 月 18 日 19:00",
    revision: revision ?? ((previous?.revision ?? 0) + 1),
  };
  return {
    codeConnectionStatus: status,
    codeConnection,
  };
}

function sourceBindingFromVerificationResult(sourceState, result) {
  const expected = expectedSourceIdentity(sourceState);
  if (!expected) return null;
  const expectedConnectionRevision = codeConnectionRevision(sourceState);
  const verified = Boolean(
    codeAccountConnectionReady(sourceState)
      && result?.localRepositoryScope === expected.repositoryScope
      && result?.providerRepositoryScope === expected.repositoryScope
      && result?.providerRead === "passed"
      && result?.codeConnectionRevision === expectedConnectionRevision
      && result?.evidenceId,
  );
  return {
    ...expected,
    verified,
    verificationStatus: verified ? "passed" : "denied",
    revision: sourceState.codeConnection?.revision ?? 1,
    verifiedConnectionRevision: verified ? expectedConnectionRevision : null,
    verifiedAt: verified ? result.verifiedAt ?? "刚刚" : null,
    evidenceId: verified ? result.evidenceId : null,
    verifiedFrom: verified ? "local-remote-and-provider-read" : null,
  };
}

// Static-prototype adapter response. The desktop runtime must pass the actual
// local Git remote and provider repository-read result into the verifier below.
function prototypeSourceProbeResult(sourceState = state, outcome = sourceState.sourceProbeOutcome ?? "passed") {
  const expected = expectedSourceIdentity(sourceState);
  if (!expected) return null;
  return {
    localRepositoryScope: sourceState.sourceProbeLocalRepositoryScope ?? expected.repositoryScope,
    providerRepositoryScope: outcome === "passed"
      ? sourceState.sourceProbeProviderRepositoryScope ?? expected.repositoryScope
      : null,
    providerRead: outcome,
    codeConnectionRevision: codeConnectionRevision(sourceState),
    evidenceId: outcome === "passed" ? `source-proof-${expected.projectId}-${sourceState.codeConnection.revision}` : null,
    verifiedAt: "刚刚",
  };
}

function verifyCurrentSourceBinding(sourceState = state, outcome = sourceState.sourceProbeOutcome ?? "passed") {
  const result = prototypeSourceProbeResult(sourceState, outcome);
  const sourceBinding = sourceBindingFromVerificationResult(sourceState, result);
  const sourceEvidenceById = sourceBinding?.verified
    ? {
        ...(sourceState.sourceEvidenceById ?? {}),
        [sourceBinding.evidenceId]: {
          id: sourceBinding.evidenceId,
          projectId: sourceBinding.projectId,
          sourceBindingId: sourceBinding.id,
          sourceBindingRevision: sourceBinding.revision,
          codeConnectionId: sourceBinding.codeConnectionId,
          codeConnectionRevision: sourceBinding.verifiedConnectionRevision,
          repositoryScope: sourceBinding.repositoryScope,
          localRepositoryScope: result.localRepositoryScope,
          providerRepositoryScope: result.providerRepositoryScope,
          providerRead: "passed",
          verifiedAt: sourceBinding.verifiedAt,
        },
      }
    : sourceState.sourceEvidenceById ?? {};
  return {
    sourceBinding,
    sourceEvidenceById,
    sourceVerificationIssue: sourceBinding?.verified
      ? null
      : {
          code: "AD-SOURCE-101",
          repositoryScope: expectedSourceIdentity(sourceState)?.repositoryScope ?? null,
          reason: result ? "provider-read-denied" : "repository-not-detected",
        },
  };
}

function verifiedCodeAccessPatch(sourceState = state, status = "ready", revision = null) {
  const accountPatch = connectedCodeAccount(sourceState, status, revision);
  const connectedState = { ...sourceState, ...accountPatch };
  return {
    ...accountPatch,
    sourceBinding: status === "ready"
      ? normalizedSourceBinding(sourceState.sourceBinding, connectedState)
      : null,
    sourceVerificationIssue: null,
  };
}

function verifiedCodeAndCurrentSourcePatch(sourceState = state, status = "ready", revision = null, probeOutcome = sourceState.sourceProbeOutcome) {
  const accountPatch = verifiedCodeAccessPatch(sourceState, status, revision);
  if (status !== "ready") return accountPatch;
  const connectedState = { ...sourceState, ...accountPatch };
  return { ...accountPatch, ...verifyCurrentSourceBinding(connectedState, probeOutcome) };
}

function sourceBindingReady(sourceState = state) {
  const expectedBinding = expectedSourceIdentity(sourceState);
  const binding = sourceState.sourceBinding;
  const evidence = binding?.evidenceId ? sourceState.sourceEvidenceById?.[binding.evidenceId] : null;
  return Boolean(
    codeAccountConnectionReady(sourceState)
      && sourceState.sourceBinding?.id === expectedBinding?.id
      && sourceState.sourceBinding?.projectId === expectedBinding?.projectId
      && sourceState.sourceBinding?.codeConnectionId === expectedBinding?.codeConnectionId
      && sourceState.sourceBinding?.repositoryScope === expectedBinding?.repositoryScope
      && sourceState.sourceBinding?.verified === true
      && sourceState.sourceBinding?.revision === sourceState.codeConnection.revision
      && sourceState.sourceBinding?.verifiedConnectionRevision === codeConnectionRevision(sourceState)
      && sourceState.sourceBinding?.verifiedAt
      && sourceState.sourceBinding?.evidenceId
      && evidence?.sourceBindingId === binding.id
      && evidence.projectId === binding.projectId
      && evidence.sourceBindingRevision === binding.revision
      && evidence.codeConnectionId === binding.codeConnectionId
      && evidence.codeConnectionRevision === `${evidence.codeConnectionId}@${evidence.sourceBindingRevision}`
      && evidence.codeConnectionRevision === binding.verifiedConnectionRevision
      && evidence.repositoryScope === binding.repositoryScope
      && evidence.verifiedAt === binding.verifiedAt
      && evidence.providerRead === "passed",
  );
}

function codeConnectionRevision(sourceState = state) {
  const connection = sourceState.codeConnection;
  return connection ? `${connection.id}@${connection.revision ?? 1}` : null;
}

function sourceBindingAttemptInput(sourceState = state) {
  if (!sourceBindingReady(sourceState)) {
    return {
      codeConnectionRevision: null,
      sourceBindingId: null,
      sourceBindingRevision: null,
      sourceBindingEvidenceId: null,
      sourceBindingVerifiedConnectionRevision: null,
      sourceBindingVerifiedAt: null,
      repositoryScope: null,
    };
  }
  return {
    codeConnectionRevision: codeConnectionRevision(sourceState),
    sourceBindingId: sourceState.sourceBinding.id,
    sourceBindingRevision: sourceState.sourceBinding.revision,
    sourceBindingEvidenceId: sourceState.sourceBinding.evidenceId,
    sourceBindingVerifiedConnectionRevision: sourceState.sourceBinding.verifiedConnectionRevision,
    sourceBindingVerifiedAt: sourceState.sourceBinding.verifiedAt,
    repositoryScope: sourceState.sourceBinding.repositoryScope,
  };
}

function registryConnectionRevision(connection) {
  return connection ? `${connection.id}@${connection.revision ?? 1}` : null;
}

function canonicalRegistryEndpoint(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /\s|\\|[?#]/.test(raw)) return null;
  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase() ?? null;
  if (explicitScheme && !["https", "http"].includes(explicitScheme)) return null;
  try {
    const parsed = new URL(explicitScheme ? raw : `https://${raw}`);
    if (!parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !["https:", "http:"].includes(parsed.protocol)) return null;
    const host = parsed.host.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);
    if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..")) return null;
    return `${host}${segments.length ? `/${segments.join("/")}` : ""}`;
  } catch {
    return null;
  }
}

function registryEvidenceForConnection(connection) {
  const revision = registryConnectionRevision(connection);
  const endpoint = canonicalRegistryEndpoint(connection?.endpoint);
  const pushEndpoint = canonicalRegistryEndpoint(connection?.pushEndpoint);
  const pullEndpoint = canonicalRegistryEndpoint(connection?.pullEndpoint);
  if (!connection?.id
    || !Number.isInteger(connection.revision)
    || connection.revision < 1
    || !endpoint
    || !pushEndpoint
    || !pullEndpoint
    || endpoint !== connection.endpoint
    || pushEndpoint !== connection.pushEndpoint
    || pullEndpoint !== connection.pullEndpoint
    || !revision) return null;
  return {
    id: revision,
    registryConnectionId: connection.id,
    registryConnectionRevision: revision,
    endpoint,
    pushEndpoint,
    pullEndpoint,
    readable: connection.readable !== false,
    writable: connection.writable !== false,
    verifiedAt: connection.verifiedAt ?? "刚刚",
  };
}

function registryEvidenceLedgerWith(connection, sourceState = state) {
  const evidence = registryEvidenceForConnection(connection);
  return evidence
    ? { ...(sourceState.registryEvidenceByRevision ?? {}), [evidence.id]: evidence }
    : sourceState.registryEvidenceByRevision ?? {};
}

function registryConnectionReady(sourceState = state) {
  const connection = sourceState.registryConnection;
  const revision = registryConnectionRevision(connection);
  const mapped = connection?.id ? sourceState.registryConnectionsById?.[connection.id] : null;
  const evidence = revision ? sourceState.registryEvidenceByRevision?.[revision] : null;
  return Boolean(
    sourceState.registryConnectionStatus === "ready"
      && connection
      && sourceState.activeRegistryConnectionId === connection.id
      && mapped
      && registryConnectionRevision(mapped) === revision
      && canonicalRegistryEndpoint(connection.endpoint) === connection.endpoint
      && canonicalRegistryEndpoint(connection.pushEndpoint) === connection.pushEndpoint
      && canonicalRegistryEndpoint(connection.pullEndpoint) === connection.pullEndpoint
      && evidence?.registryConnectionId === connection.id
      && evidence.registryConnectionRevision === revision
      && evidence.endpoint === connection.endpoint
      && evidence.pushEndpoint === connection.pushEndpoint
      && evidence.pullEndpoint === connection.pullEndpoint
      && evidence.readable
      && evidence.writable
      && evidence.verifiedAt,
  );
}

function registryConnectionFromEvidence(evidence) {
  const revision = Number(String(evidence?.registryConnectionRevision ?? "").split("@").at(-1));
  if (!evidence?.registryConnectionId || !Number.isInteger(revision) || revision < 1) return null;
  return {
    id: evidence.registryConnectionId,
    revision,
    endpoint: evidence.endpoint,
    pushEndpoint: evidence.pushEndpoint,
    pullEndpoint: evidence.pullEndpoint,
    readable: evidence.readable,
    writable: evidence.writable,
    verifiedAt: evidence.verifiedAt,
  };
}

function syncedAutomationRule(sourceState = state, status = "enabled") {
  const current = sourceState.automationRule;
  if (!sourceBindingReady(sourceState)) {
    return {
      ...current,
      desiredState: { ...current.desiredState, status },
      syncState: {
        ...current.syncState,
        status: "failed",
        lastError: { code: "AD-SOURCE-101", message: "当前项目仓库尚未通过读取核对", at: "刚刚" },
      },
    };
  }
  return {
    ...current,
    desiredState: { ...current.desiredState, status },
    observedState: {
      status,
      branch: current.desiredState.branch,
      behavior: current.desiredState.behavior,
      targetEnvironment: current.desiredState.targetEnvironment,
      observedAt: "刚刚",
    },
    providerRef: sourceBindingReady(sourceState)
      ? {
          provider: sourceState.codeConnection.provider,
          connectionId: sourceState.codeConnection.id,
          connectionRevision: codeConnectionRevision(sourceState),
          sourceBindingId: sourceState.sourceBinding.id,
          repositoryScope: sourceState.sourceBinding.repositoryScope,
          sourceBindingRevision: sourceState.sourceBinding.revision,
          externalRuleId: `rule-${projectSlug(sourceState)}-main-staging`,
          externalRevision: String(current.desiredState.revision),
        }
      : current.providerRef,
    syncState: {
      status: "synced",
      desiredRevision: current.desiredState.revision,
      lastSyncedAt: "刚刚",
      lastError: null,
    },
  };
}

function automationRuleConverged(rule = state.automationRule) {
  return Boolean(
    rule?.syncState.status === "synced"
      && rule.providerRef
      && rule.syncState.desiredRevision === rule.desiredState.revision
      && rule.observedState.status === rule.desiredState.status
      && rule.observedState.branch === rule.desiredState.branch
      && rule.observedState.behavior === rule.desiredState.behavior
      && rule.observedState.targetEnvironment === rule.desiredState.targetEnvironment,
  );
}

function automationRuleStatus(rule = state.automationRule) {
  if (rule.syncState.status === "failed" || !automationRuleConverged(rule) && rule.syncState.status !== "pending") return "needs-repair";
  if (rule.syncState.status === "pending") return "pending";
  return rule.desiredState.status === "paused" ? "paused" : "enabled";
}

function synchronizedAutomationRuleFor(status, sourceState = state) {
  const desiredState = {
    ...sourceState.automationRule.desiredState,
    status,
    revision: sourceState.automationRule.desiredState.revision + 1,
  };
  const nextState = { ...sourceState, automationRule: { ...sourceState.automationRule, desiredState } };
  return syncedAutomationRule(nextState, status);
}

function fixtureArtifactRefs(versionId, sourceState = state, registryConnection = sourceState.registryConnection) {
  if (!registryConnection) return [];
  const fixture = versionFixture(versionId, sourceState);
  if (!fixture) return [];
  const serviceIds = projectRecord(sourceState).serviceIds
    ?? Object.keys(sourceState.localServices ?? {});
  return serviceIds.map((serviceId) => ({
    serviceId,
    digest: fixtureServiceDigest(fixture.digestHex, serviceId),
    repository: `${registryConnection.endpoint}/${projectSlug(sourceState)}-${serviceId}`,
    registryConnectionId: registryConnection.id,
    registryConnectionRevision: registryConnectionRevision(registryConnection),
  }));
}

function fixtureServiceDigest(digestHex, serviceId) {
  const suffix = [...String(serviceId)].reduce((total, character) => (total + character.charCodeAt(0)) % 256, 0)
    .toString(16)
    .padStart(2, "0");
  return `sha256:${digestHex.slice(0, 62)}${suffix}`;
}

function versionRecord(versionId, sourceState = state) {
  return sourceState.versionsById?.[versionId] ?? null;
}

function versionDisplayName(versionId, sourceState = state) {
  return versionRecord(versionId, sourceState)?.displayName ?? "未知版本";
}

function productionVersionDisplayName(sourceState = state) {
  const task = sourceState.activeTaskId == null ? null : sourceState.tasksById?.[sourceState.activeTaskId];
  const targetVersionId = task?.kind === "production"
    ? task.goalSnapshot?.targetVersionId
    : sourceState.productionVersionId;
  return targetVersionId
    ? versionDisplayName(targetVersionId, sourceState)
    : null;
}

function currentProductionVersionDisplayName(sourceState = state) {
  return sourceState.currentProductionVersionId
    ? versionDisplayName(sourceState.currentProductionVersionId, sourceState)
    : null;
}

function discoveredDeploymentSnapshot(serverConnectionId, sourceState = state) {
  const server = sourceState.serverConnections[serverConnectionId];
  const registry = sourceState.registryConnection;
  if (!serverConnectionReady(serverConnectionId, sourceState)
    || server.capability !== "compatible"
    || server.host !== "203.0.113.10"
    || !server.fingerprint
    || !registry) return null;
  const configRefs = (environment) => REQUIRED_CONFIG_KEYS[environment].map((key) => ({
    key,
    secretRef: `existing-${projectSlug(sourceState)}-${environment}-${key.toLowerCase()}`,
    valueReady: true,
  }));
  return {
    id: EXISTING_DISCOVERY_ID,
    projectId: sourceState.currentProjectId ?? PROJECT_ID,
    sourceDefinitionId: "local-deploy-definition-shop",
    observedAt: "刚刚",
    serverConnectionId,
    serverConnectionRevision: `${serverConnectionId}@${server.revision ?? 1}`,
    serverHost: server.host,
    serverFingerprint: server.fingerprint,
    environments: {
      staging: {
        displayName: HISTORY_VERSION,
        versionId: HISTORY_VERSION_ID,
        sourceRef: "main",
        sourceCommit: VERSION_FIXTURES[HISTORY_VERSION_ID].sourceCommit,
        artifactRefs: fixtureArtifactRefs(HISTORY_VERSION_ID, sourceState, registry),
        address: "https://shop-test.example.net",
        configRefs: configRefs("staging"),
        serviceRevision: "imported-service-staging",
        deploymentRevision: "imported-deploy-staging",
        healthCheck: "passed",
      },
      production: {
        displayName: EXISTING_PRODUCTION_VERSION,
        versionId: EXISTING_PRODUCTION_VERSION_ID,
        sourceRef: "main",
        sourceCommit: VERSION_FIXTURES[EXISTING_PRODUCTION_VERSION_ID].sourceCommit,
        artifactRefs: fixtureArtifactRefs(EXISTING_PRODUCTION_VERSION_ID, sourceState, registry),
        address: "https://shop.example.com",
        configRefs: configRefs("production"),
        serviceRevision: "imported-service-production",
        deploymentRevision: "imported-deploy-production",
        healthCheck: "passed",
      },
    },
  };
}

function importVersionRecord(discovery, environment, sourceState) {
  const facts = discovery.environments[environment];
  const taskId = `import-${discovery.id}-${environment}`;
  const task = {
    id: taskId,
    kind: "import",
    status: "completed",
    target: facts.displayName,
    intent: "adopt-existing",
    projectId: discovery.projectId,
    environment,
    createdAt: discovery.observedAt,
    resultVersionId: facts.versionId,
    goalSnapshot: {
      targetVersionId: facts.versionId,
      sourceRef: facts.sourceRef,
      sourceCommit: facts.sourceCommit,
      expectedResult: "existing-version-import",
      environment,
      intent: "adopt-existing",
    },
  };
  const binding = sourceState.environmentBindings[environment];
  const succeededAttempt = attemptRecord(taskId, 1, {
    status: "succeeded",
    stage: "completed",
    externalRunId: null,
    startedAt: discovery.observedAt,
    endedAt: discovery.observedAt,
    inputSnapshot: {
      sourceCommit: facts.sourceCommit,
      ...sourceBindingAttemptInput(sourceState),
      registryConnectionId: facts.artifactRefs[0]?.registryConnectionId ?? null,
      registryConnectionRevision: facts.artifactRefs[0]?.registryConnectionRevision ?? null,
      serverConnectionId: discovery.serverConnectionId,
      serverConnectionRevision: `${discovery.serverConnectionId}@${sourceState.serverConnections[discovery.serverConnectionId]?.revision ?? 1}`,
      configProfileIds: [...(binding.configProfileIds ?? [])],
      configProfileRevisions: desiredConfigRevisions(environment, sourceState),
      configRevision: configRevision(environment, sourceState),
      activeAddress: facts.address,
      desiredAddress: null,
      address: facts.address,
      projectServiceIds: canonicalArtifactRefs(facts.artifactRefs).map((artifact) => artifact.serviceId),
      serviceRevision: facts.serviceRevision,
      deploymentRevision: facts.deploymentRevision,
    },
  });
  const attempt = {
    ...succeededAttempt,
    outputSnapshot: {
      versionId: facts.versionId,
      artifactRefs: canonicalArtifactRefs(facts.artifactRefs),
      environmentSnapshot: succeededEnvironmentSnapshot(succeededAttempt, {
        address: facts.address,
        healthCheck: facts.healthCheck,
      }),
    },
  };
  const version = versionFromSucceededAttempt({
    versionId: facts.versionId,
    displayName: facts.displayName,
    task,
    attempt,
    origin: "import",
    sourceDiscoverySnapshotId: discovery.id,
    sourceState,
  });
  return version ? { task, attempt, version } : null;
}

function dnsRecordFor(domain, host) {
  const value = String(host ?? "").trim();
  const ipv4 = value.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return { domain, type: "A", value };
  }
  if (value.includes(":") && /^[0-9a-f:]+$/i.test(value)) return { domain, type: "AAAA", value };
  return { domain, type: "CNAME", value };
}

function taskRecord({ id, kind, status, target, targetVersionId = null, intent = "publish", environment, sourceRef = "main", sourceCommit = CURRENT_SOURCE_COMMIT, projectId = PROJECT_ID }) {
  const targetEnvironment = environment ?? (kind === "production" ? "production" : "staging");
  return {
    id,
    kind,
    status,
    target,
    intent,
    projectId,
    environment: targetEnvironment,
    createdAt: "7 月 18 日 19:13",
    goalSnapshot: {
      targetVersionId: kind === "production" ? targetVersionId : null,
      expectedResult: kind === "test" ? "staging-version" : "production-release",
      environment: targetEnvironment,
      intent,
      ...(kind === "test" ? { sourceRef, sourceCommit } : {}),
    },
  };
}

function validFullCommit(value) {
  return /^[0-9a-f]{40}$/.test(String(value ?? ""));
}

function createStagingTask({ id, status, target }, sourceState = state) {
  const sourceRef = sourceState.sourceRevision?.ref ?? "main";
  const sourceCommit = sourceState.sourceRevision?.commit;
  if (!validFullCommit(sourceCommit)) return null;
  return taskRecord({ id, kind: "test", status, target, sourceRef, sourceCommit, projectId: sourceState.currentProjectId ?? PROJECT_ID });
}

function createProductionTask({ id, versionId, intent = "publish", status = "waiting-input" }, sourceState = state) {
  if (!isVersionQualified(versionId, sourceState)) return null;
  return taskRecord({
    id,
    kind: "production",
    status,
    target: versionDisplayName(versionId, sourceState),
    targetVersionId: versionId,
    intent,
    projectId: sourceState.currentProjectId ?? PROJECT_ID,
  });
}

function attemptRecord(taskId, sequence, overrides = {}) {
  return {
    id: `attempt-${taskId}-${sequence}`,
    taskId,
    sequence,
    status: "running",
    stage: "deploy-services",
    externalRunId: `remote-${taskId}-${sequence}`,
    errorCode: null,
    inputSnapshot: null,
    startedAt: "7 月 18 日 19:13",
    endedAt: null,
    ...overrides,
  };
}

function validationEvidence(versionId, outcome, overrides = {}) {
  return {
    versionId,
    outcome,
    environment: "staging",
    configRevision: null,
    serviceRevision: null,
    deploymentRevision: null,
    serverConnectionId: null,
    serverConnectionRevision: null,
    address: null,
    healthCheck: null,
    ...overrides,
  };
}

function boundConfigProfiles(environment, sourceState = state) {
  const ids = sourceState.environmentBindings[environment]?.configProfileIds ?? [];
  return ids
    .map((id) => sourceState.configProfiles.find((profile) => profile.id === id))
    .filter((profile) => configProfileAvailableToProject(profile, sourceState.currentProjectId));
}

function configProfileAvailableToProject(profile, projectId = state.currentProjectId) {
  return Boolean(profile && (!profile.projectId || profile.projectId === projectId));
}

function configProfileForKey(environment, key, sourceState = state) {
  return boundConfigProfiles(environment, sourceState).find((profile) => profile.key === key && profile.valueReady !== false);
}

function configProfileLabelForKey(environment, key, sourceState = state) {
  return configProfileForKey(environment, key, sourceState)?.label ?? null;
}

function projectOwnedConfigProfileId(environment, key, sourceState = state) {
  return `config-${projectSlug(sourceState)}-${environment}-${key.toLowerCase().replaceAll("_", "-")}`;
}

function missingRequiredConfigKeys(environment, sourceState = state) {
  return REQUIRED_CONFIG_KEYS[environment].filter((key) => !configProfileForKey(environment, key, sourceState));
}

function environmentBindingsWithUniqueConfigMatches(environment, sourceState = state) {
  const binding = sourceState.environmentBindings[environment];
  const configProfileIds = [...(binding.configProfileIds ?? [])];
  for (const key of REQUIRED_CONFIG_KEYS[environment]) {
    if ((binding.autoMatchBlockedKeys ?? []).includes(key)) continue;
    const alreadyBound = configProfileIds.some((profileId) => {
      const profile = sourceState.configProfiles.find((candidate) => candidate.id === profileId);
      return profile?.key === key && profile.valueReady !== false;
    });
    if (alreadyBound) continue;
    const candidates = sourceState.configProfiles.filter((profile) => profile.key === key
      && profile.valueReady !== false
      && profile.environmentScope === environment
      && (key !== "ADMIN_PASSWORD" || profile.projectId === sourceState.currentProjectId)
      && configProfileAvailableToProject(profile, sourceState.currentProjectId));
    if (candidates.length === 1) configProfileIds.push(candidates[0].id);
  }
  return {
    ...sourceState.environmentBindings,
    [environment]: { ...binding, configProfileIds: [...new Set(configProfileIds)] },
  };
}

function configRevision(environment, sourceState = state) {
  const binding = sourceState.environmentBindings[environment] ?? {};
  const profiles = boundConfigProfiles(environment, sourceState);
  if (!profiles.length || profiles.some((profile) => binding.appliedConfigRevisions?.[profile.id] == null)) return null;
  const revisions = profiles
    .map((profile) => `${profile.id}@${binding.appliedConfigRevisions[profile.id]}`)
    .sort();
  return revisions.join("+");
}

function desiredConfigRevisions(environment, sourceState = state) {
  return Object.fromEntries(boundConfigProfiles(environment, sourceState)
    .map((profile) => [profile.id, profile.revision ?? 1]));
}

function bindingWithAppliedAttemptConfig(environment, attempt, sourceState = state) {
  const binding = sourceState.environmentBindings[environment];
  if (attempt?.status !== "succeeded") return binding;
  const frozenIds = [...(attempt.inputSnapshot?.configProfileIds ?? [])].sort();
  const revisions = attempt.inputSnapshot?.configProfileRevisions ?? {};
  const revisionIds = Object.keys(revisions).sort();
  const currentIds = [...(binding.configProfileIds ?? [])].sort();
  if (JSON.stringify(frozenIds) !== JSON.stringify(revisionIds)
    || JSON.stringify(frozenIds) !== JSON.stringify(currentIds)) return null;
  return {
    ...binding,
    appliedConfigRevisions: { ...revisions },
  };
}

function productionAttemptInputStillMatches(task, attempt, sourceState = state) {
  if (!task || task.kind !== "production" || !attempt?.inputSnapshot) return false;
  const inputSnapshot = attempt.inputSnapshot;
  return Boolean(
    inputSnapshot.targetVersionId === task.goalSnapshot.targetVersionId
      && artifactRefsEqual(inputSnapshot.artifactRefs, versionRecord(task.goalSnapshot.targetVersionId, sourceState)?.artifactRefs)
      && executionEnvironmentInputStillMatches(task, attempt, sourceState),
  );
}

function executionEnvironmentInputStillMatches(task, attempt, sourceState = state) {
  if (!task || !attempt?.inputSnapshot || !["test", "production"].includes(task.kind)) return false;
  const inputSnapshot = attempt.inputSnapshot;
  const binding = sourceState.environmentBindings?.[task.environment];
  const server = sourceState.serverConnections?.[binding?.serverConnectionId];
  const frozenProfileIds = [...(inputSnapshot.configProfileIds ?? [])].sort();
  const currentProfileIds = [...(binding?.configProfileIds ?? [])].sort();
  const frozenConfigRevisions = Object.entries(inputSnapshot.configProfileRevisions ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const currentConfigRevisions = Object.entries(desiredConfigRevisions(task.environment, sourceState)).sort(([left], [right]) => left.localeCompare(right));
  const expectedAddress = task.kind === "test"
    ? stagingAddress(sourceState)
    : binding?.desiredAddress ?? binding?.address ?? null;
  return Boolean(
    binding
      && task.projectId === sourceState.currentProjectId
      && JSON.stringify([...(inputSnapshot.projectServiceIds ?? [])].sort()) === JSON.stringify([...(projectRecord(sourceState).serviceIds ?? [])].sort())
      && binding.serverConnectionId === inputSnapshot.serverConnectionId
      && serverConnectionReady(binding.serverConnectionId, sourceState)
      && inputSnapshot.serverConnectionRevision === `${binding.serverConnectionId}@${server.revision ?? 1}`
      && JSON.stringify(frozenProfileIds) === JSON.stringify(currentProfileIds)
      && JSON.stringify(frozenConfigRevisions) === JSON.stringify(currentConfigRevisions)
      && (binding.address ?? null) === (inputSnapshot.activeAddress ?? null)
      && (binding.desiredAddress ?? null) === (inputSnapshot.desiredAddress ?? null)
      && inputSnapshot.address === expectedAddress,
  );
}

function productionExecutionReady(task, sourceState = state) {
  if (!task || task.kind !== "production" || !isVersionQualified(task.goalSnapshot?.targetVersionId, sourceState)) return false;
  const binding = sourceState.environmentBindings?.production;
  const address = binding?.desiredAddress ?? binding?.address ?? null;
  const version = versionRecord(task.goalSnapshot.targetVersionId, sourceState);
  return Boolean(
    serverConnectionReady(binding?.serverConnectionId, sourceState)
      && missingRequiredConfigKeys("production", sourceState).length === 0
      && /^https:\/\/[^/\s]+$/.test(String(address ?? ""))
      && version
      && artifactRefsResolveThroughKnownRegistry(version.artifactRefs, sourceState),
  );
}

function configEnvironmentLabel(environment) {
  return environment === "production" ? "正式环境" : "测试环境";
}

function onlineVersionIdForEnvironment(environment, sourceState = state) {
  const versionId = environment === "production"
    ? sourceState.currentProductionVersionId
    : currentTestVersionId(sourceState);
  return versionRecord(versionId, sourceState)?.projectId === sourceState.currentProjectId ? versionId : null;
}

function configApplicationReady(task, pending, sourceState = state) {
  const environment = pending?.environment;
  const binding = ["staging", "production"].includes(environment)
    ? sourceState.environmentBindings?.[environment]
    : null;
  const profile = sourceState.configProfiles?.find((item) => item.id === pending?.profileId);
  const openTasks = openMutationTasks(sourceState);
  const onlineVersionId = onlineVersionIdForEnvironment(environment, sourceState);
  return Boolean(
    task
      && pending
      && task.kind === "config"
      && task.status === "waiting"
      && task.projectId === sourceState.currentProjectId
      && pending.projectId === sourceState.currentProjectId
      && task.environment === environment
      && task.goalSnapshot?.environment === environment
      && task.goalSnapshot?.expectedResult === "config-applied"
      && task.goalSnapshot?.targetVersionId === onlineVersionId
      && task.goalSnapshot?.profileId === pending.profileId
      && task.goalSnapshot?.profileRevision === pending.profileRevision
      && task.goalSnapshot?.previousConfigRevision === pending.previousRevision
      && profile
      && configProfileAvailableToProject(profile, sourceState.currentProjectId)
      && profile.revision === pending.profileRevision
      && profile.valueReady !== false
      && binding?.configProfileIds?.includes(profile.id)
      && (binding.appliedConfigRevisions?.[profile.id] ?? null) === (pending.previousRevision ?? null)
      && missingRequiredConfigKeys(environment, sourceState).length === 0
      && serverConnectionReady(binding.serverConnectionId, sourceState)
      && /^https?:\/\/[^/\s]+$/.test(String(binding.address ?? ""))
      && openTasks.length === 1
      && openTasks[0].id === task.id,
  );
}

function configAttemptInputStillMatches(task, pending, attempt, sourceState = state) {
  const input = attempt?.inputSnapshot;
  const binding = pending ? sourceState.environmentBindings?.[pending.environment] : null;
  const server = binding?.serverConnectionId ? sourceState.serverConnections?.[binding.serverConnectionId] : null;
  const profile = sourceState.configProfiles?.find((item) => item.id === pending?.profileId);
  return Boolean(
    task?.kind === "config"
      && task.projectId === sourceState.currentProjectId
      && pending?.taskId === task.id
      && input
      && input.environment === pending.environment
      && input.targetVersionId === onlineVersionIdForEnvironment(pending.environment, sourceState)
      && input.profileId === pending.profileId
      && input.profileRevision === pending.profileRevision
      && input.previousConfigRevision === pending.previousRevision
      && profile?.revision === input.profileRevision
      && profile.valueReady !== false
      && input.serverConnectionId === binding?.serverConnectionId
      && input.serverConnectionRevision === `${binding?.serverConnectionId}@${server?.revision ?? 0}`
      && serverConnectionReady(binding?.serverConnectionId, sourceState)
      && JSON.stringify([...(input.configProfileIds ?? [])].sort()) === JSON.stringify([...(binding?.configProfileIds ?? [])].sort())
      && JSON.stringify(input.configProfileRevisions ?? {}) === JSON.stringify(desiredConfigRevisions(pending.environment, sourceState))
      && JSON.stringify(input.previousAppliedConfigRevisions ?? {}) === JSON.stringify(binding?.appliedConfigRevisions ?? {})
      && input.address === binding?.address,
  );
}

function projectWorkspaceForRead(projectId, sourceState = state) {
  if (projectId === sourceState.currentProjectId) return sourceState;
  return sourceState.projectWorkspacesById?.[projectId] ?? null;
}

function configProfileUsages(profileId, sourceState = state) {
  const selectedProfile = sourceState.configProfiles.find((profile) => profile.id === profileId);
  return (sourceState.projects ?? []).flatMap((project) => {
    if (!configProfileAvailableToProject(selectedProfile, project.id)) return [];
    const workspace = projectWorkspaceForRead(project.id, sourceState);
    if (!workspace) return [];
    return ["staging", "production"].flatMap((environment) => {
      const binding = workspace.environmentBindings?.[environment];
      if (!binding?.configProfileIds?.includes(profileId)) return [];
      return [{
        projectId: project.id,
        projectName: project.name,
        environment,
        label: `${project.name} / ${configEnvironmentLabel(environment)}`,
        appliedRevision: binding.appliedConfigRevisions?.[profileId] ?? null,
      }];
    });
  });
}

function projectEnvironmentBinding(projectId, environment, sourceState = state) {
  return projectWorkspaceForRead(projectId, sourceState)?.environmentBindings?.[environment] ?? null;
}

function profileBoundToProjectEnvironment(profileId, projectId, environment, sourceState = state) {
  return Boolean(projectEnvironmentBinding(projectId, environment, sourceState)?.configProfileIds?.includes(profileId));
}

function projectEnvironmentBindingLabel(projectId, environment, sourceState = state) {
  const project = sourceState.projects.find((item) => item.id === projectId);
  return `${project?.name ?? "项目"} / ${configEnvironmentLabel(environment)}`;
}

function updateProjectEnvironmentBinding(sourceState, projectId, environment, transform) {
  if (projectId === sourceState.currentProjectId) {
    const current = sourceState.environmentBindings?.[environment];
    if (!current) return null;
    return {
      environmentBindings: {
        ...sourceState.environmentBindings,
        [environment]: transform(current),
      },
      projectWorkspacesById: sourceState.projectWorkspacesById,
    };
  }
  const workspace = sourceState.projectWorkspacesById?.[projectId];
  const current = workspace?.environmentBindings?.[environment];
  if (!workspace || !current) return null;
  return {
    environmentBindings: sourceState.environmentBindings,
    projectWorkspacesById: {
      ...sourceState.projectWorkspacesById,
      [projectId]: {
        ...workspace,
        environmentBindings: {
          ...workspace.environmentBindings,
          [environment]: transform(current),
        },
      },
    },
  };
}

function serverConnectionReady(connectionId, sourceState = state) {
  const connection = connectionId ? sourceState.serverConnections[connectionId] : null;
  const revision = connection && Number.isInteger(connection.revision) && connection.revision > 0
    ? `${connectionId}@${connection.revision}`
    : null;
  const evidence = revision ? sourceState.serverEvidenceByRevision?.[revision] : null;
  return Boolean(
    connection?.verified
      && ["clean", "compatible"].includes(connection.capability)
      && connection.host
      && connection.fingerprint
      && evidence?.id === revision
      && evidence.serverConnectionId === connectionId
      && evidence.serverConnectionRevision === revision
      && evidence.host === connection.host
      && evidence.fingerprint === connection.fingerprint
      && evidence.capability === connection.capability
      && evidence.verifiedAt,
  );
}

function serverEvidenceForConnection(connectionId, connection) {
  if (!connectionId
    || !connection?.verified
    || !connection.host
    || !connection.fingerprint
    || !connection.verifiedAt
    || !["clean", "compatible"].includes(connection.capability)
    || !Number.isInteger(connection.revision)
    || connection.revision < 1) return null;
  const revision = `${connectionId}@${connection.revision}`;
  return {
    id: revision,
    serverConnectionId: connectionId,
    serverConnectionRevision: revision,
    host: connection.host ?? null,
    fingerprint: connection.fingerprint ?? null,
    capability: connection.capability ?? null,
    verifiedAt: connection.verifiedAt ?? "刚刚",
  };
}

function serverEvidenceLedgerWith(connectionId, connection, sourceState = state) {
  const evidence = serverEvidenceForConnection(connectionId, connection);
  return evidence
    ? { ...(sourceState.serverEvidenceByRevision ?? {}), [evidence.id]: evidence }
    : sourceState.serverEvidenceByRevision ?? {};
}

function verifiedServerEntries(sourceState = state, excludeId = null) {
  return Object.entries(sourceState.serverConnections)
    .filter(([id]) => id !== excludeId && serverConnectionReady(id, sourceState))
    .sort(([, left], [, right]) => left.label.localeCompare(right.label, "zh-CN"));
}

function stagingValidationEvidence(versionId, outcome, sourceState = state, overrides = {}) {
  const version = versionRecord(versionId, sourceState);
  const sourceAttempt = version
    ? (sourceState.attemptsByTaskId?.[version.sourceTaskId] ?? [])
      .find((attempt) => attempt.id === version.sourceAttemptId)
    : null;
  const environmentSnapshot = sourceAttempt?.outputSnapshot?.environmentSnapshot ?? {};
  return validationEvidence(versionId, outcome, {
    ...environmentSnapshot,
    checkedAt: overrides.checkedAt ?? null,
  });
}

function canonicalArtifactRefs(refs) {
  return (refs ?? [])
    .map((ref) => ({
      serviceId: ref.serviceId,
      repository: ref.repository,
      digest: ref.digest,
      registryConnectionId: ref.registryConnectionId,
      registryConnectionRevision: ref.registryConnectionRevision,
    }))
    .sort((left, right) => String(left.serviceId ?? "").localeCompare(String(right.serviceId ?? "")));
}

function artifactRefsEqual(left, right) {
  return JSON.stringify(canonicalArtifactRefs(left)) === JSON.stringify(canonicalArtifactRefs(right));
}

function immutableDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value ?? ""));
}

function artifactRepositoryBelongsToConnection(artifact, connection) {
  const endpoint = canonicalRegistryEndpoint(connection?.pullEndpoint ?? connection?.endpoint);
  const repository = canonicalRegistryEndpoint(artifact?.repository);
  return Boolean(endpoint && repository.startsWith(`${endpoint}/`));
}

function artifactRefsResolveThroughKnownRegistry(refs, sourceState = state) {
  return canonicalArtifactRefs(refs).every((artifact) => {
    const evidence = sourceState.registryEvidenceByRevision?.[artifact.registryConnectionRevision];
    return Boolean(evidence)
      && evidence.registryConnectionId === artifact.registryConnectionId
      && evidence.registryConnectionRevision === artifact.registryConnectionRevision
      && evidence.readable
      && evidence.verifiedAt
      && artifactRepositoryBelongsToConnection(artifact, evidence)
      && immutableDigest(artifact.digest);
  });
}

function artifactRefsMatchAttemptRegistry(refs, attempt) {
  const frozenConnectionId = attempt?.inputSnapshot?.registryConnectionId;
  const frozenRevision = attempt?.inputSnapshot?.registryConnectionRevision;
  const frozenRevisionMatch = /^(.+)@([1-9]\d*)$/.exec(String(frozenRevision ?? ""));
  return Boolean(frozenConnectionId && frozenRevisionMatch?.[1] === frozenConnectionId)
    && canonicalArtifactRefs(refs).every((artifact) => artifact.registryConnectionRevision === frozenRevision
      && artifact.registryConnectionId === frozenConnectionId);
}

function artifactRefsMatchProjectServices(refs, projectId, sourceState = state) {
  const project = sourceState.projects?.find((candidate) => candidate.id === projectId);
  const expectedServiceIds = Array.isArray(project?.serviceIds) ? [...project.serviceIds] : [];
  const actualServiceIds = canonicalArtifactRefs(refs).map((ref) => ref.serviceId);
  if (!expectedServiceIds.length
    || expectedServiceIds.some((serviceId) => typeof serviceId !== "string" || !serviceId)
    || actualServiceIds.some((serviceId) => typeof serviceId !== "string" || !serviceId)
    || new Set(expectedServiceIds).size !== expectedServiceIds.length
    || new Set(actualServiceIds).size !== actualServiceIds.length) return false;
  return JSON.stringify(expectedServiceIds.sort()) === JSON.stringify([...actualServiceIds].sort());
}

function artifactRefsMatchFrozenServices(refs, inputSnapshot) {
  const frozenServiceIds = [...(inputSnapshot?.projectServiceIds ?? [])].sort();
  const artifactServiceIds = canonicalArtifactRefs(refs).map((artifact) => artifact.serviceId).sort();
  return Boolean(
    frozenServiceIds.length
      && new Set(frozenServiceIds).size === frozenServiceIds.length
      && JSON.stringify(frozenServiceIds) === JSON.stringify(artifactServiceIds),
  );
}

function configRevisionFromAttemptInput(inputSnapshot) {
  const profileIds = [...(inputSnapshot?.configProfileIds ?? [])].sort();
  const revisions = inputSnapshot?.configProfileRevisions ?? {};
  const revisionIds = Object.keys(revisions).sort();
  if (!profileIds.length
    || JSON.stringify(profileIds) !== JSON.stringify(revisionIds)
    || profileIds.some((profileId) => revisions[profileId] == null)) return null;
  return profileIds.map((profileId) => `${profileId}@${revisions[profileId]}`).join("+");
}

function succeededEnvironmentSnapshot(attempt, { address = null, healthCheck = "passed" } = {}) {
  if (attempt?.status !== "succeeded") return null;
  const inputSnapshot = attempt.inputSnapshot ?? {};
  return {
    configRevision: configRevisionFromAttemptInput(inputSnapshot),
    serviceRevision: inputSnapshot.serviceRevision ?? null,
    deploymentRevision: inputSnapshot.deploymentRevision ?? null,
    serverConnectionId: inputSnapshot.serverConnectionId ?? null,
    serverConnectionRevision: inputSnapshot.serverConnectionRevision ?? null,
    address: address ?? inputSnapshot.address ?? null,
    healthCheck,
  };
}

function attemptEnvironmentSnapshotIsConsistent(attempt, sourceState = state) {
  const inputSnapshot = attempt?.inputSnapshot ?? {};
  const environmentSnapshot = attempt?.outputSnapshot?.environmentSnapshot;
  const frozenServerRevision = /^(.+)@([1-9]\d*)$/.exec(String(inputSnapshot.serverConnectionRevision ?? ""));
  const serverEvidence = inputSnapshot.serverConnectionRevision
    ? sourceState.serverEvidenceByRevision?.[inputSnapshot.serverConnectionRevision]
    : null;
  return Boolean(
    attempt?.status === "succeeded"
      && environmentSnapshot
      && environmentSnapshot.configRevision
      && environmentSnapshot.configRevision === configRevisionFromAttemptInput(inputSnapshot)
      && environmentSnapshot.serviceRevision
      && environmentSnapshot.serviceRevision === inputSnapshot.serviceRevision
      && environmentSnapshot.deploymentRevision
      && environmentSnapshot.deploymentRevision === inputSnapshot.deploymentRevision
      && environmentSnapshot.serverConnectionId
      && environmentSnapshot.serverConnectionId === inputSnapshot.serverConnectionId
      && environmentSnapshot.serverConnectionRevision
      && /^.+@[1-9]\d*$/.test(environmentSnapshot.serverConnectionRevision)
      && environmentSnapshot.serverConnectionRevision === inputSnapshot.serverConnectionRevision
      && frozenServerRevision?.[1] === inputSnapshot.serverConnectionId
      && serverEvidence?.id === inputSnapshot.serverConnectionRevision
      && serverEvidence?.serverConnectionId === inputSnapshot.serverConnectionId
      && serverEvidence.serverConnectionRevision === inputSnapshot.serverConnectionRevision
      && ["clean", "compatible"].includes(serverEvidence.capability)
      && serverEvidence.host
      && serverEvidence.fingerprint
      && serverEvidence.verifiedAt
      && environmentSnapshot.address
      && environmentSnapshot.address === inputSnapshot.address
      && environmentSnapshot.healthCheck === "passed",
  );
}

function sourceAttemptIdentityIsConsistent(attempt, task, sourceState = state) {
  const inputSnapshot = attempt?.inputSnapshot ?? {};
  const project = sourceState.projects?.find((candidate) => candidate.id === task?.projectId);
  const evidence = inputSnapshot.sourceBindingEvidenceId
    ? sourceState.sourceEvidenceById?.[inputSnapshot.sourceBindingEvidenceId]
    : null;
  return Boolean(
    project?.repositoryScope
      && inputSnapshot.codeConnectionRevision
      && inputSnapshot.sourceBindingId === `source-${task.projectId}`
      && Number.isInteger(inputSnapshot.sourceBindingRevision)
      && inputSnapshot.sourceBindingRevision > 0
      && inputSnapshot.sourceBindingEvidenceId
      && inputSnapshot.sourceBindingVerifiedAt
      && inputSnapshot.sourceBindingVerifiedConnectionRevision === inputSnapshot.codeConnectionRevision
      && inputSnapshot.repositoryScope === project.repositoryScope
      && evidence?.projectId === task.projectId
      && evidence.sourceBindingId === inputSnapshot.sourceBindingId
      && evidence.sourceBindingRevision === inputSnapshot.sourceBindingRevision
      && inputSnapshot.codeConnectionRevision === `${evidence.codeConnectionId}@${evidence.sourceBindingRevision}`
      && evidence.codeConnectionRevision === inputSnapshot.codeConnectionRevision
      && evidence.repositoryScope === inputSnapshot.repositoryScope
      && evidence.localRepositoryScope === inputSnapshot.repositoryScope
      && evidence.providerRepositoryScope === inputSnapshot.repositoryScope
      && evidence.verifiedAt === inputSnapshot.sourceBindingVerifiedAt
      && evidence.providerRead === "passed",
  );
}

function validationMatchesAttemptEnvironment(evidence, sourceTask, sourceAttempt, sourceState = state) {
  const environmentSnapshot = sourceAttempt?.outputSnapshot?.environmentSnapshot;
  const fields = ["configRevision", "serviceRevision", "deploymentRevision", "serverConnectionId", "serverConnectionRevision", "address", "healthCheck"];
  return Boolean(
    evidence
      && sourceTask?.environment === "staging"
      && evidence.environment === sourceTask.environment
      && attemptEnvironmentSnapshotIsConsistent(sourceAttempt, sourceState)
      && fields.every((field) => evidence[field] === environmentSnapshot[field]),
  );
}

function versionFromSucceededAttempt({ versionId, displayName, task, attempt, origin = "build", sourceDiscoverySnapshotId = null, sourceState = state }) {
  const artifactRefs = canonicalArtifactRefs(attempt?.outputSnapshot?.artifactRefs);
  const sourceCommit = task?.goalSnapshot?.sourceCommit ?? attempt?.inputSnapshot?.sourceCommit;
  if (!task
    || !attempt
    || !["test", "import"].includes(task.kind)
    || task.status !== "completed"
    || task.resultVersionId !== versionId
    || attempt.taskId !== task.id
    || attempt.status !== "succeeded"
    || attempt.outputSnapshot?.versionId !== versionId
    || !validFullCommit(sourceCommit)
    || attempt.inputSnapshot?.sourceCommit !== sourceCommit
    || !sourceAttemptIdentityIsConsistent(attempt, task, sourceState)
    || !artifactRefsMatchProjectServices(artifactRefs, task.projectId, sourceState)
    || !artifactRefsMatchFrozenServices(artifactRefs, attempt.inputSnapshot)
    || !artifactRefsMatchAttemptRegistry(artifactRefs, attempt)
    || !artifactRefsResolveThroughKnownRegistry(artifactRefs, sourceState)
    || !attemptEnvironmentSnapshotIsConsistent(attempt, sourceState)
    || artifactRefs.some((ref) => !ref.repository || !ref.digest || !ref.registryConnectionId || !ref.registryConnectionRevision)) {
    return null;
  }
  return {
    id: versionId,
    projectId: task.projectId,
    displayName,
    createdAt: task.createdAt,
    sourceRef: task.goalSnapshot.sourceRef,
    sourceCommit,
    sourceTaskId: task.id,
    sourceAttemptId: attempt.id,
    codeConnectionRevision: attempt.inputSnapshot.codeConnectionRevision,
    sourceBindingId: attempt.inputSnapshot.sourceBindingId,
    sourceBindingRevision: attempt.inputSnapshot.sourceBindingRevision,
    sourceBindingEvidenceId: attempt.inputSnapshot.sourceBindingEvidenceId,
    sourceBindingVerifiedConnectionRevision: attempt.inputSnapshot.sourceBindingVerifiedConnectionRevision,
    sourceBindingVerifiedAt: attempt.inputSnapshot.sourceBindingVerifiedAt,
    repositoryScope: attempt.inputSnapshot.repositoryScope,
    artifactRefs,
    origin,
    sourceDiscoverySnapshotId,
  };
}

function productionSetupReady(sourceState = state) {
  const binding = sourceState.environmentBindings.production;
  const domain = String(sourceState.formValues.productionDomain ?? "").trim().toLowerCase();
  const canonicalAddress = domain ? `https://${domain}` : null;
  return Boolean(
    serverConnectionReady(binding.serverConnectionId, sourceState)
      && missingRequiredConfigKeys("production", sourceState).length === 0
      && validDomain(domain)
      && canonicalAddress
      && (binding.desiredAddress === canonicalAddress || binding.address === canonicalAddress),
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fieldValue(name) {
  return escapeHtml(state.formValues[name]);
}

function fieldError(name) {
  const message = state.formErrors[name];
  return message ? `<small id="field-error-${name}" class="field-error" role="alert">${escapeHtml(message)}</small>` : "";
}

function fieldA11y(name) {
  return state.formErrors[name] ? `aria-invalid="true" aria-describedby="field-error-${name}"` : 'aria-invalid="false"';
}

const sourceAuthorizationQuestion = {
  key: "permission",
  title: "允许自动接收代码更新",
  summary: "以后代码更新时，系统才能自动生成新的测试版。",
  body: () => `
    <p class="drawer-lead">只需授权一次。ABCDeploy 仅申请读取这个项目和触发更新所需的权限，稍后可以在项目设置中更换。</p>
    <div class="form-field">
      <label for="publish-token">代码平台授权</label>
      <input id="publish-token" data-field="publishToken" type="password" value="${fieldValue("publishToken")}" placeholder="粘贴授权信息" ${fieldA11y("publishToken")} autocomplete="off" />
      <small>只保存到系统密钥库，不写入项目文件。</small>
      ${fieldError("publishToken")}
    </div>
    <button class="text-button inline-action" type="button" data-action="open-code-credential-help">还没有授权？查看获取步骤</button>
    <details class="technical-details">
      <summary>查看授权来源</summary>
      <p>首版由 CNB 接收代码更新。这里展示用途，不要求用户先理解平台权限名称。</p>
    </details>
  `,
};

const versionStorageQuestion = {
  key: "version-storage",
  title: "选择生成版本的保存位置",
  summary: "测试通过的版本会保留在这里，以后可直接发布或恢复。",
  body: () => `
    <p class="drawer-lead">这是第一次使用 ABCDeploy，因此还没有可复用的版本保存位置。可以粘贴控制台给出的仓库地址；系统会识别实例和命名空间。</p>
    <button class="text-button inline-action" type="button" data-action="open-registry-credential-help">还没有版本仓库？查看创建步骤</button>
    <div class="form-field">
      <label for="version-endpoint">版本仓库地址</label>
      <input id="version-endpoint" data-field="registryEndpoint" value="${fieldValue("registryEndpoint")}" placeholder="例如 ccr.ccs.tencentyun.com/team" ${fieldA11y("registryEndpoint")} autocomplete="off" />
      <small>不需要区分 push 与 pull，系统会验证并保存实际端点。</small>
      ${fieldError("registryEndpoint")}
    </div>
    <div class="form-field">
      <label for="version-account">登录账号</label>
      <input id="version-account" data-field="versionAccount" value="${fieldValue("versionAccount")}" placeholder="版本保存账号" ${fieldA11y("versionAccount")} autocomplete="off" />
      ${fieldError("versionAccount")}
    </div>
    <div class="form-field">
      <label for="version-password">访问密码</label>
      <input id="version-password" data-field="versionPassword" type="password" value="${fieldValue("versionPassword")}" placeholder="访问密码" ${fieldA11y("versionPassword")} autocomplete="off" />
      <small>系统会先验证推送和读取能力，再保存到系统密钥库。</small>
      ${fieldError("versionPassword")}
    </div>
    <details class="technical-details">
      <summary>查看连接详情</summary>
      <p>首版推荐腾讯云 TCR；产品只依赖通用 OCI 版本存储能力，后续可替换其他厂商。</p>
    </details>
  `,
};

function serverCapabilityPanel() {
  // Older prototype snapshots used "adaptable" for an unproven promise that
  // ABCDeploy could rewrite an arbitrary existing reverse proxy. Treat those
  // snapshots as a conflict until the existing Caddy contract is verified.
  const capability = state.serverCapability === "adaptable" ? "conflict" : state.serverCapability ?? "clean";
  const cancelAction = state.sheet === "connection-edit" ? "back-to-connections" : "replace-server-details";
  const cancelLabel = state.sheet === "connection-edit" ? "取消添加" : "换一台服务器";
  const readOnlyAdoption = state.connectionReturnSheet === "existing-adopt";
  const fixtureSwitch = `
    <div class="fixture-switch" aria-label="切换服务器识别结果">
      <span>原型反例：</span>
      <button type="button" data-server-capability="missing-runtime" aria-pressed="${capability === "missing-runtime"}">运行组件缺失</button>
      <button type="button" data-server-capability="clean" aria-pressed="${capability === "clean"}">可直接准备</button>
      <button type="button" data-server-capability="compatible" aria-pressed="${capability === "compatible"}">可直接复用</button>
      <button type="button" data-server-capability="conflict" aria-pressed="${capability === "conflict"}">存在冲突</button>
    </div>`;
  const cards = {
    "missing-runtime": `
      <div class="error-panel" role="alert"><div><h3>服务器运行组件还未准备</h3><p>登录与权限正常，但还缺少运行项目需要的基础组件。请先在云服务器控制台完成准备，再回到这里重新检查。</p></div></div>
      <div class="completed-list"><span>✓ 已确认服务器身份</span><span>✓ 登录与权限正常</span><span>○ 运行组件需要准备</span></div>
      <div class="button-row"><button class="secondary-button" type="button" data-action="copy-server-preparation">复制准备说明</button><button class="secondary-button" type="button" data-action="recheck-server-capability">重新检查</button><button class="text-button" type="button" data-action="${cancelAction}">${cancelLabel}</button></div>`,
    clean: readOnlyAdoption
      ? `<div class="error-panel" role="alert"><div><h3>没有发现可只读接入的已有访问服务</h3><p>接入已有部署不会在确认前初始化服务器。请核对正确服务器，或退出接入后使用“重新设置部署”。</p></div></div><div class="button-row"><button class="secondary-button" type="button" data-action="recheck-server-capability">重新检查</button><button class="text-button" type="button" data-action="${cancelAction}">${cancelLabel}</button></div>`
      : `<div class="action-panel warn"><span class="action-copy"><strong>这台服务器可以直接准备</strong><span>运行组件已经就绪，也没有发现访问服务冲突。确认后只创建 ABCDeploy 的共享访问服务和项目目录。</span></span><button class="secondary-button" type="button" data-action="confirm-server-change">${state.serverChangeConfirmed ? "已允许准备" : "允许准备"}</button></div>`,
    compatible: `
      <div class="action-panel success"><span class="action-copy"><strong>现有访问服务可以直接复用</strong><span>它已经提供独立的项目入口；系统只追加当前项目的访问规则，不覆盖其他站点。</span></span></div>
      <div class="completed-list"><span>✓ 服务器运行组件可用</span><span>✓ 独立项目入口可写</span><span>✓ 访问端口归属明确</span></div>`,
    conflict: `
      <div class="error-panel" role="alert"><div><h3>现有访问服务无法安全复用</h3><p>系统无法确认它的归属和安全追加入口，因此不会修改服务器。请选择其他运行位置，或把技术详情交给服务器维护人员处理。</p></div></div>
      <div class="button-row"><button class="secondary-button" type="button" data-action="recheck-server-capability">重新检查</button><button class="text-button" type="button" data-action="${cancelAction}">${cancelLabel}</button></div>`,
  };
  return `
    <p class="drawer-lead">系统先检查运行前提，再判断统一访问服务能否按已验证的契约初始化或复用。无法证明安全时直接阻断。</p>
    ${fixtureSwitch}
    ${cards[capability]}
    ${fieldError("serverCapability")}
    <details class="technical-details"><summary>查看识别依据</summary><p>技术上先检查 Docker、Compose 与用户权限，再识别 80/443 和统一 Caddy 的归属、可写站点目录、导入规则与配置校验能力。满足前提后只有三种结果：初始化共享 Caddy、复用兼容 Caddy，或阻断并交给维护人员处理。</p></details>`;
}

const destinationQuestion = {
  key: "destination",
  title: "选择测试版运行的位置",
  summary: "正式版以后再设置；现在只准备隔离的测试运行位置。",
  body: () =>
    state.setupNeedReasons.destination === "multiple"
      ? `
        <p class="drawer-lead">找到两个都可用的运行位置，系统无法替你判断成本和归属，因此只在这里询问一次。</p>
        <div class="choice-list">
          ${verifiedServerEntries().map(([id, connection], index) => `<button class="choice-card ${state.stagingServerConnectionId === id ? "selected" : ""}" type="button" aria-pressed="${state.stagingServerConnectionId === id}" data-action="${index === 0 ? "select-recommended-runtime" : "select-alternative-runtime"}" data-server-id="${escapeHtml(id)}">
            <span class="radio"></span><span class="choice-copy"><strong>${escapeHtml(connection.label)}</strong><span>${escapeHtml(connection.host)} · ${connection.capability === "compatible" ? "可以直接复用" : "已经完成准备"}</span></span>${index === 0 ? '<span class="status-badge green">推荐</span>' : ""}
          </button>`).join("")}
        </div>
        <details class="technical-details"><summary>查看连接详情</summary><p>主机身份已确认；容器运行和统一访问服务会在后台复核。</p></details>
      `
      : state.setupNeedReasons.destination === "server-identity"
        ? `
          <p class="drawer-lead">登录信息已经验证。请核对服务器身份，避免把项目部署到同一地址下的另一台机器。</p>
          <div class="action-panel warn"><span class="action-copy"><strong>${escapeHtml(state.formValues.testHost)}</strong><span>主机指纹：SHA256:K7m9…pQ2x · 首次连接</span></span><button class="secondary-button" type="button" data-action="confirm-server-fingerprint">${state.serverFingerprintConfirmed ? "已确认是这台服务器" : "确认是这台服务器"}</button></div>
          ${fieldError("serverFingerprint")}
        `
      : state.setupNeedReasons.destination === "server-capability"
        ? serverCapabilityPanel()
      : `
        <p class="drawer-lead">提供一台可以登录的 Linux 服务器即可。系统会判断它能否直接准备、复用现有访问服务或存在冲突，并只在确实会修改服务器时要求确认。</p>
        <div class="form-field"><label for="test-host">服务器地址</label><input id="test-host" data-field="testHost" value="${fieldValue("testHost")}" placeholder="例如 203.0.113.10" ${fieldA11y("testHost")} autocomplete="off" />${fieldError("testHost")}</div>
        <div class="form-field"><label for="test-user">登录用户</label><input id="test-user" data-field="testUser" value="${fieldValue("testUser")}" placeholder="例如 ubuntu" ${fieldA11y("testUser")} autocomplete="off" />${fieldError("testUser")}</div>
        <div class="choice-list compact-choice-list">
          <button class="choice-card ${state.serverAuthMethod === "password" ? "selected" : ""}" type="button" data-action="select-server-auth" data-auth-method="password" aria-pressed="${state.serverAuthMethod === "password"}"><span class="radio"></span><span class="choice-copy"><strong>使用登录密码</strong><span>适合首次试用</span></span></button>
          <button class="choice-card ${state.serverAuthMethod === "ssh-key" ? "selected" : ""}" type="button" data-action="select-server-auth" data-auth-method="ssh-key" aria-pressed="${state.serverAuthMethod === "ssh-key"}"><span class="radio"></span><span class="choice-copy"><strong>使用 SSH 密钥</strong><span>粘贴云厂商提供的私钥</span></span></button>
        </div>
        ${state.serverAuthMethod === "ssh-key"
          ? `<div class="form-field"><label for="server-ssh-key">SSH 私钥</label><input id="server-ssh-key" data-field="serverSshKey" type="password" value="${fieldValue("serverSshKey")}" placeholder="粘贴 OPENSSH PRIVATE KEY" ${fieldA11y("serverSshKey")} autocomplete="off" />${fieldError("serverSshKey")}</div>`
          : `<div class="form-field"><label for="server-password">服务器登录密码</label><input id="server-password" data-field="serverPassword" type="password" value="${fieldValue("serverPassword")}" placeholder="只用于建立安全连接" ${fieldA11y("serverPassword")} autocomplete="off" />${fieldError("serverPassword")}</div>`}
        <details class="technical-details"><summary>系统会检查什么</summary><p>后台检查容器运行能力和统一访问服务；不会覆盖归属不明的现有配置。</p></details>
      `,
};

const runtimeConfigQuestion = {
  key: "config",
  title: "补齐项目运行需要的信息",
  summary: "只展示测试环境仍缺少的必填项，已有配置会自动匹配。",
  body: () => {
    const providerLabel = configProfileLabelForKey("staging", "PROVIDER_API_KEY");
    return `
    <p class="drawer-lead">字段来自项目的 <code>.env.example</code>。有注释时用注释做标题，原始名称保留在下面；没有注释时直接显示原始名称。</p>
    <div class="config-profile required-config">
      <div class="config-profile-head">
        <div><h3>第三方服务访问密钥</h3><p>PROVIDER_API_KEY · 必填</p></div>
        ${providerLabel ? `<span class="config-actions"><span class="status-badge green">已绑定</span><button class="text-button" type="button" data-action="use-config-center">更换</button></span>` : `<button class="secondary-button" type="button" data-action="use-config-center">从配置中心选择</button>`}
      </div>
      <p>${providerLabel ? `来源：配置中心“${escapeHtml(providerLabel)}”，敏感值不会显示。` : "找到可复用配置，选择后会持续绑定到测试环境。"}</p>
      ${fieldError("configBinding")}
    </div>
    <div class="config-profile required-config">
      <div class="config-profile-head"><div><h3>管理员初始密码</h3><p>ADMIN_PASSWORD · 必填</p></div><span class="status-badge">新配置</span></div>
      <div class="form-field compact-field"><label for="admin-password">配置值</label><input id="admin-password" data-field="adminPassword" type="password" value="${fieldValue("adminPassword")}" ${fieldA11y("adminPassword")} autocomplete="off" /><small>保存后会成为配置中心条目，并绑定到测试环境。</small>${fieldError("adminPassword")}</div>
    </div>
  `;
  },
};

const allSetupQuestions = [
  sourceAuthorizationQuestion,
  versionStorageQuestion,
  destinationQuestion,
  runtimeConfigQuestion,
];

function setupQuestionsForNeeds(needs) {
  return allSetupQuestions.filter((question) => needs.includes(question.key));
}

function activeSetupQuestions() {
  return setupQuestionsForNeeds(state.setupNeeds);
}

function setupNeedsFromFacts(sourceState = state) {
  return [
    ...(!codeAccountConnectionReady(sourceState) ? ["permission"] : []),
    ...(!registryConnectionReady(sourceState) ? ["version-storage"] : []),
    ...(!serverConnectionReady(sourceState.environmentBindings.staging.serverConnectionId, sourceState) ? ["destination"] : []),
    ...(missingRequiredConfigKeys("staging", sourceState).length ? ["config"] : []),
  ];
}

const productionSetupQuestions = [
  {
    key: "production-destination",
    title: "选择正式版运行的位置",
    summary: "测试位置不会自动当成正式位置；可以复用，也可以另外选择。",
    body: () => {
      const recommendedId = state.environmentBindings.staging.serverConnectionId;
      const recommended = state.serverConnections[recommendedId];
      const alternatives = verifiedServerEntries(state, recommendedId);
      return `
        <p class="drawer-lead">运行位置是可复用资源，不属于某个环境。正式版只建立新的环境绑定，并使用独立目录、配置和服务。</p>
        <div class="choice-list">
          ${serverConnectionReady(recommendedId) ? `<button class="choice-card ${state.productionSelectedRuntime === "recommended" ? "selected" : ""}" type="button" aria-pressed="${state.productionSelectedRuntime === "recommended"}" data-action="select-recommended-runtime">
            <span class="radio"></span><span class="choice-copy"><strong>${escapeHtml(recommended.label)}</strong><span>${escapeHtml(recommended.host)} · 测试环境已验证</span></span><span class="status-badge green">推荐复用</span>
          </button>` : ""}
          ${state.productionSelectedRuntime === "alternative"
            ? alternatives.map(([id, connection]) => `<button class="choice-card ${state.productionServerConnectionId === id ? "selected" : ""}" type="button" aria-pressed="${state.productionServerConnectionId === id}" data-action="select-production-server" data-server-id="${escapeHtml(id)}"><span class="radio"></span><span class="choice-copy"><strong>${escapeHtml(connection.label)}</strong><span>${escapeHtml(connection.host)} · ${connection.capability === "compatible" ? "可以直接复用" : "已经完成准备"}</span></span></button>`).join("")
            : ""}
          ${state.productionSelectedRuntime === "alternative" && !alternatives.length ? '<div class="empty-inline">还没有其他已验证的运行位置</div>' : ""}
        </div>
        <div class="button-row">
          <button class="text-button inline-action" type="button" data-action="show-alternative-server">${state.productionSelectedRuntime === "alternative" ? "返回推荐位置" : "选择其他运行位置"}</button>
          ${state.productionSelectedRuntime === "alternative" ? '<button class="secondary-button" type="button" data-action="add-production-server">添加新的运行位置</button>' : ""}
        </div>
        ${fieldError("productionServerConnectionId")}
        <details class="technical-details"><summary>查看隔离方式</summary><p>服务器连接只验证身份、Docker/Compose 与共享访问能力；环境绑定再决定项目目录、配置和路由。任何新服务器都必须完成同一套准备。</p></details>
      `;
    },
  },
  {
    key: "production-config",
    title: "确认正式版使用的配置",
    summary: "从配置中心匹配正式值，只补充仍然缺少的必填项。",
    body: () => {
      const providerLabel = configProfileLabelForKey("production", "PROVIDER_API_KEY");
      const adminLabel = configProfileLabelForKey("production", "ADMIN_PASSWORD");
      return `
      <p class="drawer-lead">以下是正式环境与测试环境不同的配置。保存后持续绑定，后续发布不再重复填写。</p>
      <div class="config-profile required-config">
        <div class="config-profile-head"><div><h3>第三方服务正式密钥</h3><p>PROVIDER_API_KEY · 必填</p></div>${providerLabel ? `<span class="config-actions"><span class="status-badge green">已绑定</span><button class="text-button" type="button" data-action="use-production-config">更换</button></span>` : `<button class="secondary-button" type="button" data-action="use-production-config">从配置中心选择</button>`}</div>
        <p>${providerLabel ? `来源：配置中心“${escapeHtml(providerLabel)}”，敏感值不会显示。` : "找到可复用的正式配置，选择后持续绑定。"}</p>
        ${fieldError("productionConfigBinding")}
      </div>
      <div class="config-profile required-config">
        <div class="config-profile-head"><div><h3>管理员正式密码</h3><p>ADMIN_PASSWORD · 必填</p></div><span class="status-badge ${adminLabel ? "green" : ""}">${adminLabel ? "已有值" : "待填写"}</span></div>
        <p>${adminLabel ? `来源：配置中心“${escapeHtml(adminLabel)}”。` : "填写后会安全保存到配置中心，并持续绑定当前项目的正式环境。"}</p>
        ${adminLabel ? "" : `<div class="form-field compact-field"><label for="production-admin-password">配置值</label><input id="production-admin-password" data-field="productionAdminPassword" type="password" value="${fieldValue("productionAdminPassword")}" ${fieldA11y("productionAdminPassword")} autocomplete="off" /><small>不会显示或写入项目目录。</small>${fieldError("productionAdminPassword")}</div>`}
      </div>
    `;
    },
  },
  {
    key: "production-address",
    title: "设置正式访问地址",
    summary: "先记录希望用户访问的地址，部署后再检查解析和 HTTPS。",
    body: () => `
      <p class="drawer-lead">请输入准备给正式用户使用的地址。系统不会因为地址尚未生效而重复部署服务。</p>
      <div class="form-field"><label for="production-domain">正式访问地址</label><input id="production-domain" data-field="productionDomain" value="${fieldValue("productionDomain")}" placeholder="例如 app.example.com" ${fieldA11y("productionDomain")} autocomplete="off" /><small>只填写域名，不要包含 https:// 或路径。部署完成后会从地址检查处继续。</small>${fieldError("productionDomain")}</div>
      <details class="technical-details"><summary>查看地址检查</summary><p>系统会分别记录服务是否已部署、域名是否解析以及 HTTPS 是否可用。</p></details>
    `,
  },
  {
    key: "production-impact",
    title: "确认这次正式发布",
    summary: "核对版本、影响范围和旧版本保护后再开始执行当前任务。",
    body: () => `
      <p class="drawer-lead">这是一个已经保存、但尚未执行的正式任务。确认后使用测试通过的同一版本开始执行，不重新生成。</p>
      <div class="review-list">
        <div class="review-row"><span>目标版本</span><strong>${productionVersionDisplayName()}</strong><span class="status-badge green">测试通过</span></div>
        <div class="review-row"><span>正式地址</span><strong>${fieldValue("productionDomain")}</strong><span class="status-badge">部署后检查</span></div>
        <div class="review-row"><span>运行位置</span><strong>${escapeHtml(state.serverConnections[state.environmentBindings.production.serverConnectionId]?.label ?? "尚未选择")} · ${escapeHtml(productionRuntimeAddress())}</strong><span class="status-badge green">已验证</span></div>
        <div class="review-row"><span>当前正式版</span><strong>${currentProductionVersionDisplayName() ?? "还没有正式版本"}</strong><span class="status-badge">${currentProductionVersionDisplayName() ? "发布前保持在线" : "首次发布"}</span></div>
      </div>
      <div class="helper-note"><span class="helper-symbol">i</span><span>服务启动成功后才继续地址检查；地址未生效不会重新生成或重新部署版本。</span></div>
    `,
  },
];

function defaultState() {
  return {
    schemaVersion: 7,
    scenario: "first",
    page: "release",
    sheet: null,
    projects: [
      { id: PROJECT_ID, name: "示例商城", path: "/Users/demo/Documents/shop-app", services: 3, serviceIds: ["api", "web", "ocr"], repositoryScope: "demo/shop" },
    ],
    currentProjectId: PROJECT_ID,
    projectWorkspacesById: {},
    sourceRevision: { ref: "main", commit: CURRENT_SOURCE_COMMIT },
    setupNeeds: ["permission", "version-storage", "destination", "config"],
    setupNeedReasons: { destination: "new" },
    questionIndex: 0,
    testOpened: false,
    versionsById: {},
    unresolvedLegacyVersionIds: [],
    versionValidations: {},
    hasHistory: false,
    recoveryTask: false,
    formValues: {
      publishToken: "",
      versionAccount: "",
      versionPassword: "",
      registryEndpoint: "",
      testHost: "",
      testUser: "",
      serverPassword: "",
      serverSshKey: "",
      adminPassword: "",
      productionAdminPassword: "",
      productionDomain: "",
      replacementToken: "",
      connectionToken: "",
      connectionRegistryEndpoint: "",
      connectionRegistryAccount: "",
      connectionHost: "",
      connectionUser: "",
      connectionServerSecret: "",
      newConfigLabel: "",
      newConfigKey: "",
      newConfigValue: "",
      editConfigLabel: "",
      editConfigKey: "",
      editConfigValue: "",
      addressDraftDomain: "",
    },
    formErrors: {},
    productionVersionId: null,
    productionIntent: "publish",
    currentProductionVersionId: null,
    productionAddressReady: false,
    addressCheckState: null,
    addressCheckPreviousState: null,
    addressLastCheckedAt: null,
    addressCheckTarget: null,
    productionServiceDeployed: false,
    productionQuestionIndex: 0,
    productionTask: null,
    productionComplete: false,
    lastCompletion: null,
    activeTaskId: null,
    taskStateConflictIds: [],
    nextTaskId: 42,
    tasksById: {},
    attemptsByTaskId: {},
    recoveryIssue: null,
    failureVariant: "authorization",
    codeConnectionStatus: "missing",
    codeConnection: null,
    sourceBinding: null,
    sourceEvidenceById: {},
    sourceProbeOutcome: "passed",
    sourceProbeLocalRepositoryScope: null,
    sourceProbeProviderRepositoryScope: null,
    replacementSourceProbeOutcome: "passed",
    sourceVerificationIssue: null,
    sourceVerificationReturnSheet: null,
    sourceVerificationResumeAction: null,
    credentialHelpTarget: null,
    credentialHelpReturnSheet: null,
    registryConnectionStatus: "missing",
    registryConnection: null,
    activeRegistryConnectionId: null,
    registryConnectionsById: {},
    registryEvidenceByRevision: {},
    serverConnectionStatus: "missing",
    stagingSelectedRuntime: "recommended",
    stagingServerConnectionId: "server-staging-shared",
    productionSelectedRuntime: "recommended",
    productionServerConnectionId: null,
    environmentBindings: {
      staging: { serverConnectionId: null, configProfileIds: [], appliedConfigRevisions: {}, address: null, desiredAddress: null },
      production: { serverConnectionId: null, configProfileIds: [], appliedConfigRevisions: {}, address: null, desiredAddress: null },
    },
    serverConnections: {
      "server-staging-shared": { label: "共享运行服务器", host: "203.0.113.10", verified: false, capability: null },
      "server-staging-alternative": { label: "独立运行服务器", host: "198.51.100.18", verified: false, capability: null },
      "server-production-main": { label: "生产运行服务器", host: "203.0.113.10", verified: false, capability: null },
      "server-production-alternative": { label: "备用运行服务器", host: "198.51.100.24", verified: false, capability: null },
      "server-existing-staging": { label: "已发现运行服务器", host: "203.0.113.10", verified: false, capability: null },
      "server-existing-production": { label: "已发现生产服务器", host: "203.0.113.10", verified: false, capability: null },
    },
    serverEvidenceByRevision: {},
    serverCapability: null,
    serverChangeConfirmed: false,
    serverImpactPreviewed: false,
    serverAuthMethod: "password",
    serverFingerprintConfirmed: false,
    configProfiles: [
      { id: "config-staging-provider", label: "测试环境通用密钥", key: "PROVIDER_API_KEY", valueReady: true, revision: 1, environmentScope: "staging" },
      { id: "config-production-provider", label: "正式环境通用密钥", key: "PROVIDER_API_KEY", valueReady: true, revision: 1, environmentScope: "production" },
      { id: "config-production-admin", label: "商城正式管理员密码", key: "ADMIN_PASSWORD", valueReady: true, revision: 1, environmentScope: "production" },
    ],
    connectionEditTarget: "code",
    connectionServerScope: "staging",
    connectionServerStep: "credentials",
    connectionDraftServerId: null,
    connectionReturnSheet: null,
    existingAdoptStep: "discover",
    existingDiscoverySnapshotId: null,
    discoverySnapshotsById: {},
    productionActiveDomain: null,
    localServices: { api: true, web: true, ocr: true },
    localDependencies: { database: true, cache: true },
    configTarget: null,
    configEditProfileId: null,
    configEditProjectId: null,
    configEditEnvironment: null,
    pendingConfigApplication: null,
    lastConfigApplication: null,
    automationRule: {
      id: "automation-shop-main-staging",
      projectId: PROJECT_ID,
      desiredState: { status: "enabled", branch: "main", behavior: "build-and-deploy", targetEnvironment: "staging", revision: 1 },
      observedState: { status: "missing", branch: null, behavior: null, targetEnvironment: null, observedAt: null },
      providerRef: null,
      syncState: { status: "pending", desiredRevision: 1, lastSyncedAt: null, lastError: null },
    },
    resetNotice: false,
    existingManaged: false,
    returnFocusAction: null,
  };
}

function projectDeepLinkFromLocation(location = window.location, projects = [{ id: PROJECT_ID }]) {
  try {
    const url = new URL(location.href);
    const projectId = url.searchParams.get("project");
    const page = url.searchParams.get("page");
    return projects.some((project) => project.id === projectId) && PROJECT_PAGES.has(page) ? { projectId, page } : null;
  } catch {
    return null;
  }
}

function clearProjectDeepLink() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("project") && !url.searchParams.has("page")) return;
    url.searchParams.delete("project");
    url.searchParams.delete("page");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // file:// and the JSDOM snapshot runner may not expose mutable history.
  }
}

function normalizedConfigProfiles(profiles) {
  return (profiles ?? []).map((profile) => {
    const { bindings: _legacyBindings, ...normalized } = profile;
    return normalized;
  });
}

function normalizedVersionValidations(validations) {
  return Object.fromEntries(Object.entries(validations ?? {}).map(([versionId, evidence]) => [versionId, {
    versionId: evidence.versionId ?? versionId,
    outcome: evidence.outcome ?? "pending",
    environment: evidence.environment ?? "staging",
    configRevision: evidence.configRevision ?? null,
    serviceRevision: evidence.serviceRevision ?? null,
    deploymentRevision: evidence.deploymentRevision ?? null,
    serverConnectionId: evidence.serverConnectionId ?? null,
    serverConnectionRevision: evidence.serverConnectionRevision ?? null,
    address: evidence.address ?? null,
    healthCheck: evidence.healthCheck ?? null,
    checkedAt: evidence.checkedAt ?? null,
  }]));
}

function legacyVersionId(value) {
  if (!value) return null;
  if (VERSION_FIXTURES[value]) return value;
  return Object.entries(VERSION_FIXTURES).find(([, fixture]) => fixture.displayName === value)?.[0] ?? null;
}

function migrateVersionAuthority(projectSource, tasksById, attemptsByTaskId, projectId) {
  const versionsById = {};
  const rejectedVersionIds = [];
  for (const [id, version] of Object.entries(projectSource.versionsById ?? {})) {
    const normalizedVersion = {
      ...version,
      id,
      artifactRefs: canonicalArtifactRefs(version.artifactRefs),
    };
    if (normalizedVersion.projectId !== projectId
      || !artifactRefsMatchProjectServices(normalizedVersion.artifactRefs, projectId, projectSource)) {
      rejectedVersionIds.push(id);
      continue;
    }
    versionsById[id] = normalizedVersion;
  }
  const migratedAttemptsByTaskId = cloneStateValue(attemptsByTaskId) ?? {};
  for (const [versionId, legacyEvidence] of Object.entries(projectSource.versionValidations ?? {})) {
    if (versionsById[versionId]) continue;
    const task = legacyEvidence.sourceTaskId
      ? tasksById[legacyEvidence.sourceTaskId]
      : Object.values(tasksById).find((candidate) => candidate.resultVersionId === versionId);
    if (!task || task.projectId !== projectId || task.status !== "completed" || task.resultVersionId !== versionId) continue;
    const attempts = migratedAttemptsByTaskId[task.id] ?? [];
    const attemptIndex = attempts.findIndex((candidate) => candidate.id === legacyEvidence.sourceAttemptId)
      >= 0
      ? attempts.findIndex((candidate) => candidate.id === legacyEvidence.sourceAttemptId)
      : attempts.findIndex((candidate) => candidate.status === "succeeded" && candidate.outputSnapshot?.versionId === versionId);
    if (attemptIndex < 0) continue;
    let attempt = attempts[attemptIndex];
    if (!attempt.outputSnapshot?.versionId && Array.isArray(legacyEvidence.artifactRefs)) {
      attempt = {
        ...attempt,
        outputSnapshot: { versionId, artifactRefs: canonicalArtifactRefs(legacyEvidence.artifactRefs) },
      };
      migratedAttemptsByTaskId[task.id] = attempts.map((candidate, index) => index === attemptIndex ? attempt : candidate);
    }
    const version = versionFromSucceededAttempt({
      versionId,
      displayName: legacyEvidence.displayName ?? VERSION_FIXTURES[versionId]?.displayName ?? task.target ?? versionId,
      task,
      attempt,
      origin: legacyEvidence.origin ?? "legacy-migration",
      sourceDiscoverySnapshotId: legacyEvidence.sourceDiscoverySnapshotId ?? null,
      sourceState: projectSource,
    });
    if (version) versionsById[versionId] = version;
  }
  return { versionsById, attemptsByTaskId: migratedAttemptsByTaskId, rejectedVersionIds };
}

function restoreState() {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    const defaults = defaultState();
    const projects = (parsed.projects ?? defaults.projects).map((project) => ({
      ...project,
      repositoryScope: String(project.repositoryScope ?? "").trim() || null,
      serviceIds: project.serviceIds
        ?? (project.services === 3 ? ["api", "web", "ocr"] : project.services === 2 ? ["api", "web"] : ["app"]),
    }));
    const deepLink = projectDeepLinkFromLocation(window.location, projects);
    const requestedProjectId = deepLink?.projectId ?? (projects.some((project) => project.id === parsed.currentProjectId) ? parsed.currentProjectId : projects[0]?.id ?? PROJECT_ID);
    const projectWorkspacesById = Object.fromEntries(Object.entries(parsed.projectWorkspacesById ?? {}).map(([projectId, workspace]) => {
      const normalizedWorkspace = { ...workspace };
      delete normalizedWorkspace.configProfiles;
      return [projectId, normalizedWorkspace];
    }));
    if (requestedProjectId !== parsed.currentProjectId && parsed.currentProjectId) {
      projectWorkspacesById[parsed.currentProjectId] = projectWorkspaceSnapshot({ ...defaults, ...parsed });
    }
    const projectWorkspace = requestedProjectId !== parsed.currentProjectId
      ? projectWorkspacesById[requestedProjectId] ?? null
      : null;
    const projectSource = projectWorkspace ? { ...parsed, ...projectWorkspace } : parsed;
    const legacyTask = projectSource.activeTask ?? null;
    const tasksById = projectSource.tasksById ?? (legacyTask ? {
      [legacyTask.id]: taskRecord({
        id: legacyTask.id,
        kind: legacyTask.kind,
        status: legacyTask.status,
        target: legacyTask.target,
        intent: legacyTask.intent,
        projectId: requestedProjectId,
      }),
    } : {});
    let attemptsByTaskId = projectSource.attemptsByTaskId ?? (legacyTask?.attempt
      ? {
          [legacyTask.id]: [attemptRecord(legacyTask.id, legacyTask.attempt, {
            status: legacyTask.status === "completed" ? "succeeded" : legacyTask.status === "waiting" ? "blocked" : "running",
            stage: legacyTask.status === "waiting" ? "read-result" : "deploy-services",
          })],
        }
      : {});
    const normalizedTasks = Object.fromEntries(Object.entries(tasksById).map(([id, task]) => {
      if (task.kind !== "test" || validFullCommit(task.goalSnapshot?.sourceCommit)) return [id, task];
      const historicalCommit = (attemptsByTaskId[id] ?? [])
        .map((attempt) => attempt.inputSnapshot?.sourceCommit)
        .find(validFullCommit);
      return [id, historicalCommit
        ? { ...task, goalSnapshot: { ...task.goalSnapshot, sourceCommit: historicalCommit } }
        : { ...task, status: "invalid-source", sourceSnapshotMissing: true }];
    }));
    const versionAuthority = migrateVersionAuthority(projectSource, normalizedTasks, attemptsByTaskId, requestedProjectId);
    attemptsByTaskId = versionAuthority.attemptsByTaskId;
    const unresolvedLegacyVersionIds = new Set([
      ...(projectSource.unresolvedLegacyVersionIds ?? []),
      ...versionAuthority.rejectedVersionIds,
      ...(projectSource.availableVersionIds ?? []).filter((versionId) => !versionAuthority.versionsById[versionId]),
    ]);
    const requestedProductionVersionId = projectSource.productionVersionId ?? legacyVersionId(projectSource.productionVersion);
    const requestedCurrentProductionVersionId = projectSource.currentProductionVersionId ?? legacyVersionId(projectSource.currentProductionVersion);
    if (requestedProductionVersionId && !versionAuthority.versionsById[requestedProductionVersionId]) unresolvedLegacyVersionIds.add(requestedProductionVersionId);
    if (requestedCurrentProductionVersionId && !versionAuthority.versionsById[requestedCurrentProductionVersionId]) unresolvedLegacyVersionIds.add(requestedCurrentProductionVersionId);
    const codeConnection = normalizedCodeConnection(parsed.codeConnection ?? projectSource.codeConnection);
    const requestedActiveTaskId = projectSource.activeTaskId ?? legacyTask?.id ?? null;
    const openTaskIds = Object.values(normalizedTasks)
      .filter((task) => task.projectId === requestedProjectId && !["completed", "canceled", "invalid-source"].includes(task.status))
      .map((task) => task.id);
    const restoredActiveTaskId = openTaskIds.length === 1
      ? openTaskIds[0]
      : openTaskIds.includes(requestedActiveTaskId) && openTaskIds.length === 1
        ? requestedActiveTaskId
        : null;
    const restored = {
      ...defaults,
      ...projectSource,
      schemaVersion: 7,
      page: deepLink?.page ?? "release",
      currentProjectId: requestedProjectId,
      projects,
      projectWorkspacesById,
      sourceRevision: { ...defaults.sourceRevision, ...projectSource.sourceRevision },
      setupNeedReasons: { ...defaults.setupNeedReasons, ...projectSource.setupNeedReasons },
      formValues: { ...defaults.formValues, ...projectSource.formValues },
      environmentBindings: {
        staging: { ...defaults.environmentBindings.staging, ...projectSource.environmentBindings?.staging },
        production: { ...defaults.environmentBindings.production, ...projectSource.environmentBindings?.production },
      },
      serverConnections: { ...defaults.serverConnections, ...parsed.serverConnections },
      serverEvidenceByRevision: parsed.serverEvidenceByRevision ?? projectSource.serverEvidenceByRevision ?? {},
      codeConnectionStatus: parsed.codeConnectionStatus ?? projectSource.codeConnectionStatus,
      codeConnection,
      sourceEvidenceById: projectSource.sourceEvidenceById ?? {},
      sourceBinding: projectWorkspace?.sourceBinding
        ?? (requestedProjectId === parsed.currentProjectId ? projectSource.sourceBinding : null),
      registryConnectionStatus: parsed.registryConnectionStatus ?? projectSource.registryConnectionStatus,
      registryConnection: parsed.registryConnection ?? projectSource.registryConnection,
      activeRegistryConnectionId: parsed.activeRegistryConnectionId ?? projectSource.activeRegistryConnectionId,
      registryConnectionsById: parsed.registryConnectionsById ?? projectSource.registryConnectionsById,
      registryEvidenceByRevision: parsed.registryEvidenceByRevision ?? projectSource.registryEvidenceByRevision ?? {},
      localServices: { ...defaults.localServices, ...projectSource.localServices },
      localDependencies: { ...defaults.localDependencies, ...projectSource.localDependencies },
      formErrors: {},
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      credentialHelpTarget: null,
      credentialHelpReturnSheet: null,
      versionValidations: normalizedVersionValidations(projectSource.versionValidations),
      versionsById: versionAuthority.versionsById,
      unresolvedLegacyVersionIds: [...unresolvedLegacyVersionIds],
      productionVersionId: versionAuthority.versionsById[requestedProductionVersionId] ? requestedProductionVersionId : null,
      currentProductionVersionId: versionAuthority.versionsById[requestedCurrentProductionVersionId] ? requestedCurrentProductionVersionId : null,
      configProfiles: normalizedConfigProfiles(parsed.configProfiles ?? defaults.configProfiles),
      activeTaskId: restoredActiveTaskId,
      taskStateConflictIds: openTaskIds.length > 1 ? openTaskIds : [],
      tasksById: normalizedTasks,
      attemptsByTaskId,
      automationRule: {
        ...defaults.automationRule,
        ...projectSource.automationRule,
        desiredState: { ...defaults.automationRule.desiredState, ...projectSource.automationRule?.desiredState },
        observedState: { ...defaults.automationRule.observedState, ...projectSource.automationRule?.observedState },
        syncState: { ...defaults.automationRule.syncState, ...projectSource.automationRule?.syncState },
      },
      sheet: null,
      returnFocusAction: null,
    };
    restored.sourceBinding = normalizedSourceBinding(restored.sourceBinding, restored);
    return restored;
  } catch {
    return null;
  }
}

function redactedFormValues(values) {
  return {
    ...values,
    publishToken: "",
    versionPassword: "",
    serverPassword: "",
    serverSshKey: "",
    adminPassword: "",
    productionAdminPassword: "",
    replacementToken: "",
    connectionToken: "",
    connectionServerSecret: "",
    newConfigValue: "",
    editConfigValue: "",
    addressDraftDomain: "",
  };
}

function persistState() {
  try {
    const formValues = redactedFormValues(state.formValues);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, page: "release", formValues, sheet: null, returnFocusAction: null, formErrors: {} }));
  } catch {
    // file:// JSDOM tests use an opaque origin; persistence is exercised in browser QA.
  }
}

let state = restoreState() ?? defaultState();
let toastTimer;
let lastRenderedDialogKey = null;
let lastRenderedPage = state.page;
let lastRenderedScenario = state.scenario;
const app = document.querySelector("#app");

function cloneStateValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function projectWorkspaceSnapshot(sourceState) {
  const workspace = {};
  for (const [key, value] of Object.entries(sourceState)) {
    if (!PROJECT_WORKSPACE_EXCLUDED_KEYS.has(key)) workspace[key] = cloneStateValue(value);
  }
  workspace.formValues = redactedFormValues(sourceState.formValues);
  return workspace;
}

function sharedResourcePatch(sourceState) {
  return {
    configProfiles: cloneStateValue(sourceState.configProfiles),
    serverConnections: cloneStateValue(sourceState.serverConnections),
    serverEvidenceByRevision: cloneStateValue(sourceState.serverEvidenceByRevision),
    codeConnectionStatus: sourceState.codeConnectionStatus,
    codeConnection: cloneStateValue(normalizedCodeConnection(sourceState.codeConnection)),
    registryConnectionStatus: sourceState.registryConnectionStatus,
    registryConnection: cloneStateValue(sourceState.registryConnection),
    activeRegistryConnectionId: sourceState.activeRegistryConnectionId,
    registryConnectionsById: cloneStateValue(sourceState.registryConnectionsById),
    registryEvidenceByRevision: cloneStateValue(sourceState.registryEvidenceByRevision),
  };
}

function freshProjectState(projectId, sourceState = state) {
  const fresh = defaultState();
  const shared = sharedResourcePatch(sourceState);
  Object.assign(fresh, shared);
  const verifiedServers = Object.entries(fresh.serverConnections).filter(([id]) => serverConnectionReady(id, fresh));
  fresh.currentProjectId = projectId;
  fresh.sourceBinding = null;
  fresh.automationRule = {
    ...fresh.automationRule,
    id: `automation-${projectId}-main-staging`,
    projectId,
  };
  fresh.setupNeeds = [
    ...(codeAccountConnectionReady(fresh) ? [] : ["permission"]),
    ...(registryConnectionReady(fresh) ? [] : ["version-storage"]),
    ...(verifiedServers.length === 1 ? [] : ["destination"]),
    "config",
  ];
  if (verifiedServers.length === 1) {
    fresh.serverConnectionStatus = "ready";
    fresh.stagingServerConnectionId = verifiedServers[0][0];
    fresh.environmentBindings.staging.serverConnectionId = verifiedServers[0][0];
  } else if (verifiedServers.length > 1) {
    fresh.serverConnectionStatus = "ready";
    fresh.setupNeedReasons.destination = "multiple";
    fresh.stagingServerConnectionId = verifiedServers[0][0];
  }
  return fresh;
}

function stateForProject(projectId, projects = state.projects) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return null;
  if (projectId === state.currentProjectId) {
    return {
      ...state,
      projects,
      page: "release",
      sheet: null,
      returnFocusAction: null,
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      formErrors: {},
    };
  }
  const projectWorkspacesById = {
    ...state.projectWorkspacesById,
    [state.currentProjectId]: projectWorkspaceSnapshot(state),
  };
  const workspace = projectWorkspacesById[projectId];
  const projectState = workspace
    ? { ...defaultState(), ...cloneStateValue(workspace) }
    : freshProjectState(projectId, state);
  const nextState = {
    ...projectState,
    ...sharedResourcePatch(state),
    projects,
    currentProjectId: projectId,
    projectWorkspacesById,
    page: "release",
    sheet: null,
    returnFocusAction: null,
    sourceVerificationReturnSheet: null,
    sourceVerificationResumeAction: null,
    formErrors: {},
  };
  nextState.sourceBinding = normalizedSourceBinding(nextState.sourceBinding, nextState);
  if (!workspace) nextState.setupNeeds = setupNeedsFromFacts(nextState);
  return nextState;
}

function activeTask(sourceState = state) {
  const pointed = sourceState.activeTaskId == null ? null : sourceState.tasksById?.[sourceState.activeTaskId] ?? null;
  if (pointed && !["completed", "canceled", "invalid-source"].includes(pointed.status)) return pointed;
  const openTasks = openMutationTasks(sourceState);
  return openTasks.length === 1 ? openTasks[0] : null;
}

function openMutationTasks(sourceState = state) {
  return Object.values(sourceState.tasksById ?? {}).filter((task) => task.projectId === sourceState.currentProjectId
    && ["test", "production", "config"].includes(task.kind)
    && !["completed", "canceled", "invalid-source"].includes(task.status));
}

function openMutationTask(sourceState = state) {
  const tasks = openMutationTasks(sourceState);
  if (tasks.length === 1) return tasks[0];
  if (tasks.length > 1) {
    return {
      id: null,
      kind: "conflict",
      projectId: sourceState.currentProjectId,
      environment: null,
      status: "needs_action",
      conflictTaskIds: tasks.map((task) => task.id),
    };
  }
  return null;
}

function taskAttempts(taskId, sourceState = state) {
  return sourceState.attemptsByTaskId?.[taskId] ?? [];
}

function latestAttempt(taskId, sourceState = state) {
  return taskAttempts(taskId, sourceState).at(-1) ?? null;
}

function runningAttemptForTask(task, sourceState = state) {
  const attempts = task ? taskAttempts(task.id, sourceState) : [];
  const attempt = attempts.at(-1) ?? null;
  return attempt
    && task.status === "running"
    && attempt.status === "running"
    && attempt.taskId === task.id
    && attempt.sequence === attempts.length
    && attempt.id === `attempt-${task.id}-${attempt.sequence}`
    ? attempt
    : null;
}

function taskPatch(task, patch) {
  return { ...state.tasksById, [task.id]: { ...task, ...patch } };
}

function attemptsPatch(taskId, attempts) {
  return { ...state.attemptsByTaskId, [taskId]: attempts };
}

function seedActiveTask(targetState, task, attempts = []) {
  targetState.activeTaskId = task.id;
  targetState.tasksById[task.id] = task;
  targetState.attemptsByTaskId[task.id] = attempts;
}

function activateTaskPatch(task, attempts = [], sourceState = state) {
  return {
    activeTaskId: task.id,
    tasksById: { ...sourceState.tasksById, [task.id]: task },
    attemptsByTaskId: { ...sourceState.attemptsByTaskId, [task.id]: attempts },
  };
}

function stagingSetupTaskPatch(sourceState = state) {
  if (!sourceBindingReady(sourceState)) return null;
  const current = openMutationTask(sourceState);
  if (current) {
    if (current.kind !== "test"
      || current.projectId !== sourceState.currentProjectId
      || current.environment !== "staging"
      || !["waiting-input", "waiting", "needs_action"].includes(current.status)) return null;
    return { task: current, patch: {} };
  }
  const task = createStagingTask({ id: 31, status: "waiting-input", target: "第一个测试版" }, sourceState);
  if (!task) return null;
  return { task, patch: activateTaskPatch(task, [], sourceState) };
}

function startNextAttemptPatch(task, overrides = {}, sourceState = state) {
  const expectedEnvironment = task.kind === "production" ? "production" : task.kind === "test" ? "staging" : null;
  const expectedResult = task.kind === "production" ? "production-release" : task.kind === "test" ? "staging-version" : null;
  const existingAttempts = sourceState.attemptsByTaskId[task.id] ?? [];
  const slotOwner = openMutationTask(sourceState);
  if (!expectedEnvironment
    || (slotOwner && slotOwner.id !== task.id)
    || task.projectId !== sourceState.currentProjectId
    || task.environment !== expectedEnvironment
    || task.goalSnapshot?.environment !== expectedEnvironment
    || task.goalSnapshot?.expectedResult !== expectedResult
    || !["waiting-input", "waiting", "needs_action", "running"].includes(task.status)
    || (task.status === "running" && existingAttempts.length > 0)) {
    throw new Error("任务身份、目标环境或当前状态不允许开始新的执行");
  }
  if (task.kind === "test" && !validFullCommit(task.goalSnapshot?.sourceCommit)) {
    throw new Error("测试任务缺少创建时固定的完整代码提交，不能开始执行");
  }
  if (task.kind === "test" && (!sourceBindingReady(sourceState) || setupNeedsFromFacts(sourceState).length)) {
    throw new Error("测试任务的代码、版本仓库、运行位置或配置尚未形成可验证事实，不能开始执行");
  }
  if (task.kind === "test" && !registryConnectionReady(sourceState)) {
    throw new Error("测试任务的版本仓库连接没有完整验证证据，不能开始执行");
  }
  const targetVersion = task.kind === "production"
    ? versionRecord(task.goalSnapshot?.targetVersionId, sourceState)
    : null;
  if (task.kind === "production" && (!targetVersion || targetVersion.projectId !== task.projectId)) {
    throw new Error("正式任务引用的版本不存在或不属于当前项目，不能开始执行");
  }
  if (task.kind === "production" && !isVersionQualified(task.goalSnapshot?.targetVersionId, sourceState)) {
    throw new Error("正式任务引用的版本已不再满足测试验证条件，不能开始执行");
  }
  if (task.kind === "production" && !productionExecutionReady(task, sourceState)) {
    throw new Error("正式任务的运行位置、必填配置或访问地址尚未准备好，不能开始执行");
  }
  const attempts = existingAttempts;
  const binding = sourceState.environmentBindings[task.environment] ?? {};
  const registry = sourceState.registryConnection;
  const server = sourceState.serverConnections[binding.serverConnectionId];
  const serviceIds = task.kind === "production"
    ? canonicalArtifactRefs(targetVersion.artifactRefs).map((artifact) => artifact.serviceId)
    : [...(projectRecord(sourceState).serviceIds ?? [])].sort();
  const attempt = attemptRecord(task.id, attempts.length + 1, {
    stage: typeof overrides.stage === "string" ? overrides.stage : "deploy-services",
    inputSnapshot: {
      targetVersionId: task.goalSnapshot.targetVersionId,
      artifactRefs: canonicalArtifactRefs(targetVersion?.artifactRefs),
      sourceCommit: task.kind === "test" ? task.goalSnapshot.sourceCommit : null,
      ...(task.kind === "test"
        ? sourceBindingAttemptInput(sourceState)
        : { codeConnectionRevision: null, sourceBindingId: null, repositoryScope: null }),
      registryConnectionRevision: task.kind === "production"
        ? targetVersion.artifactRefs[0]?.registryConnectionRevision ?? null
        : registryConnectionRevision(registry),
      registryConnectionId: task.kind === "production"
        ? targetVersion.artifactRefs[0]?.registryConnectionId ?? null
        : registry?.id ?? null,
      serverConnectionId: binding.serverConnectionId ?? null,
      serverConnectionRevision: serverConnectionReady(binding.serverConnectionId, sourceState) ? `${binding.serverConnectionId}@${server.revision ?? 1}` : null,
      configProfileIds: [...(binding.configProfileIds ?? [])],
      configProfileRevisions: desiredConfigRevisions(task.environment, sourceState),
      configRevision: configRevision(task.environment, sourceState),
      activeAddress: binding.address ?? null,
      desiredAddress: binding.desiredAddress ?? null,
      address: task.kind === "test"
        ? stagingAddress(sourceState)
        : binding.desiredAddress ?? binding.address ?? null,
      projectServiceIds: serviceIds,
      serviceRevision: "service-2",
      deploymentRevision: "deploy-v4",
    },
  });
  return {
    activeTaskId: task.id,
    tasksById: { ...sourceState.tasksById, [task.id]: { ...task, status: "running" } },
    attemptsByTaskId: { ...sourceState.attemptsByTaskId, [task.id]: [...attempts, attempt] },
  };
}

function resumeProductionRecoveryPatch(task, sourceState = state, stage = "prepare-server") {
  if (!task
    || task.kind !== "production"
    || !productionExecutionReady(task, sourceState)) return null;
  const sequence = (sourceState.attemptsByTaskId[task.id] ?? []).length + 1;
  return {
    page: "release",
    sheet: null,
    returnFocusAction: null,
    scenario: "update",
    recoveryIssue: null,
    productionVersionId: task.goalSnapshot.targetVersionId,
    productionIntent: task.intent,
    productionTask: {
      id: task.id,
      attemptId: `attempt-${task.id}-${sequence}`,
      target: task.target,
      targetVersionId: task.goalSnapshot.targetVersionId,
      intent: task.intent,
    },
    ...startNextAttemptPatch(task, { stage }, sourceState),
  };
}

function completeActiveTaskPatch(task, taskStatus = "completed", attemptStatus = "succeeded", taskResult = {}, attemptStage = "completed") {
  const attempts = taskAttempts(task.id);
  const completedAttempts = attempts.length
    ? attempts.map((attempt, index) => index === attempts.length - 1
      ? { ...attempt, status: attemptStatus, stage: attemptStage, endedAt: "刚刚" }
      : attempt)
    : attempts;
  return {
    activeTaskId: null,
    tasksById: taskPatch(task, { status: taskStatus, ...taskResult }),
    attemptsByTaskId: attemptsPatch(task.id, completedAttempts),
  };
}

function scenarioDefaults(scenario, failureVariant = "authorization") {
  const next = defaultState();
  next.scenario = scenario;
  next.failureVariant = failureVariant;
  const connectCode = (status = "ready", revision = 1) => {
    Object.assign(next, verifiedCodeAndCurrentSourcePatch(next, status, revision));
  };
  const verifyServer = (id, capability = "compatible") => {
    const connection = { ...next.serverConnections[id], verified: true, capability, revision: 1, fingerprint: "SHA256:fixture-server", verifiedAt: "刚刚" };
    next.serverConnections[id] = connection;
    next.serverEvidenceByRevision = serverEvidenceLedgerWith(id, connection, next);
  };
  const connectRegistry = () => {
    next.registryConnectionStatus = "ready";
    next.registryConnection = {
      id: "registry-team",
      endpoint: "ccr.ccs.tencentyun.com/team",
      pushEndpoint: "ccr.ccs.tencentyun.com/team",
      pullEndpoint: "ccr.ccs.tencentyun.com/team",
      accountLabel: "团队版本账号",
      verifiedAt: "刚刚",
      revision: 1,
      readable: true,
    };
    next.activeRegistryConnectionId = next.registryConnection.id;
    next.registryConnectionsById[next.registryConnection.id] = { ...next.registryConnection };
    next.registryEvidenceByRevision = registryEvidenceLedgerWith(next.registryConnection, next);
  };
  const enableAutomation = () => {
    next.automationRule = syncedAutomationRule(next, "enabled");
  };
  const bindStagingAdmin = () => {
    const id = "config-staging-admin";
    next.configProfiles.push({ id, label: "管理员初始密码", key: "ADMIN_PASSWORD", valueReady: true, revision: 1, environmentScope: "staging" });
    next.environmentBindings.staging.configProfileIds = [...new Set([...next.environmentBindings.staging.configProfileIds, id])];
  };
  const seedCompletedTestVersion = (taskId, versionId, outcome, evidenceOverrides = {}) => {
    const fixture = VERSION_FIXTURES[versionId];
    if (!fixture) throw new Error(`缺少版本原型数据：${versionId}`);
    const sourceState = { ...next, sourceRevision: { ref: "main", commit: fixture.sourceCommit } };
    const task = {
      ...createStagingTask({ id: taskId, status: "completed", target: `${fixture.displayName}代码` }, sourceState),
      resultVersionId: versionId,
    };
    const artifactRefs = fixtureArtifactRefs(versionId, next);
    const succeededAttempt = attemptRecord(task.id, 1, {
      status: "succeeded",
      stage: "completed",
      inputSnapshot: {
        sourceCommit: task.goalSnapshot.sourceCommit,
        ...sourceBindingAttemptInput(next),
        registryConnectionId: next.registryConnection?.id ?? null,
        registryConnectionRevision: registryConnectionRevision(next.registryConnection),
        serverConnectionId: next.environmentBindings.staging.serverConnectionId,
        serverConnectionRevision: `${next.environmentBindings.staging.serverConnectionId}@1`,
        configProfileIds: [...next.environmentBindings.staging.configProfileIds],
        configProfileRevisions: desiredConfigRevisions("staging", next),
        configRevision: configRevision("staging", next),
        activeAddress: next.environmentBindings.staging.address,
        desiredAddress: next.environmentBindings.staging.desiredAddress ?? null,
        address: next.environmentBindings.staging.address,
        projectServiceIds: [...(projectRecord(next).serviceIds ?? [])].sort(),
        serviceRevision: evidenceOverrides.serviceRevision ?? "service-2",
        deploymentRevision: evidenceOverrides.deploymentRevision ?? "deploy-v4",
      },
      endedAt: "已完成",
    });
    const attempt = {
      ...succeededAttempt,
      outputSnapshot: {
        versionId,
        artifactRefs: canonicalArtifactRefs(artifactRefs),
        environmentSnapshot: succeededEnvironmentSnapshot(succeededAttempt, {
          address: next.environmentBindings.staging.address,
          healthCheck: evidenceOverrides.healthCheck ?? "passed",
        }),
      },
    };
    next.tasksById[task.id] = task;
    next.attemptsByTaskId[task.id] = [attempt];
    const version = versionFromSucceededAttempt({ versionId, displayName: fixture.displayName, task, attempt, sourceState: next });
    if (!version) throw new Error(`无法建立版本权威记录：${versionId}`);
    next.versionsById[versionId] = version;
    next.versionValidations[versionId] = stagingValidationEvidence(versionId, outcome, next, {
      checkedAt: evidenceOverrides.checkedAt ?? null,
    });
  };
  if (scenario === "needs") {
    next.setupNeeds = ["config"];
    connectCode();
    connectRegistry();
    next.serverConnectionStatus = "ready";
    next.environmentBindings.staging.serverConnectionId = "server-staging-shared";
    verifyServer("server-staging-shared");
  }
  if (scenario === "choice") {
    next.setupNeeds = ["destination"];
    next.setupNeedReasons.destination = "multiple";
    connectCode();
    connectRegistry();
    next.serverConnectionStatus = "ready";
    next.environmentBindings.staging.configProfileIds = ["config-staging-provider"];
    bindStagingAdmin();
    verifyServer("server-staging-shared");
    verifyServer("server-staging-alternative");
  }
  if (scenario === "reused") {
    next.setupNeeds = [];
    connectCode();
    connectRegistry();
    next.serverConnectionStatus = "ready";
    next.environmentBindings.staging = { serverConnectionId: "server-staging-shared", configProfileIds: ["config-staging-provider"], address: "https://shop-test.example.net" };
    bindStagingAdmin();
    verifyServer("server-staging-shared");
    enableAutomation();
    const task = createStagingTask({ id: 31, status: "running", target: CURRENT_TEST_VERSION }, next);
    seedActiveTask(next, task);
    Object.assign(next, startNextAttemptPatch(task, {}, next));
  }
  if (["deploying", "available", "update", "failure"].includes(scenario)) {
    next.setupNeeds = [];
    connectCode();
    connectRegistry();
    next.serverConnectionStatus = "ready";
    next.environmentBindings.staging = { serverConnectionId: "server-staging-shared", configProfileIds: ["config-staging-provider"], address: "https://shop-test.example.net" };
    bindStagingAdmin();
    verifyServer("server-staging-shared");
    enableAutomation();
  }
  if (["available", "update", "failure"].includes(scenario)) {
    next.environmentBindings.staging.appliedConfigRevisions = desiredConfigRevisions("staging", next);
  }
  if (scenario === "deploying") {
    const task = createStagingTask({ id: 31, status: "running", target: CURRENT_TEST_VERSION }, next);
    seedActiveTask(next, task);
    Object.assign(next, startNextAttemptPatch(task, {}, next));
  }
  if (["available", "update"].includes(scenario)) {
    seedCompletedTestVersion(30, CURRENT_TEST_VERSION_ID, "pending");
  }
  if (["update", "failure"].includes(scenario)) {
    next.productionAddressReady = true;
    next.currentProductionVersionId = EXISTING_PRODUCTION_VERSION_ID;
    next.hasHistory = true;
    next.formValues.productionDomain = "shop.example.com";
    seedCompletedTestVersion(29, HISTORY_VERSION_ID, "passed", { serviceRevision: "service-1", checkedAt: "7 月 17 日 10:48" });
    seedCompletedTestVersion(28, EXISTING_PRODUCTION_VERSION_ID, "passed", { serviceRevision: "service-1", checkedAt: "7 月 15 日 18:32" });
    next.environmentBindings.production = {
      serverConnectionId: "server-production-main",
      configProfileIds: ["config-production-provider", "config-production-admin"],
      appliedConfigRevisions: { "config-production-provider": 1, "config-production-admin": 1 },
      address: "https://shop.example.com",
    };
    next.productionActiveDomain = "shop.example.com";
    verifyServer("server-production-main");
  }
  if (scenario === "failure") {
    if (failureVariant === "authorization") {
      const task = createStagingTask({ id: 24, status: "waiting", target: "7 月 18 日代码更新" }, next);
      const frozenInput = startNextAttemptPatch(task, {}, next).attemptsByTaskId[task.id][0].inputSnapshot;
      connectCode("invalid", next.codeConnection.revision);
      seedActiveTask(next, task, [
        attemptRecord(task.id, 1, { status: "failed", stage: "trigger-build", errorCode: "AD-CNB-102", endedAt: "19:08", inputSnapshot: cloneStateValue(frozenInput) }),
        attemptRecord(task.id, 2, { status: "blocked", stage: "read-result", errorCode: "AD-CNB-103", endedAt: "19:13", inputSnapshot: cloneStateValue(frozenInput) }),
      ]);
      next.recoveryIssue = { type: "authorization", environment: "staging", code: "AD-CNB-103" };
    } else {
      seedCompletedTestVersion(30, CURRENT_TEST_VERSION_ID, "passed", { checkedAt: "7 月 18 日 19:18" });
      const task = createProductionTask({ id: 42, versionId: CURRENT_TEST_VERSION_ID, status: "waiting" }, next);
      next.productionVersionId = CURRENT_TEST_VERSION_ID;
      next.productionIntent = "publish";
      next.productionAddressReady = true;
      const baseInput = {
        targetVersionId: CURRENT_TEST_VERSION_ID,
        artifactRefs: canonicalArtifactRefs(next.versionsById[CURRENT_TEST_VERSION_ID].artifactRefs),
        registryConnectionId: next.versionsById[CURRENT_TEST_VERSION_ID].artifactRefs[0]?.registryConnectionId,
        registryConnectionRevision: next.versionsById[CURRENT_TEST_VERSION_ID].artifactRefs[0]?.registryConnectionRevision,
        serverConnectionId: next.environmentBindings.production.serverConnectionId,
        serverConnectionRevision: `${next.environmentBindings.production.serverConnectionId}@1`,
        configProfileIds: [...next.environmentBindings.production.configProfileIds],
        configProfileRevisions: desiredConfigRevisions("production", next),
        configRevision: configRevision("production", next),
        activeAddress: next.environmentBindings.production.address,
        desiredAddress: next.environmentBindings.production.desiredAddress ?? null,
        address: next.environmentBindings.production.address,
        projectServiceIds: canonicalArtifactRefs(next.versionsById[CURRENT_TEST_VERSION_ID].artifactRefs).map((artifact) => artifact.serviceId),
      };
      if (failureVariant === "production-start") {
        seedActiveTask(next, task, [attemptRecord(task.id, 1, { status: "failed", stage: "health-check", errorCode: "AD-DEPLOY-301", endedAt: "19:13", inputSnapshot: baseInput })]);
        next.recoveryIssue = { type: "production-start", environment: "production", code: "AD-DEPLOY-301" };
      }
      if (failureVariant === "config-missing") {
        next.configProfiles[1].revision = 2;
        next.environmentBindings.production.configProfileIds = next.environmentBindings.production.configProfileIds.filter((id) => id !== "config-production-provider");
        seedActiveTask(next, task, [attemptRecord(task.id, 1, {
          status: "blocked",
          stage: "validate-config",
          errorCode: "AD-CONFIG-201",
          endedAt: "19:13",
          inputSnapshot: {
            ...baseInput,
            configProfileIds: [...next.environmentBindings.production.configProfileIds],
            configProfileRevisions: desiredConfigRevisions("production", next),
            configRevision: configRevision("production", next),
          },
        })]);
        next.recoveryIssue = { type: "config-missing", environment: "production", code: "AD-CONFIG-201", missingKeys: ["PROVIDER_API_KEY"] };
      }
      if (failureVariant === "server-unreachable") {
        next.serverConnections["server-production-main"].verified = false;
        seedActiveTask(next, task, [attemptRecord(task.id, 1, { status: "failed", stage: "connect-server", errorCode: "AD-SRV-101", endedAt: "19:13", inputSnapshot: { ...baseInput, serverConnectionRevision: null } })]);
        next.recoveryIssue = { type: "server-unreachable", environment: "production", code: "AD-SRV-101", serverConnectionId: "server-production-main" };
      }
      if (failureVariant === "route-conflict") {
        next.environmentBindings.production.desiredAddress = "https://new-shop.example.com";
        next.formValues.productionDomain = "new-shop.example.com";
        seedActiveTask(next, task, [attemptRecord(task.id, 1, { status: "blocked", stage: "activate-route", errorCode: "AD-SRV-206", endedAt: "19:13", inputSnapshot: { ...baseInput, address: "https://new-shop.example.com" } })]);
        next.recoveryIssue = { type: "route-conflict", environment: "production", code: "AD-SRV-206", host: "new-shop.example.com", ownerType: "abcdeploy-project", ownerProjectId: "project-legacy-shop", owner: "ABCDeploy 项目：旧版商城", currentTarget: "legacy-web:8080" };
      }
    }
  }
  if (scenario === "existing") {
    next.setupNeeds = [];
    next.codeConnectionStatus = "missing";
  }
  if (scenario === "server") {
    next.setupNeeds = ["destination"];
    next.setupNeedReasons.destination = "server-capability";
    connectCode();
    connectRegistry();
    next.serverConnectionStatus = "checking";
    next.environmentBindings.staging.configProfileIds = ["config-staging-provider"];
    bindStagingAdmin();
    next.serverCapability = "clean";
    seedActiveTask(next, createStagingTask({ id: 31, status: "waiting-input", target: "第一个测试版" }, next));
  }
  return next;
}

function setState(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "page")) clearProjectDeepLink();
  state = { ...state, ...patch };
  persistState();
  render();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.querySelector(".prototype-shell")?.append(toast);
  toastTimer = window.setTimeout(() => {
    toast.remove();
  }, 1600);
}

function validationOutcome(versionId, sourceState = state) {
  return sourceState.versionValidations[versionId]?.outcome ?? "pending";
}

function isVersionQualified(versionId, sourceState = state) {
  const version = versionRecord(versionId, sourceState);
  const evidence = sourceState.versionValidations[versionId];
  const sourceTask = version ? sourceState.tasksById[version.sourceTaskId] : null;
  const sourceAttempt = version
    ? (sourceState.attemptsByTaskId[version.sourceTaskId] ?? []).find((attempt) => attempt.id === version.sourceAttemptId)
    : null;
  const artifactRefs = version?.artifactRefs ?? [];
  const artifactRefsResolvable = artifactRefsMatchProjectServices(artifactRefs, version?.projectId, sourceState)
    && artifactRefsResolveThroughKnownRegistry(artifactRefs, sourceState)
    && artifactRefsMatchAttemptRegistry(artifactRefs, sourceAttempt);
  return Boolean(
    version
      && version.projectId === sourceState.currentProjectId
      && validFullCommit(version.sourceCommit)
      && evidence?.versionId === versionId
      && evidence.outcome === "passed"
      && artifactRefsResolvable
      && sourceTask?.projectId === version.projectId
      && ["test", "import"].includes(sourceTask?.kind)
      && sourceTask.status === "completed"
      && sourceTask.resultVersionId === versionId
      && sourceTask.goalSnapshot?.sourceCommit === version.sourceCommit
      && sourceAttempt?.taskId === sourceTask.id
      && sourceAttempt.status === "succeeded"
      && sourceAttempt.inputSnapshot?.sourceCommit === version.sourceCommit
      && sourceAttemptIdentityIsConsistent(sourceAttempt, sourceTask, sourceState)
      && sourceAttempt.inputSnapshot.codeConnectionRevision === version.codeConnectionRevision
      && sourceAttempt.inputSnapshot.sourceBindingId === version.sourceBindingId
      && sourceAttempt.inputSnapshot.sourceBindingRevision === version.sourceBindingRevision
      && sourceAttempt.inputSnapshot.sourceBindingEvidenceId === version.sourceBindingEvidenceId
      && sourceAttempt.inputSnapshot.sourceBindingVerifiedConnectionRevision === version.sourceBindingVerifiedConnectionRevision
      && sourceAttempt.inputSnapshot.sourceBindingVerifiedAt === version.sourceBindingVerifiedAt
      && sourceAttempt.inputSnapshot.repositoryScope === version.repositoryScope
      && sourceAttempt.outputSnapshot?.versionId === versionId
      && artifactRefsEqual(sourceAttempt.outputSnapshot?.artifactRefs, version.artifactRefs)
      && validationMatchesAttemptEnvironment(evidence, sourceTask, sourceAttempt, sourceState)
      && evidence.checkedAt,
  );
}

function productionBusy() {
  const task = activeTask();
  return Boolean(
    state.productionTask
      || (state.productionServiceDeployed && !state.productionComplete)
      || (task?.kind === "production" && task.status !== "completed"),
  );
}

function productionBusyCopy() {
  const task = activeTask();
  if (task?.kind === "production" && task.status === "waiting-input") {
    return "正在准备正式发布，已经确认的内容会保留；";
  }
  if (state.productionTask || (task?.kind === "production" && task.status === "running")) {
    return state.productionIntent === "rollback" ? "正式版正在恢复；" : "正式版正在启动；";
  }
  return "服务已部署，正在完成地址；";
}

function productionTaskName() {
  return state.productionIntent === "rollback" ? "正式恢复任务" : "正式发布任务";
}

function productionTaskId() {
  return activeTask()?.id ?? state.productionTask?.id ?? "—";
}

function productionOperationName() {
  return state.productionIntent === "rollback" ? "正式恢复" : "正式发布";
}

function productionDomain() {
  return state.formValues.productionDomain.trim() || "尚未设置";
}

function activeProductionDomain() {
  return state.productionActiveDomain || null;
}

function productionRuntimeAddress() {
  const connectionId = state.environmentBindings.production.serverConnectionId;
  return state.serverConnections[connectionId]?.host ?? "尚未确认服务器地址";
}

function scenarioBar() {
  const scenarios = [
    ["first", "新项目"],
    ["needs", "只补缺项"],
    ["reused", "全部复用"],
    ["choice", "多个候选"],
    ["existing", "已有部署"],
    ["deploying", "正在生成"],
    ["available", "测试版可用"],
    ["update", "日常更新"],
    ["failure", "故障恢复"],
    ["server", "服务器识别"],
  ];
  const task = activeTask();
  const failureVariantControl = state.scenario === "failure"
    ? `<label class="prototype-variant"><span>恢复情况</span><select data-failure-variant aria-label="切换故障恢复情况">
        <option value="authorization" ${state.failureVariant === "authorization" ? "selected" : ""}>代码授权失效</option>
        <option value="production-start" ${state.failureVariant === "production-start" ? "selected" : ""}>正式版启动失败</option>
        <option value="config-missing" ${state.failureVariant === "config-missing" ? "selected" : ""}>正式配置缺失</option>
        <option value="server-unreachable" ${state.failureVariant === "server-unreachable" ? "selected" : ""}>服务器无法连接</option>
        <option value="route-conflict" ${state.failureVariant === "route-conflict" ? "selected" : ""}>正式地址冲突</option>
      </select></label>`
    : "";
  const simulationAction = state.productionTask
    ? `<button class="prototype-next" type="button" data-action="finish-production">原型：模拟发布完成</button>`
    : state.productionServiceDeployed && state.addressCheckState !== "offline"
      ? `<button class="prototype-next" type="button" data-action="simulate-address-offline">原型：模拟检查中断</button>`
    : task?.kind === "test" && task.status === "running"
      ? `<button class="prototype-next" type="button" data-action="finish-deployment">原型：模拟任务完成</button>`
      : "";
  return `
    <div class="prototype-bar" ${state.sheet ? 'inert aria-hidden="true"' : ""}>
      <div class="prototype-note"><strong>结果导向工作流</strong><span>假数据 · 验证首次成功、日常更新和恢复</span></div>
      <div class="prototype-controls">
        <div class="scenario-tabs" aria-label="切换原型场景">
          ${scenarios
            .map(
              ([value, label]) => `<button class="${state.scenario === value ? "active" : ""}" type="button" data-scenario="${value}" aria-pressed="${state.scenario === value}">${label}</button>`,
            )
            .join("")}
        </div>
        ${failureVariantControl}
        ${simulationAction}
      </div>
    </div>
  `;
}

function projectStatus() {
  const task = activeTask();
  const testVersionId = currentTestVersionId();
  if (state.productionTask) return state.productionIntent === "rollback" ? "正在恢复正式版" : "正在发布给正式用户";
  if (state.productionServiceDeployed && !state.productionComplete) return "正式版已部署，还差地址";
  if (task?.kind === "production" && task.status === "waiting-input") return "正式发布准备未完成";
  if (state.productionComplete) return state.productionIntent === "rollback" ? "正式版刚刚恢复" : "正式版刚刚更新";
  if (state.scenario === "first") return "还没有测试版";
  if (["needs", "choice"].includes(state.scenario)) return `还需要确认 ${activeSetupQuestions().length - state.questionIndex} 件事`;
  if (state.scenario === "reused") return "已有资源已复用，正在生成";
  if (state.scenario === "existing") return state.existingManaged ? "已有部署已接入" : "发现已有部署";
  if (state.scenario === "deploying") return "正在生成测试版";
  if (state.scenario === "available") {
    if (validationOutcome(testVersionId) === "issue") return "测试有问题，等待更新";
    return isVersionQualified(testVersionId) ? "测试通过，可以发布" : "测试版可以打开";
  }
  if (state.scenario === "failure") return "这次更新没有完成";
  if (state.scenario === "server") return "正在判断服务器能力";
  return isVersionQualified(testVersionId) ? "新版本测试通过" : "新版本等待确认";
}

function currentProject() {
  return state.projects.find((project) => project.id === state.currentProjectId) ?? state.projects[0];
}

function sidebar() {
  const project = currentProject();
  const navItems = [
    ["release", "发布中心"],
    ["local", "在本机运行"],
    ["versions", "版本"],
    ["settings", "项目设置"],
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">A</span>
        <span class="brand-copy"><strong>ABCDeploy</strong><span>小白部署</span></span>
      </div>
      <nav class="sidebar-section workspace-nav" aria-label="工作区导航">
        <span class="sidebar-label">工作区</span>
        <button class="nav-button" type="button" data-action="show-projects"><span class="nav-icon">▦</span><span>所有项目</span></button>
        <button class="nav-button" type="button" data-action="show-config-center"><span class="nav-icon">≡</span><span>配置中心</span></button>
        <button class="nav-button" type="button" data-action="show-connections"><span class="nav-icon">◇</span><span>连接与资源</span></button>
        <button class="nav-button" type="button" data-action="show-tasks"><span class="nav-icon">✓</span><span>任务</span></button>
      </nav>
      <div class="sidebar-section">
        <span class="sidebar-label">项目</span>
        <button class="project-button active" type="button" aria-current="page" data-action="open-project" data-project-id="${escapeHtml(project.id)}">
          <span class="nav-icon">${escapeHtml(project.name.slice(0, 1))}</span>
          <span class="project-copy"><strong>${escapeHtml(project.name)}</strong><span>${projectStatus()}</span></span>
        </button>
      </div>
      <nav class="project-nav" aria-label="项目导航">
        ${navItems
          .map(
            ([value, label]) => `<button class="${state.page === value ? "active" : ""}" type="button" data-page="${value}" ${state.page === value ? 'aria-current="page"' : ""}>${label}</button>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-status"><span class="dot green"></span>本机服务正常</div>
    </aside>
  `;
}

function topbar() {
  const project = currentProject();
  return `
    <header class="topbar">
      <div class="project-title"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.path)}</span></div>
      <span class="status-badge">已识别 ${project.services} 个项目服务</span>
    </header>
  `;
}

function shell(content) {
  return `
    <div class="prototype-shell ${state.sheet ? "drawer-open" : ""}">
      ${scenarioBar()}
      <div class="app-window" ${state.sheet ? 'inert aria-hidden="true"' : ""}>
        ${sidebar()}
        <section class="workspace">${topbar()}<main class="content-scroll">${content}</main></section>
      </div>
      ${state.sheet ? taskSheet() : ""}
    </div>
  `;
}

function pageHeading(eyebrow, title, detail, action = "") {
  return `
    <div class="page-heading">
      <div><div class="eyebrow">${eyebrow}</div><h1 tabindex="-1">${title}</h1><p>${detail}</p></div>
      ${action}
    </div>
  `;
}

function taskCard({ title, meta, badge, badgeClass = "amber", content, className = "" }) {
  return `
    <section class="hero-card ${className}">
      <div class="hero-header">
        <div><h2>${title}</h2><p>${meta}</p></div>
        <span class="status-badge ${badgeClass}">${badge}</span>
      </div>
      ${content}
    </section>
  `;
}

function firstReleaseView() {
  const project = currentProject();
  return `
    <div class="content release-center-view first-release-view">
      ${pageHeading("发布中心", "先生成一个可以打开的测试版", `ABCDeploy 已识别到 ${project.services} 个项目服务。先拿到测试地址，其他信息只在真正用到时再补。`)}
      ${state.resetNotice ? `<div class="action-panel warn reset-notice"><span class="action-copy"><strong>已经开始重新设置</strong><span>线上服务没有被停止或删除；接下来只补 ABCDeploy 还缺少的管理信息。</span></span></div>` : ""}
      ${taskCard({
        title: "这次会得到什么",
        meta: "一个可以从公网打开、以后会随代码更新的测试地址",
        badge: "不会影响正式用户",
        badgeClass: "green",
        content: `
          <div class="action-panel success">
            <span class="action-copy"><strong>系统会自动完成重复工作</strong><span>读取项目、生成可恢复版本、启动服务并检查访问地址。</span></span>
            <button class="primary-button" type="button" data-action="start-first-test">生成测试版</button>
          </div>
          <div class="helper-note"><span class="helper-symbol">i</span><span>只在需要授权、选择运行位置或补充项目配置时询问你。</span></div>
        `,
      })}
    </div>
  `;
}

function planRows() {
  return activeSetupQuestions()
    .map((question, index) => {
      const done = index < state.questionIndex;
      const current = index === state.questionIndex;
      return `
        <div class="check-row ${current ? "current-question" : ""}">
          <span class="check-icon ${done ? "done" : ""}">${done ? "✓" : index + 1}</span>
          <span class="check-copy"><strong>${question.title}</strong><span>${question.summary}</span></span>
          <span class="status-badge ${done ? "green" : current ? "amber" : ""}">${done ? "已完成" : current ? "现在处理" : "随后处理"}</span>
        </div>
      `;
    })
    .join("");
}

function needsInputView() {
  const questions = activeSetupQuestions();
  const remaining = questions.length - state.questionIndex;
  const current = questions[state.questionIndex] ?? questions.at(-1);
  return `
    <div class="content release-center-view">
      ${pageHeading("生成第一个测试版", `还需要你确认 ${remaining} 件事`, "完整计划已经列在下面。每次只处理一个问题，完成的内容会自动保留。")}
      ${taskCard({
        title: current.title,
        meta: current.summary,
        badge: `${state.questionIndex + 1}/${questions.length}`,
        content: `
          <div class="checklist">${planRows()}</div>
          <div class="card-footer">
            <p>正式服务器、正式配置和正式域名不会在这里出现。</p>
            <button class="primary-button" type="button" data-action="continue-setup">现在处理</button>
          </div>
        `,
      })}
    </div>
  `;
}

function reusedResourcesView() {
  return `
    <div class="content release-center-view">
      ${pageHeading("生成测试版", "所需信息已经自动复用", "代码更新连接、版本保存、测试运行位置和项目配置都已验证，因此没有问题需要你重复回答。")}
      ${taskCard({
        title: "正在生成测试版",
        meta: "任务 #31 · 目标和复用来源已经保存",
        badge: "自动进行",
        badgeClass: "green",
        content: `
          <div class="completed-list"><span>✓ 代码更新连接可用</span><span>✓ 版本保存位置可用</span><span>✓ 测试运行位置可用</span><span>✓ 必要配置已绑定</span></div>
          ${progressSteps()}
        `,
      })}
    </div>
  `;
}

function existingDeploymentView() {
  return `
    <div class="content release-center-view">
      ${pageHeading("已有部署", "发现这个项目以前配置过部署", "目前只读取了本机部署定义，还没有连接服务器或导入远程历史；先选择是否继续管理。")}
      ${state.resetNotice ? `<div class="action-panel warn reset-notice"><span class="action-copy"><strong>已经清除旧的本机管理关系</strong><span>线上服务、应用级连接和配置条目都没有被停止或删除；当前仍只展示本机发现的线索。</span></span></div>` : ""}
      ${taskCard({
        title: "本机发现两条部署线索",
        meta: "选择前不连接远程服务、不导入版本，也不会自动产生部署任务",
        badge: "等待你选择",
        content: `
          <div class="review-list">
            <div class="review-row"><span>测试环境</span><strong>发现本机部署定义</strong><span class="status-badge">尚未远程核对</span></div>
            <div class="review-row"><span>正式环境</span><strong>发现本机部署定义</strong><span class="status-badge">尚未远程核对</span></div>
            <div class="review-row"><span>自动更新</span><strong>尚未由 ABCDeploy 管理</strong><span class="status-badge amber">待接入</span></div>
          </div>
          <div class="card-footer"><button class="text-button" type="button" data-action="reset-existing-deployment">重新设置部署</button><button class="primary-button" type="button" data-action="adopt-existing-deployment">继续管理已有部署</button></div>
        `,
      })}
    </div>
  `;
}

function managedExistingView() {
  return `
    <div class="content release-center-view">
      ${pageHeading("已有部署", "现有测试版和正式版已经接入", "这次只建立了管理关系和自动更新连接，没有重新部署、停止或替换任何在线服务。")}
      ${taskCard({
        title: "现在可以从这里继续管理",
        meta: "检测到的版本和地址事实已经保留",
        badge: "接入完成",
        badgeClass: "green",
        content: `<div class="review-list"><div class="review-row"><span>测试环境</span><strong>${HISTORY_VERSION}</strong><span class="status-badge green">仍在线</span></div><div class="review-row"><span>正式环境</span><strong>${EXISTING_PRODUCTION_VERSION}</strong><span class="status-badge green">仍在线</span></div><div class="review-row"><span>自动更新</span><strong>已建立连接</strong><span class="status-badge green">等待下次代码更新</span></div></div><div class="card-footer"><button class="text-button" type="button" data-action="reset-existing-deployment">重新设置部署</button><button class="secondary-button" type="button" data-action="go-versions">查看已有版本</button></div>`,
      })}
      ${environmentCards()}
    </div>
  `;
}

function progressSteps() {
  const resumed = state.recoveryTask;
  const serviceCount = projectServiceDefinitions().length;
  return `
    <div class="activity-list progress-list" aria-label="测试版生成进度">
      <div class="activity-row"><span class="check-icon done">✓</span><span class="activity-copy"><strong>读取项目</strong><span>${resumed ? "任务 #24 的项目和目标已经保留" : "项目服务和运行信息已经确认"}</span></span><span class="status-badge green">完成</span></div>
      <div class="activity-row"><span class="check-icon done">✓</span><span class="activity-copy"><strong>生成可恢复版本</strong><span>以后可以选择这个版本发布或恢复</span></span><span class="status-badge green">完成</span></div>
      <div class="activity-row"><span class="check-icon current-progress">3</span><span class="activity-copy"><strong>启动项目服务</strong><span>正在测试运行位置启动 ${serviceCount} 个服务</span></span><span class="status-badge amber">进行中</span></div>
      <div class="activity-row"><span class="check-icon">4</span><span class="activity-copy"><strong>检查测试地址</strong><span>服务启动后自动检查</span></span><span class="status-badge">等待</span></div>
    </div>
  `;
}

function deployingView() {
  return `
    <div class="content release-center-view">
      ${pageHeading(state.recoveryTask ? "继续任务 #24" : "第一次上线", "正在生成测试版", "可以关闭客户端，云端任务会继续，完成结果会保留。")}
      ${taskCard({
        title: "当前进度",
        meta: "这里只显示能帮助你判断进度的结果；底层记录放在技术详情中。",
        badge: "自动进行",
        content: `${progressSteps()}<details class="technical-details"><summary>查看技术详情</summary><p>代码已经同步，正在等待服务健康检查。原始构建日志已脱敏。</p></details>`,
      })}
    </div>
  `;
}

function testDecisionPanel(compact = false) {
  if (validationOutcome(currentTestVersionId()) === "issue") {
    return `<div class="action-panel warn"><span class="action-copy"><strong>已记录这个版本还有问题</strong><span>正式版不会变化。修改代码后，新的测试版会自动出现。</span></span><button class="secondary-button" type="button" data-action="go-versions">查看版本记录</button></div>`;
  }
  if (!state.testOpened) {
    return `<div class="action-panel ${compact ? "warn" : "success"}"><span class="action-copy"><strong>${compact ? "系统检查已经通过" : "测试地址已经就绪"}</strong><span>先打开确认登录、数据和核心操作，再记录测试结论。</span></span><button class="primary-button" type="button" data-action="open-test-site">${compact ? "打开并确认" : "打开测试版"}</button></div>`;
  }
  return `<div class="action-panel ${compact ? "warn" : "success"}"><span class="action-copy"><strong>请记录这次测试结果</strong><span>“还有问题”会保留版本记录，但不会获得正式发布资格。</span></span><div class="button-row"><button class="secondary-button" type="button" data-action="mark-test-issue">还有问题</button><button class="primary-button" type="button" data-action="confirm-test-passed">确认可以使用</button></div></div>`;
}

function availableView() {
  const testVersionId = currentTestVersionId();
  const confirmed = isVersionQualified(testVersionId);
  const hasIssue = validationOutcome(testVersionId) === "issue";
  return `
    <div class="content release-center-view">
      ${pageHeading("第一次上线", confirmed ? "这个版本已经通过测试" : hasIssue ? "这个版本已记录为有问题" : "测试版可以打开了", confirmed ? "以后代码更新后，系统会自动生成新的测试版。" : hasIssue ? "正式版不会变化；修改代码后等待新的测试版。" : "系统已经确认服务启动，并能从公网访问；现在需要你看一下业务功能。")}
      ${taskCard({
        title: confirmed ? `${CURRENT_TEST_VERSION}可以发布` : hasIssue ? `${CURRENT_TEST_VERSION}等待修改` : "打开测试版，确认业务结果",
        meta: stagingAddress(),
        badge: confirmed ? "测试通过" : hasIssue ? "测试有问题" : "等待你确认",
        badgeClass: confirmed ? "green" : hasIssue ? "red" : "amber",
        content: confirmed
          ? `<div class="action-panel success"><span class="action-copy"><strong>测试结果已经记录</strong><span>正式版不会自动更新；需要发布时从版本中选择。</span></span><button class="primary-button" type="button" data-action="go-versions">查看可发布版本</button></div>`
          : testDecisionPanel(false),
      })}
      ${testOnlyEnvironmentCard()}
    </div>
  `;
}

function updateView() {
  const testVersionId = currentTestVersionId();
  const confirmed = isVersionQualified(testVersionId);
  const hasIssue = validationOutcome(testVersionId) === "issue";
  const addressCompletion = state.lastCompletion?.kind === "address"
    ? `<div class="action-panel success"><span class="action-copy"><strong>正式地址已经更新</strong><span>https://${escapeHtml(activeProductionDomain())} 可以访问；这次只更新了地址，没有创建发布任务。</span></span></div>`
    : "";
  return `
    <div class="content release-center-view">
      ${pageHeading("日常更新", confirmed ? "新版本已经通过测试" : hasIssue ? "这次测试有问题" : "有一个新版本等你确认", confirmed ? `${CURRENT_TEST_VERSION}现在可以独立发布给正式用户。` : hasIssue ? "正式版保持不变；下一次代码更新会生成新的测试版。" : "代码更新已自动生成并放到测试环境，当前正式版没有变化。")}
      ${addressCompletion}
      ${taskCard({
        title: confirmed ? "选择是否发布给正式用户" : hasIssue ? `${CURRENT_TEST_VERSION}已记录问题` : `确认 ${CURRENT_TEST_VERSION}`,
        meta: "修复登录问题 · 测试地址已经通过系统检查",
        badge: confirmed ? "可以发布" : hasIssue ? "测试有问题" : "等待业务确认",
        badgeClass: confirmed ? "green" : hasIssue ? "red" : "amber",
        content: confirmed
          ? `<div class="action-panel success"><span class="action-copy"><strong>正式版仍是 ${currentProductionVersionDisplayName()}</strong><span>发布会创建独立任务，不会重新生成这个版本。</span></span><button class="primary-button" type="button" data-action="publish-current">发布给正式用户</button></div>`
          : testDecisionPanel(true),
      })}
      ${environmentCards()}
    </div>
  `;
}

function recoveryIssuePresentation(issue = state.recoveryIssue) {
  const taskId = activeTask()?.id ?? 24;
  if (issue?.type === "authorization-resolved") return {
    eyebrow: `测试任务 #${taskId}`,
    title: "代码授权已经恢复",
    detail: "自动更新规则已经按你的操作完成；原测试任务仍停在原位置，等待你决定是否继续。",
    cardTitle: `可以继续任务 #${taskId}`,
    meta: "不会重复选择服务器、配置或目标版本",
    symptomTitle: "原任务尚未继续执行",
    symptomDetail: "授权和当前项目仓库都已核对。点击继续只会给原任务新增一次执行，不会创建另一条部署任务。",
    action: "resume-authorization-task",
    actionLabel: `继续任务 #${taskId}`,
    completed: ["新账号授权已验证", "当前项目仓库已核对", "自动更新规则操作已完成"],
    technical: "授权阻塞已解除；等待显式恢复原 Attempt · AD-CNB-103。",
  };
  if (issue?.type === "production-start") return {
    eyebrow: `正式发布任务 #${taskId}`,
    title: "新版本启动检查没有通过",
    detail: `${currentProductionVersionDisplayName()} 和 https://${activeProductionDomain()} 仍在正常服务。`,
    cardTitle: `${CURRENT_TEST_VERSION}没有替换当前正式版`,
    meta: "目标版本、产物、服务器和配置快照都已保留",
    symptomTitle: "目标服务没有在规定时间内通过健康检查",
    symptomDetail: "可以重新启动同一版本；不会重新生成镜像，也不会改变当前正式流量。",
    action: "retry-production-start",
    actionLabel: "重新启动并检查",
    completed: ["目标版本已经固定", "正式配置快照已保留", `${currentProductionVersionDisplayName()} 仍在线`],
    technical: "正式服务健康检查未通过 · AD-DEPLOY-301。",
  };
  if (issue?.type === "config-missing") return {
    eyebrow: `正式发布任务 #${taskId}`,
    title: "还缺一项正式环境配置",
    detail: `${currentProductionVersionDisplayName()} 仍在正常服务；目标版本尚未启动。`,
    cardTitle: "补齐 PROVIDER_API_KEY 后继续同一任务",
    meta: "不会重新选择版本、服务器或地址",
    symptomTitle: "正式环境缺少第三方服务密钥",
    symptomDetail: "直接从配置中心选择或新建；最后一个缺口补齐后自动继续任务。",
    action: "repair-task-config",
    actionLabel: "补齐正式配置",
    completed: ["目标版本已经固定", "运行服务器已经验证", `${currentProductionVersionDisplayName()} 仍在线`],
    technical: "必填配置 PROVIDER_API_KEY 未绑定 · AD-CONFIG-201。",
  };
  if (issue?.type === "server-unreachable") return {
    eyebrow: `正式发布任务 #${taskId}`,
    title: "无法安全连接正式运行位置",
    detail: `${currentProductionVersionDisplayName()} 仍在正常服务；目标版本尚未替换它。`,
    cardTitle: "重新验证这台服务器后继续",
    meta: "服务器身份和原任务目标都会保留",
    symptomTitle: `无法连接 ${escapeHtml(state.serverConnections[issue.serverConnectionId]?.host ?? "目标服务器")}`,
    symptomDetail: "重新验证同一运行位置或更换到已验证位置后，系统从原停点继续。",
    action: "repair-task-server",
    actionLabel: "处理运行位置",
    completed: ["目标版本已经固定", "正式配置已经保留", `${currentProductionVersionDisplayName()} 仍在线`],
    technical: "SSH 安全连接未建立 · AD-SRV-101。",
  };
  if (issue?.type === "route-conflict") return {
    eyebrow: `正式发布任务 #${taskId}`,
    title: "新地址已被服务器原有站点使用",
    detail: `旧地址 https://${activeProductionDomain()} 和 ${currentProductionVersionDisplayName()} 仍在线。`,
    cardTitle: `${escapeHtml(issue.host)} 暂未切换`,
    meta: "服务版本和旧地址都没有被回退或覆盖",
    symptomTitle: issue.ownerType === "abcdeploy-project" && issue.ownerProjectId
      ? "这个地址属于另一个 ABCDeploy 项目"
      : "这个地址已被现有站点使用，但归属无法确认",
    symptomDetail: issue.ownerType === "abcdeploy-project" && issue.ownerProjectId
      ? "系统已确认原路由归属；先查看影响和恢复方式，明确转移后才继续同一任务。"
      : "ABCDeploy 不会接管来源不明的路由。请更换正式地址，或让服务器维护人员先明确现有站点归属。",
    action: "review-route-conflict",
    actionLabel: "查看接管影响",
    completed: ["目标服务已经准备", "旧地址继续在线", "原有路由没有被修改"],
    technical: `地址当前转发到 ${escapeHtml(issue.currentTarget)} · AD-SRV-206。`,
  };
  return {
    eyebrow: `任务 #${taskId}`,
    title: "这次更新没有完成",
    detail: "测试环境仍在运行上一个可用版本；正式版也没有受到影响。",
    cardTitle: "需要重新允许 ABCDeploy 获取代码更新",
    meta: "版本、目标环境和已完成结果都已保留",
    symptomTitle: "执行结果未知，没有创建新版本",
    symptomDetail: `当前授权无法读取生成结果；测试环境仍运行上一个可用版本。保存新授权后会继续任务 #${taskId}，不会重新选择服务器、配置或版本。`,
    action: "open-recovery-task",
    actionLabel: "处理并继续",
    completed: ["项目代码已提交", "更新任务已创建", `${HISTORY_VERSION} 仍在线`],
    technical: "CNB 授权缺少读取构建结果的权限 · AD-CNB-103。",
  };
}

function failureView() {
  const copy = recoveryIssuePresentation();
  return `
    <div class="content release-center-view">
      ${pageHeading(copy.eyebrow, copy.title, copy.detail)}
      ${taskCard({
        title: copy.cardTitle,
        meta: copy.meta,
        badge: "等待你处理",
        content: `
          <div class="error-panel" role="alert">
            <div><h3>${copy.symptomTitle}</h3><p>${copy.symptomDetail}</p></div>
            <button class="primary-button" type="button" data-action="${copy.action}">${copy.actionLabel}</button>
          </div>
          <div class="completed-list">${copy.completed.map((item) => `<span>✓ ${item}</span>`).join("")}</div>
          <details class="technical-details"><summary>查看技术详情</summary><p>${copy.technical}</p></details>
        `,
      })}
      ${environmentCards()}
    </div>
  `;
}

function productionProgressSteps() {
  const rollback = state.productionIntent === "rollback";
  return `
    <div class="activity-list progress-list" aria-label="正式版${rollback ? "恢复" : "发布"}进度">
      <div class="activity-row"><span class="check-icon done">✓</span><span class="activity-copy"><strong>确认${rollback ? "恢复" : "发布"}版本</strong><span>${productionVersionDisplayName()}已经通过测试</span></span><span class="status-badge green">完成</span></div>
      <div class="activity-row"><span class="check-icon current-progress">2</span><span class="activity-copy"><strong>启动目标版本</strong><span>目标服务与当前正式版并行准备</span></span><span class="status-badge amber">进行中</span></div>
      <div class="activity-row"><span class="check-icon">3</span><span class="activity-copy"><strong>检查正式服务</strong><span>启动后自动检查，不通过时旧版本继续在线</span></span><span class="status-badge">等待</span></div>
      <div class="activity-row"><span class="check-icon">4</span><span class="activity-copy"><strong>完成正式访问</strong><span>服务部署与地址状态分别记录</span></span><span class="status-badge">等待</span></div>
    </div>
  `;
}

function productionTaskView() {
  const rollback = state.productionIntent === "rollback";
  return `
    <div class="content release-center-view">
      ${pageHeading(`${productionTaskName()} #${productionTaskId()}`, rollback ? "正在恢复正式版" : "正在发布给正式用户", "当前正式版会继续服务，直到目标版本启动并通过检查。")}
      ${taskCard({
        title: productionVersionDisplayName(),
        meta: "使用测试通过的同一版本，不重新生成",
        badge: "自动进行",
        content: productionProgressSteps(),
      })}
      ${environmentCards()}
    </div>
  `;
}

function productionPreparationView() {
  const remaining = Math.max(1, productionSetupQuestions.length - state.productionQuestionIndex);
  return `
    <div class="content release-center-view">
      ${pageHeading(`${productionTaskName()} #${productionTaskId()}`, `${productionOperationName()}还需要确认 ${remaining} 件事`, "已经完成的选择和填写内容都已保留，从原来的位置继续即可。")}
      ${taskCard({
        title: state.productionIntent === "rollback" && state.productionQuestionIndex === productionSetupQuestions.length - 1
          ? "确认这次正式恢复"
          : productionSetupQuestions[Math.min(state.productionQuestionIndex, productionSetupQuestions.length - 1)].title,
        meta: `目标版本：${productionVersionDisplayName()}`,
        badge: "等待你继续",
        content: `<div class="checklist">${productionPlanRows()}</div><div class="card-footer"><p>还没有对正式环境产生远程变更。</p><button class="text-button" type="button" data-action="cancel-production-preparation">放弃这次任务</button><button class="primary-button" type="button" data-action="resume-production-setup">继续准备${state.productionIntent === "rollback" ? "正式恢复" : "正式发布"}</button></div>`,
      })}
      ${environmentCards()}
    </div>
  `;
}

function addressPendingView() {
  const task = activeTask();
  const addressOnly = !task;
  const deployedVersion = productionVersionDisplayName() ?? currentProductionVersionDisplayName();
  const checkState = state.addressCheckState ?? "pending";
  const dnsRecord = dnsRecordFor(productionDomain(), productionRuntimeAddress());
  const oldAddressCopy = activeProductionDomain() && activeProductionDomain() !== productionDomain()
    ? `旧地址 https://${escapeHtml(activeProductionDomain())} 继续在线，直到新地址全部通过检查。`
    : "正式服务仍在运行，直到地址检查完成。";
  const statusCopy = checkState === "offline"
    ? `<strong>本次地址检查被网络中断</strong><span>${oldAddressCopy} 部署结果和解析记录都已保留；联网后从这里继续。</span>`
    : checkState === "propagating"
      ? `<strong>2/3 项已经生效，还在等待 HTTPS</strong><span>域名已经解析到服务器，证书仍在准备；稍后再次检查即可。</span>`
      : `<strong>请确认下面的解析记录已经添加</strong><span>完整域名 ${escapeHtml(dnsRecord.domain)} · 类型 ${dnsRecord.type} · 指向 ${escapeHtml(dnsRecord.value)}</span>`;
  const addressProgress = checkState === "propagating"
    ? `◐ ${escapeHtml(productionDomain())} 部分可用`
    : checkState === "offline"
      ? `! ${escapeHtml(productionDomain())} 检查中断${state.addressCheckPreviousState === "propagating" ? "（此前已部分生效）" : "（部署结果已保留）"}`
      : `○ ${escapeHtml(productionDomain())} 等待检查`;
  return `
    <div class="content release-center-view">
      ${pageHeading(addressOnly ? "正式地址设置" : `${productionTaskName()} #${productionTaskId()}`, addressOnly ? "正式服务仍在线，还差确认新地址" : state.productionIntent === "rollback" ? "恢复版本已经部署，还差访问地址" : "正式版已经部署，还差访问地址", `服务已经在正式运行位置启动；这里只继续检查地址，不重新生成或重新部署版本。${oldAddressCopy}`)}
      ${taskCard({
        title: "完成正式地址",
        meta: "部署结果已经保存，可以关闭客户端后再回来继续",
        badge: "还差地址",
        content: `
          <div class="action-panel warn"><span class="action-copy">${statusCopy}</span><div class="button-row"><button class="secondary-button" type="button" data-action="copy-dns-record">复制解析记录</button><button class="text-button" type="button" data-action="edit-production-address">修改地址</button><button class="primary-button" type="button" data-action="finish-address-check">${checkState === "pending" ? "检查地址" : "再次检查"}</button></div></div>
          <div class="completed-list"><span>✓ ${deployedVersion} 已部署</span><span>✓ 3 个正式服务正在运行</span><span>${addressProgress}</span><span>最近检查：${state.addressLastCheckedAt ?? "尚未检查"}</span></div>
          <details class="technical-details"><summary>查看检查详情</summary><p>系统会分别检查解析、HTTPS 和访问路由；失败不会触发重新生成或重启服务。</p></details>
        `,
      })}
      ${environmentCards()}
    </div>
  `;
}

function productionCompleteView() {
  const rollback = state.productionIntent === "rollback";
  return `
    <div class="content release-center-view">
      ${pageHeading(rollback ? "正式恢复完成" : "正式发布完成", rollback ? "正式版已经恢复" : "正式版已经更新", `${currentProductionVersionDisplayName()}正在为正式用户提供服务。`)}
      ${taskCard({
        title: "一切正常",
        meta: "没有必须处理的任务，等待下一次代码更新。",
        badge: "运行正常",
        badgeClass: "green",
        content: `<div class="action-panel success"><span class="action-copy"><strong>正式地址可以访问</strong><span>https://${escapeHtml(activeProductionDomain() ?? productionDomain())} · 最近检查：刚刚</span></span></div>`,
      })}
      ${environmentCards()}
    </div>
  `;
}

function testOnlyEnvironmentCard() {
  const outcome = validationOutcome(currentTestVersionId());
  const status = outcome === "passed" ? "测试通过" : outcome === "issue" ? "测试有问题" : "可以访问";
  const badgeClass = outcome === "passed" ? "green" : outcome === "issue" ? "red" : "amber";
  const lastAttempt = outcome === "passed" ? "业务确认通过，验证证据已保留" : outcome === "issue" ? "已记录业务问题，等待代码更新" : "生成成功，等待业务确认";
  return `
    <div class="section-heading"><h2>当前环境</h2><span>正式环境将在第一次发布时设置</span></div>
    <div class="environment-grid single-environment">
      <article class="environment-card">
        <div class="environment-top"><h3>测试版</h3><span class="status-badge ${badgeClass}">${status}</span></div>
        <div class="environment-version">${CURRENT_TEST_VERSION}</div>
        <div class="environment-meta"><span>期望：随代码更新保持最新</span><span>当前：测试地址可以访问</span><span>最近尝试：${lastAttempt}</span></div>
      </article>
    </div>
  `;
}

function environmentCards() {
  const task = activeTask();
  const testVersionId = currentTestVersionId();
  const authorizationRecovery = state.scenario === "failure" && state.recoveryIssue?.type === "authorization";
  let testTitle = CURRENT_TEST_VERSION;
  let testStatus = isVersionQualified(testVersionId) ? "测试通过" : validationOutcome(testVersionId) === "issue" ? "测试有问题" : "等待确认";
  let testDetail = "测试地址可以访问";
  let lastTestAttempt = isVersionQualified(testVersionId)
    ? "业务确认通过，验证证据已保留"
    : validationOutcome(testVersionId) === "issue"
      ? "已记录业务问题，等待代码更新"
      : "生成成功，等待业务确认";
  const testTaskRunning = task?.kind === "test" && task.status === "running";
  if (state.scenario === "existing") {
    testTitle = HISTORY_VERSION;
    testStatus = "运行正常";
    testDetail = "从现有部署读取，未重新部署";
    lastTestAttempt = "暂无 ABCDeploy 部署尝试";
  }
  if (authorizationRecovery) {
    testTitle = HISTORY_VERSION;
    testStatus = "仍在运行";
    testDetail = "7 月 18 日更新结果未知，未替换当前版本";
    lastTestAttempt = "任务 #24 无法读取生成结果";
  } else if (testTaskRunning) {
    testTitle = HISTORY_VERSION;
    testStatus = "仍在运行";
    testDetail = "新版本仍在生成，当前测试版未变化";
    lastTestAttempt = `任务 #${task.id} 正在执行`;
  }
  const testBadgeClass = authorizationRecovery || testTaskRunning
    ? "amber"
    : validationOutcome(testVersionId) === "issue"
      ? "red"
      : isVersionQualified(testVersionId)
        ? "green"
        : "amber";
  const productionTitle = currentProductionVersionDisplayName()
    ?? (state.productionServiceDeployed ? productionVersionDisplayName() : "还没有正式版本");
  const productionRecoveryAttempt = task?.kind === "production" && state.recoveryIssue
    ? ({
        "production-start": `任务 #${task.id} 启动检查未通过，旧版本未变`,
        "config-missing": `任务 #${task.id} 等待补齐正式配置`,
        "server-unreachable": `任务 #${task.id} 等待重新验证运行位置`,
        "route-conflict": `任务 #${task.id} 暂停在地址切换，原路由未变`,
      }[state.recoveryIssue.type] ?? `任务 #${task.id} 等待处理`)
    : null;
  const productionStatus = productionRecoveryAttempt
    ? "原版本仍在线"
    : state.productionTask
    ? state.currentProductionVersionId
      ? "原版本仍在线"
      : "首次发布中"
    : state.productionServiceDeployed && !state.productionComplete
      ? "服务已部署，地址待完成"
      : state.currentProductionVersionId
        ? "运行正常"
        : "尚未设置";
  return `
    <div class="section-heading"><h2>环境现状</h2><span>在线版本与最近一次尝试分别记录</span></div>
    <div class="environment-grid">
      <article class="environment-card">
        <div class="environment-top"><h3>测试版</h3><span class="status-badge ${testBadgeClass}">${testStatus}</span></div>
        <div class="environment-version">${testTitle}</div>
        <div class="environment-meta"><span>期望：随代码更新保持最新</span><span>当前：${testDetail}</span><span>最近尝试：${lastTestAttempt}</span><span>地址：${escapeHtml(stagingAddress())}</span></div>
      </article>
      <article class="environment-card">
        <div class="environment-top"><h3>正式版</h3><span class="status-badge ${state.productionServiceDeployed && !state.productionComplete ? "amber" : state.currentProductionVersionId ? "green" : ""}">${productionStatus}</span></div>
        <div class="environment-version">${productionTitle}</div>
        <div class="environment-meta"><span>期望：只使用人工确认的测试通过版本</span><span>当前：${productionTitle}</span><span>访问：${state.productionAddressReady && activeProductionDomain() ? `https://${escapeHtml(activeProductionDomain())} 可以访问` : state.productionServiceDeployed && activeProductionDomain() ? `旧地址 https://${escapeHtml(activeProductionDomain())} 仍在线，新地址待完成` : state.productionServiceDeployed ? "服务已部署，地址待完成" : "第一次发布时设置"}</span><span>最近尝试：${productionRecoveryAttempt ?? (state.productionTask ? "正式发布正在执行" : state.productionServiceDeployed ? "服务部署成功，地址未完成" : state.currentProductionVersionId ? "最近发布成功" : "暂无")}</span></div>
      </article>
    </div>
  `;
}

function releaseCenterView() {
  const task = activeTask();
  if (state.productionTask) return productionTaskView();
  if (state.productionServiceDeployed && !state.productionComplete) return addressPendingView();
  if (state.productionComplete) return productionCompleteView();
  if (task?.kind === "production" && task.status === "waiting-input") return productionPreparationView();
  if (state.scenario === "first") return firstReleaseView();
  if (["needs", "choice", "server"].includes(state.scenario)) return needsInputView();
  if (state.scenario === "reused") return reusedResourcesView();
  if (state.scenario === "existing") return state.existingManaged ? managedExistingView() : existingDeploymentView();
  if (state.scenario === "deploying") return deployingView();
  if (state.scenario === "available") return availableView();
  if (state.scenario === "failure") return failureView();
  return updateView();
}

function localView() {
  const services = projectServiceDefinitions();
  const dependencies = [
    ["database", "本地数据库"],
    ["cache", "缓存服务"],
  ];
  const runningServices = services.filter(([id]) => state.localServices[id]).length;
  const runningDependencies = dependencies.filter(([id]) => state.localDependencies[id]).length;
  const serviceRows = services.map(([id, label, address]) => {
    const running = state.localServices[id];
    return `<div class="activity-row"><span class="dot ${running ? "green" : ""}"></span><span class="activity-copy"><strong>${label}</strong><span>${running ? address : "当前未运行"}</span></span><span class="status-badge ${running ? "green" : ""}">${running ? "运行中" : "已停止"}</span><button class="secondary-button" type="button" data-action="local-service-toggle" data-local-service="${id}">${running ? "停止" : "启动"}</button></div>`;
  }).join("");
  const dependencyRows = dependencies.map(([id, label]) => {
    const running = state.localDependencies[id];
    return `<div class="activity-row"><span class="dot ${running ? "green" : ""}"></span><span class="activity-copy"><strong>${label}</strong><span>${running ? "已启动，可以连接" : "当前未运行"}</span></span><button class="secondary-button" type="button" data-action="local-dependency-toggle" data-local-dependency="${id}">${running ? "停止" : "启动"}</button></div>`;
  }).join("");
  return `
    <div class="content local-view">
      ${pageHeading("独立工具", "在本机运行", "快捷启停本机服务并维护必要配置；不参与远程发布门禁。")}
      <section class="hero-card">
        <div class="hero-header"><div><h2>项目服务</h2><p>${runningServices}/${services.length} 正在运行</p></div><div class="button-row"><button class="secondary-button" type="button" data-action="local-stop-all">全部停止</button><button class="primary-button" type="button" data-action="local-start-all">一键启动全部</button></div></div>
        <div class="activity-list">${serviceRows}</div>
      </section>
      <section class="section-card local-section">
        <div class="hero-header"><div><h2>运行依赖</h2><p>${runningDependencies}/2 正在运行。这里只负责快捷启停，不把本机开发问题变成上线门禁。</p></div><span class="status-badge ${runningDependencies === 2 ? "green" : "amber"}">${runningDependencies === 2 ? "运行正常" : "部分未运行"}</span></div>
        <div class="activity-list">${dependencyRows}</div>
      </section>
      <section class="section-card local-section">
        <div class="hero-header"><div><h2>必要配置</h2><p>优先显示项目要求但仍缺值的配置；当前必填项均已保存。</p></div><button class="secondary-button" type="button" data-action="show-config-center">打开配置中心</button></div>
        <div class="review-list">
          <div class="review-row"><span>应用运行模式</span><strong>NODE_ENV</strong><span class="status-badge green">已保存</span></div>
          <div class="review-row"><span>第三方服务访问密钥</span><strong>PROVIDER_API_KEY</strong><span class="status-badge green">已绑定</span></div>
        </div>
      </section>
    </div>
  `;
}

function versionRow({ versionId, detail, status, statusClass = "", action = "", actionLabel = "" }) {
  const version = versionRecord(versionId);
  if (!version) return "";
  const digestSummary = version.artifactRefs.map((artifact) => `${artifact.serviceId} ${artifact.digest}`).join(" · ");
  return `
    <div class="activity-row version-row">
      <span class="dot ${statusClass === "green" ? "green" : statusClass === "red" ? "red" : "amber"}"></span>
      <span class="activity-copy"><strong>${escapeHtml(version.displayName)}</strong><span>${detail}</span><details class="technical-details"><summary>查看版本详情</summary><span>修改摘要：${version.id === currentTestVersionId() ? "修复登录与启动检查" : version.id === HISTORY_VERSION_ID ? "上一个稳定测试版本" : "已发布版本"}</span><span>版本 ID：${escapeHtml(version.id)} · 代码 ${escapeHtml(version.sourceCommit.slice(0, 8))}</span><span>不可变产物：${escapeHtml(digestSummary)}</span></details></span>
      <span class="version-action"><span class="status-badge ${statusClass}">${status}</span>${action ? `<button class="text-button" type="button" data-action="${action}">${actionLabel}</button>` : ""}</span>
    </div>
  `;
}

function versionsView() {
  const testVersionId = currentTestVersionId();
  const hasVersions = (state.scenario !== "existing" || state.existingManaged)
    && (!["first", "needs", "choice", "server", "reused", "deploying"].includes(state.scenario) || state.recoveryTask);
  if (!hasVersions) {
    return `
      <div class="content versions-view">
        ${pageHeading("版本记录", "还没有生成版本", "第一个测试版产生后，这里会记录每次代码更新、测试结果和环境使用情况。")}
        <section class="hero-card empty-state"><h2>先生成第一个测试版</h2><p>版本记录会自动出现，不需要在这里手动创建。</p></section>
      </div>
    `;
  }
  const busy = productionBusy();
  const addressOnlyBusy = state.productionServiceDeployed && !state.productionComplete && !activeTask();
  const currentOutcome = validationOutcome(testVersionId);
  const currentQualified = isVersionQualified(testVersionId);
  const historyQualified = isVersionQualified(HISTORY_VERSION_ID);
  const task = activeTask();
  const testTaskRunning = task?.kind === "test" && task.status === "running";
  const currentStatus = testTaskRunning
    ? "生成中"
    : state.currentProductionVersionId === testVersionId
      ? "正式运行"
      : currentQualified
        ? "测试通过"
        : currentOutcome === "passed"
          ? "验证证据不完整"
        : currentOutcome === "issue"
          ? "测试有问题"
          : "等待确认";
  const currentStatusClass = currentStatus === "测试有问题" ? "red" : ["等待确认", "生成中", "验证证据不完整"].includes(currentStatus) ? "amber" : "green";
  const currentAction = !busy && currentQualified && state.currentProductionVersionId !== testVersionId ? "publish-current" : "";
  const historyAction = !busy && state.hasHistory && historyQualified && state.currentProductionVersionId !== HISTORY_VERSION_ID
    ? state.currentProductionVersionId ? "rollback-history" : "publish-history"
    : "";
  const historyActionLabel = historyAction === "rollback-history" ? "恢复正式版到这里" : "发布给正式用户";
  const productionRow = state.currentProductionVersionId && ![testVersionId, HISTORY_VERSION_ID].includes(state.currentProductionVersionId)
    ? versionRow({ versionId: state.currentProductionVersionId, detail: "当前正式版", status: "正式运行", statusClass: "green" })
    : "";
  const currentDetail = testTaskRunning
    ? `任务 #${task.id} 正在执行，尚未进入测试环境`
    : currentQualified
      ? "当前测试环境 · 使用测试配置修订 3 通过"
      : currentOutcome === "passed"
        ? "缺少版本摘要、环境或健康检查证据，暂不能发布"
      : currentOutcome === "issue"
        ? "已记录业务问题，等待新的代码更新"
        : "当前测试版 · 等待业务确认";
  const authorizationFailure = state.scenario === "failure" && state.recoveryIssue?.type === "authorization";
  const historyRow = state.hasHistory
    ? versionRow({
        versionId: HISTORY_VERSION_ID,
        detail: !historyQualified
          ? "历史记录仍保留，但验证证据不完整，暂不能发布"
          : authorizationFailure ? "当前测试版 · 上一个可用版本仍在线" : "历史测试通过版本 · 使用测试配置修订 2",
        status: state.currentProductionVersionId === HISTORY_VERSION_ID ? "正式运行" : !historyQualified ? "证据不完整" : authorizationFailure ? "当前测试版" : "测试通过",
        statusClass: !historyQualified ? "amber" : "green",
        action: historyAction,
        actionLabel: historyActionLabel,
      })
    : "";
  const olderIssueRow = "";
  const currentRow = state.scenario === "existing" || authorizationFailure
    ? ""
    : versionRow({ versionId: testVersionId, detail: currentDetail, status: currentStatus, statusClass: currentStatusClass, action: currentAction, actionLabel: "发布给正式用户" });
  const failureCopy = state.scenario === "failure" ? recoveryIssuePresentation() : null;
  const failureAttempt = failureCopy
    ? `<div class="action-panel warn"><span class="action-copy"><strong>${failureCopy.symptomTitle}</strong><span>${failureCopy.symptomDetail}</span></span><button class="secondary-button" type="button" data-action="${failureCopy.action}">${failureCopy.actionLabel}</button></div>`
    : "";
  return `
    <div class="content versions-view">
      ${pageHeading("独立记录", "版本", "代码更新自动产生版本；测试结果决定发布资格，正式发布是独立任务。")}
      <section class="hero-card">
        <div class="hero-header"><div><h2>版本记录</h2><p>默认显示时间、测试证据和环境使用情况，技术标识放在详情中。</p></div><span class="status-badge ${state.codeConnectionStatus === "ready" ? "green" : "amber"}">${state.codeConnectionStatus === "invalid" ? "自动更新需要处理" : state.codeConnectionStatus === "ready" ? "自动更新正常" : "尚未连接自动更新"}</span></div>
        ${busy ? `<div class="action-panel warn"><span class="action-copy"><strong>${addressOnlyBusy ? "正式地址尚未完成" : `${productionTaskName()} #${productionTaskId()} 还没有结束`}</strong><span>${addressOnlyBusy ? "正式服务仍在线，正在确认新的访问地址；" : productionBusyCopy()}结束前不能再创建另一个正式任务。</span></span><button class="secondary-button" type="button" data-action="go-release-center">${addressOnlyBusy ? "继续检查地址" : "查看当前任务"}</button></div>` : ""}
        ${failureAttempt}
        <div class="activity-list">
          ${currentRow}
          ${historyRow}
          ${productionRow}
          ${olderIssueRow}
        </div>
      </section>
    </div>
  `;
}

function resourceRow(label, value, status = "已连接", statusClass = "green") {
  return `<div class="review-row"><span>${label}</span><strong>${value}</strong><span class="status-badge ${statusClass}">${status}</span></div>`;
}

function settingsFacts() {
  const testRuntimeReady = serverConnectionReady(state.environmentBindings.staging.serverConnectionId);
  const productionRuntimeReady = serverConnectionReady(state.environmentBindings.production.serverConnectionId);
  const testConfigMissing = missingRequiredConfigKeys("staging");
  const productionConfigMissing = missingRequiredConfigKeys("production");
  const testConfigReady = testConfigMissing.length === 0;
  const productionConfigReady = productionConfigMissing.length === 0;
  const testAddressReady = Boolean(state.environmentBindings.staging.address);
  const productionAddressSet = Boolean(state.environmentBindings.production.desiredAddress || state.environmentBindings.production.address || state.formValues.productionDomain);
  return {
    source: state.codeConnectionStatus === "invalid"
      ? ["需要重新授权", "等待处理", "amber"]
      : state.codeConnectionStatus === "ready"
        ? ["代码更新连接", "已连接", "green"]
        : ["尚未连接", "等待设置", ""],
    storage: state.registryConnectionStatus === "ready" && state.registryConnection
      ? [state.registryConnection.endpoint, "已连接", "green"]
      : ["尚未连接", "等待设置", ""],
    testRuntime: testRuntimeReady
      ? ["测试运行位置", "已验证", "green"]
      : ["接入或设置后核对", "尚未绑定", ""],
    productionRuntime: productionRuntimeReady
      ? ["正式运行位置", "已验证", "green"]
      : ["首次正式发布时设置", "尚未需要", ""],
    testConfig: testConfigReady
      ? [`${state.environmentBindings.staging.configProfileIds.length} 项配置`, "完整", "green"]
      : [`还缺 ${testConfigMissing.length} 项必填配置`, "待补充", "amber"],
    productionConfig: productionConfigReady
      ? ["正式配置", "完整", "green"]
      : [`还缺 ${productionConfigMissing.length} 项必填配置`, "待补充", "amber"],
    testAddress: testAddressReady
      ? ["系统生成的测试地址", "可以访问", "green"]
      : ["生成测试版后自动提供", "尚未生成", ""],
    productionAddress: state.productionAddressReady && activeProductionDomain()
      ? [activeProductionDomain(), "可以访问", "green"]
      : activeProductionDomain() && state.environmentBindings.production.desiredAddress
        ? [`旧地址 https://${activeProductionDomain()} 继续在线；新地址 ${productionDomain()} 设置中`, "待完成", "amber"]
      : productionAddressSet
        ? [productionDomain(), state.productionServiceDeployed ? "等待生效" : "已设置", state.productionServiceDeployed ? "amber" : "green"]
        : ["首次正式发布时设置", "尚未需要", ""],
  };
}

function settingsView() {
  const facts = settingsFacts();
  const automationStatus = automationRuleStatus();
  const automationCopy = automationStatus === "enabled"
    ? ["main 更新后生成版本并更新测试版", "运行正常", "green"]
    : automationStatus === "paused"
      ? ["main 更新暂不触发测试部署", "已暂停", "amber"]
      : automationStatus === "needs-repair"
        ? ["期望状态与代码平台不一致", "需要处理", "amber"]
        : ["第一个测试版成功后自动建立", "等待建立", ""];
  return `
    <div class="content settings-view">
      ${pageHeading("低频维护", "项目设置", "这里维护项目长期使用的能力，不创建发布任务。技术提供方只在连接详情中出现。")}
      <div class="settings-grid">
        <section class="section-card resource-section">
          <div class="resource-heading"><div><h2>云端自动更新</h2><p>代码更新后自动生成版本并更新测试版。</p></div><button class="secondary-button" type="button" data-action="manage-automation">维护规则</button></div>
          <div class="review-list">${resourceRow("自动更新", ...automationCopy)}${resourceRow("更新来源", ...facts.source)}${resourceRow("版本保存", ...facts.storage)}</div>
          <details class="technical-details"><summary>查看连接来源</summary><p>首版更新来源：CNB；版本保存：腾讯云 TCR。可以在维护连接时更换。</p></details>
        </section>
        <section class="section-card resource-section">
          <div class="resource-heading"><div><h2>运行位置</h2><p>服务器准备只做一次，其他项目可以复用。</p></div><button class="secondary-button" type="button" data-action="show-connections">维护连接</button></div>
          <div class="review-list">${resourceRow("测试版", ...facts.testRuntime)}${resourceRow("正式版", ...facts.productionRuntime)}</div>
        </section>
        <section class="section-card resource-section">
          <div class="resource-heading"><div><h2>环境配置</h2><p>配置来自配置中心，环境保存持续绑定关系。</p></div><button class="secondary-button" type="button" data-action="show-config-center">打开配置中心</button></div>
          <div class="review-list">${resourceRow("测试版", ...facts.testConfig)}${resourceRow("正式版", ...facts.productionConfig)}</div>
        </section>
        <section class="section-card resource-section">
          <div class="resource-heading"><div><h2>访问地址</h2><p>测试地址由系统生成，正式地址由用户确认。</p></div><button class="secondary-button" type="button" data-action="edit-address">维护地址</button></div>
          <div class="review-list">${resourceRow("测试版", ...facts.testAddress)}${resourceRow("正式版", ...facts.productionAddress)}</div>
        </section>
      </div>
    </div>
  `;
}

function automationSheet() {
  const rule = state.automationRule;
  const status = automationRuleStatus(rule);
  const statusLabel = status === "enabled" ? "运行正常" : status === "paused" ? "已暂停" : status === "needs-repair" ? "同步失败" : "等待首次测试";
  const errorPanel = status === "needs-repair"
    ? `<div class="error-panel" role="alert"><div><h3>自动更新规则没有同步完成</h3><p>${escapeHtml(rule.syncState.lastError?.message ?? "代码平台上的实际规则与当前设置不一致")}。测试环境和历史版本没有变化。</p></div></div>`
    : "";
  const action = status === "enabled"
    ? '<button class="primary-button" type="button" data-action="pause-automation-rule">暂停自动更新</button>'
    : status === "paused"
      ? '<button class="primary-button" type="button" data-action="resume-automation-rule">恢复自动更新</button>'
      : status === "needs-repair"
        ? '<button class="primary-button" type="button" data-action="repair-automation-rule">修复并重新同步</button>'
        : '<button class="primary-button" type="button" data-action="close-sheet">知道了</button>';
  return {
    title: "云端自动更新",
    body: `
      <p class="drawer-lead">这是一条独立的自动化规则，不是部署任务。暂停或修复规则不会删除现有版本，也不会影响当前测试版。</p>
      ${errorPanel}
      <div class="review-list">
        <div class="review-row"><span>代码范围</span><strong>${escapeHtml(rule.desiredState.branch)} 分支</strong><span class="status-badge green">固定</span></div>
        <div class="review-row"><span>自动动作</span><strong>生成不可变版本并更新测试环境</strong><span class="status-badge">不发布正式版</span></div>
        <div class="review-row"><span>期望状态</span><strong>${rule.desiredState.status === "enabled" ? "开启" : "暂停"}</strong><span class="status-badge">修订 ${rule.desiredState.revision}</span></div>
        <div class="review-row"><span>实际状态</span><strong>${rule.observedState.status === "enabled" ? "开启" : rule.observedState.status === "paused" ? "暂停" : "尚未建立"}</strong><span class="status-badge ${status === "enabled" ? "green" : "amber"}">${statusLabel}</span></div>
      </div>
      <details class="technical-details"><summary>查看同步来源</summary><p>${rule.providerRef ? `${escapeHtml(rule.providerRef.provider)} · ${escapeHtml(rule.providerRef.connectionRevision)} · 最近核对 ${escapeHtml(rule.syncState.lastSyncedAt ?? "尚未成功")}` : "首次测试完成后使用当前代码平台连接建立规则。"}</p>${status === "enabled" ? '<button class="text-button" type="button" data-action="simulate-automation-failure">原型：模拟规则同步失败</button>' : ""}</details>
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">返回</button>${action}`,
  };
}

function setupSheet() {
  const questions = activeSetupQuestions();
  const question = questions[state.questionIndex];
  const actionLabels = {
    permission: "保存授权",
    "version-storage": "保存版本位置",
    destination: state.setupNeedReasons.destination === "new"
      ? "连接服务器"
      : state.setupNeedReasons.destination === "server-identity"
        ? "确认并检查服务器"
        : "使用这个运行位置",
    config: "保存配置并生成测试版",
  };
  return {
    title: question.title,
    body: `
      <div class="sheet-plan-summary">
        <strong>生成测试版前的完整计划</strong>
        <span>第 ${state.questionIndex + 1} 项，共 ${questions.length} 项</span>
      </div>
      <div class="compact-plan">${planRows()}</div>
      <div class="current-question-body">${question.body()}</div>
    `,
    footer: `<button class="primary-button" type="button" data-action="save-setup-question">${actionLabels[question.key]}</button>`,
  };
}

function productionPlanRows() {
  return productionSetupQuestions
    .map((question, index) => {
      const done = index < state.productionQuestionIndex;
      const current = index === state.productionQuestionIndex;
      const title = state.productionIntent === "rollback" && question.key === "production-impact" ? "确认这次正式恢复" : question.title;
      const summary = state.productionIntent === "rollback" && question.key === "production-impact" ? "核对目标版本、影响范围和当前正式版保护后再开始恢复。" : question.summary;
      return `<div class="check-row ${current ? "current-question" : ""}"><span class="check-icon ${done ? "done" : ""}">${done ? "✓" : index + 1}</span><span class="check-copy"><strong>${title}</strong><span>${summary}</span></span><span class="status-badge ${done ? "green" : current ? "amber" : ""}">${done ? "已完成" : current ? "现在处理" : "随后处理"}</span></div>`;
    })
    .join("");
}

function productionSetupSheet() {
  const question = productionSetupQuestions[state.productionQuestionIndex];
  const isLast = state.productionQuestionIndex === productionSetupQuestions.length - 1;
  const rollback = state.productionIntent === "rollback";
  const planName = rollback
    ? "正式恢复"
    : currentProductionVersionDisplayName() ? "正式发布" : "第一次正式发布";
  return {
    title: rollback && question.key === "production-impact" ? "确认这次正式恢复" : question.title,
    body: `
      <div class="sheet-plan-summary"><strong>${planName}的完整计划</strong><span>第 ${state.productionQuestionIndex + 1} 项，共 ${productionSetupQuestions.length} 项</span></div>
      <div class="compact-plan">${productionPlanRows()}</div>
      <div class="current-question-body">${question.body()}</div>
    `,
    footer: `<button class="text-button" type="button" data-action="cancel-production-preparation">放弃任务</button>${state.productionQuestionIndex > 0 ? '<button class="secondary-button" type="button" data-action="previous-production-question">返回上一步</button>' : ""}<button class="primary-button" type="button" data-action="save-production-question">${isLast ? `确认并开始${rollback ? "恢复" : "发布"}` : "保存并继续"}</button>`,
  };
}

function recoverySheet() {
  const task = activeTask();
  const issue = state.recoveryIssue;
  if (issue?.type === "route-conflict") {
    const transferable = issue.ownerType === "abcdeploy-project" && issue.ownerProjectId;
    return {
      title: transferable ? "确认是否转移这个正式地址" : "这个地址不能自动接管",
      body: `
        <p class="drawer-lead">${escapeHtml(issue.host)} 已由其他站点使用。${transferable ? "系统已确认它属于另一个 ABCDeploy 项目；只有确认当前用途和恢复方式后才转移。" : "当前归属无法证明，ABCDeploy 不会修改这条路由；请更换地址或让维护人员先明确归属。"}</p>
        <div class="review-list">
          <div class="review-row"><span>当前去向</span><strong>${escapeHtml(issue.owner)}</strong><span class="status-badge amber">${escapeHtml(issue.currentTarget)}</span></div>
          <div class="review-row"><span>准备切换到</span><strong>${escapeHtml(task?.target ?? CURRENT_TEST_VERSION)}</strong><span class="status-badge green">测试通过</span></div>
          <div class="review-row"><span>当前正式版</span><strong>${escapeHtml(currentProductionVersionDisplayName() ?? "尚无正式版")}</strong><span class="status-badge green">确认前保持在线</span></div>
        </div>
        <div class="helper-note"><span class="helper-symbol">i</span><span>${transferable ? "执行前会备份原路由；校验或热加载失败会恢复原配置。这里只转移这个地址，不修改其他项目路由。" : "来源不明、非 Caddy 或无法验证配置入口时一律阻断，不用一次确认代替安全证明。"}</span></div>
        <details class="technical-details"><summary>查看技术详情</summary><p>任务 #${task?.id ?? "—"} · 路由冲突 AD-SRV-206 · 原目标 ${escapeHtml(issue.currentTarget)}。</p></details>
      `,
      footer: transferable
        ? `<button class="secondary-button" type="button" data-action="close-sheet">暂不转移</button><button class="primary-button" type="button" data-action="confirm-route-takeover">确认转移并继续任务 #${task?.id ?? "—"}</button>`
        : '<button class="secondary-button" type="button" data-action="close-sheet">暂不处理</button><button class="primary-button" type="button" data-action="edit-production-address">更换正式地址</button>',
    };
  }
  return {
    title: "重新允许 ABCDeploy 获取代码更新",
    body: `
      <p class="drawer-lead">任务 #${task?.id ?? 24}、目标测试环境和已完成结果已经保存。这里仅替换失效授权，保存后从原停点继续。</p>
      <div class="completed-list"><span>✓ 项目代码已提交</span><span>✓ 更新任务已创建</span><span>✓ 旧测试版仍在线</span></div>
      <div class="form-field">
        <label for="replacement-token">新的授权令牌</label>
        <input id="replacement-token" data-field="replacementToken" type="password" value="${fieldValue("replacementToken")}" placeholder="粘贴新的授权信息" ${fieldA11y("replacementToken")} autocomplete="off" />
        <small>只保存到系统密钥库。</small>
        ${fieldError("replacementToken")}
      </div>
      <details class="technical-details"><summary>查看技术详情</summary><p>服务提供方：CNB · 需要读取构建结果权限 · AD-CNB-103。</p></details>
    `,
    footer: `<button class="primary-button" type="button" data-action="save-recovery">保存并继续任务 #${task?.id ?? 24}</button>`,
  };
}

function productionSheet() {
  const rollback = state.productionIntent === "rollback";
  return {
    title: rollback ? "恢复正式版到这个版本" : "发布给正式用户",
    body: `
      <p class="drawer-lead">这是一个独立正式任务。将使用测试通过的同一版本，不重新生成。${rollback ? "当前正式版会继续在线，直到恢复版本通过检查。" : ""}</p>
      <div class="review-list">
        <div class="review-row"><span>目标版本</span><strong>${productionVersionDisplayName()}</strong><span class="status-badge green">测试通过</span></div>
        <div class="review-row"><span>正式地址</span><strong>https://${escapeHtml(productionDomain())}</strong><span class="status-badge green">已设置</span></div>
        <div class="review-row"><span>运行位置</span><strong>${escapeHtml(state.serverConnections[state.environmentBindings.production.serverConnectionId]?.label ?? "尚未选择")} · ${escapeHtml(productionRuntimeAddress())}</strong><span class="status-badge green">已验证</span></div>
        <div class="review-row"><span>环境配置</span><strong>${missingRequiredConfigKeys("production").length ? `还缺 ${missingRequiredConfigKeys("production").length} 项` : `修订 ${escapeHtml(configRevision("production"))}`}</strong><span class="status-badge ${missingRequiredConfigKeys("production").length ? "amber" : "green"}">${missingRequiredConfigKeys("production").length ? "不完整" : "完整"}</span></div>
        <div class="review-row"><span>当前正式版</span><strong>${currentProductionVersionDisplayName() ?? "还没有正式版本"}</strong><span class="status-badge">保持在线</span></div>
      </div>
      <div class="helper-note"><span class="helper-symbol">i</span><span>新版本未通过健康检查前不会替换当前正式版；数据库数据不会随版本自动回退。</span></div>
    `,
    footer: `<button class="primary-button" type="button" data-action="create-production-task">${rollback ? "确认恢复此版本" : "确认发布"}</button>`,
  };
}

function addressEditSheet() {
  return {
    title: "修改正式访问地址",
    body: `
      <p class="drawer-lead">只修改后续检查的地址，不会重新生成版本、重启服务或撤销已经完成的部署。</p>
      <div class="form-field"><label for="production-domain-edit">正式访问地址</label><input id="production-domain-edit" data-field="addressDraftDomain" value="${fieldValue("addressDraftDomain")}" placeholder="例如 app.example.com" ${fieldA11y("addressDraftDomain")} autocomplete="off" /><small>只填写完整域名，不包含 https:// 或路径。取消后不会改变当前地址。</small>${fieldError("addressDraftDomain")}</div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">取消</button><button class="primary-button" type="button" data-action="save-production-address">保存并重新检查</button>`,
  };
}

function configPickerSheet() {
  const targetLabel = state.configTarget === "production" ? "正式环境" : state.configTarget === "staging" ? "测试环境" : "配置中心";
  const environmentKey = state.configTarget === "production" ? "production" : "staging";
  const selectedProfileIds = state.environmentBindings[environmentKey]?.configProfileIds ?? [];
  const profileRows = state.configProfiles
    .map((profile) => {
      const usages = configProfileUsages(profile.id);
      const projectCount = new Set(usages.map((usage) => usage.projectId)).size;
      const owner = profile.projectId ? state.projects.find((project) => project.id === profile.projectId)?.name ?? "指定项目" : null;
      return `<div class="review-row resource-action-row"><span>${escapeHtml(profile.label)}</span><strong>${escapeHtml(profile.key)}<small>${owner ? `仅用于 ${escapeHtml(owner)}` : usages.length ? `引用：${usages.map((usage) => escapeHtml(usage.label)).join("、")}` : "没有项目引用"}</small></strong><span class="status-badge ${usages.length ? "green" : ""}">${usages.length ? `${projectCount} 个项目 · ${usages.length} 个环境` : "尚未引用"}</span><button class="text-button" type="button" data-action="edit-config-profile" data-profile-id="${escapeHtml(profile.id)}">维护</button></div>`;
    })
    .join("");
  const recommendationScore = (profile) => Number(["staging", "production"].includes(state.configTarget)
    && profileBoundToProjectEnvironment(profile.id, state.currentProjectId, state.configTarget)) * 2
    + Number(profile.environmentScope === state.configTarget);
  const profileChoices = state.configProfiles
    .filter((profile) => profile.key === "PROVIDER_API_KEY" && configProfileAvailableToProject(profile))
    .sort((left, right) => recommendationScore(right) - recommendationScore(left))
    .map((profile, index, profiles) => {
      const usageCount = configProfileUsages(profile.id).length;
      return `<button class="choice-card ${selectedProfileIds.includes(profile.id) ? "selected" : ""}" type="button" data-action="bind-config-profile" data-profile-id="${escapeHtml(profile.id)}" aria-pressed="${selectedProfileIds.includes(profile.id)}">
      <span class="radio"></span><span class="choice-copy"><strong>${escapeHtml(profile.label)}</strong><span>${escapeHtml(profile.key)} · ${usageCount ? `${usageCount} 个环境正在引用` : "尚未引用"}</span></span>${index === 0 && recommendationScore(profile) > recommendationScore(profiles[1] ?? {}) ? '<span class="status-badge green">推荐</span>' : ""}
    </button>`;
    })
    .join("");
  return {
    title: `${targetLabel}配置`,
    body: `
      <p class="drawer-lead">选择已有配置会建立持续绑定；也可以在这里新建，不需要离开当前任务。</p>
      ${state.configTarget === "library" ? `<div class="review-list">${profileRows}</div>` : ""}
      ${state.configTarget === "library" ? "" : `<div class="choice-list">${profileChoices}</div>`}
      <div class="divider-label"><span>或者新建</span></div>
      <div class="form-field"><label for="new-config-label">配置说明</label><input id="new-config-label" data-field="newConfigLabel" value="${fieldValue("newConfigLabel")}" placeholder="例如 商城测试密钥" ${fieldA11y("newConfigLabel")} autocomplete="off" />${fieldError("newConfigLabel")}</div>
      <div class="form-field"><label for="new-config-key">配置名称</label><input id="new-config-key" data-field="newConfigKey" value="${fieldValue("newConfigKey")}" placeholder="例如 PROVIDER_API_KEY" ${fieldA11y("newConfigKey")} autocomplete="off" /><small>保留项目使用的英文 Key；说明负责让用户看懂。</small>${fieldError("newConfigKey")}</div>
      <div class="form-field"><label for="new-config-value">配置值</label><input id="new-config-value" data-field="newConfigValue" type="password" value="${fieldValue("newConfigValue")}" placeholder="只保存到系统密钥库" ${fieldA11y("newConfigValue")} autocomplete="off" />${fieldError("newConfigValue")}</div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="return-from-config">${state.configTarget === "library" ? "完成" : "返回当前任务"}</button><button class="primary-button" type="button" data-action="create-config-profile">${state.configTarget === "library" ? "仅保存" : "保存并应用到当前环境"}</button>`,
  };
}

function configEditSheet() {
  const profile = state.configProfiles.find((item) => item.id === state.configEditProfileId);
  if (!profile) return configPickerSheet();
  const usages = configProfileUsages(profile.id);
  const keyLocked = usages.length > 0;
  const selectedUsage = usages.find((usage) => usage.projectId === state.configEditProjectId && usage.environment === state.configEditEnvironment)
    ?? usages.find((usage) => usage.projectId === state.currentProjectId)
    ?? usages[0]
    ?? null;
  const appliedRevision = selectedUsage?.appliedRevision ?? null;
  const environmentChoices = usages.length > 1
    ? `<div class="choice-list">${usages.map((usage) => `<button class="choice-card ${selectedUsage?.projectId === usage.projectId && selectedUsage?.environment === usage.environment ? "selected" : ""}" type="button" data-action="select-config-edit-environment" data-project-id="${escapeHtml(usage.projectId)}" data-config-environment="${usage.environment}" aria-pressed="${selectedUsage?.projectId === usage.projectId && selectedUsage?.environment === usage.environment}"><span class="radio"></span><span class="choice-copy"><strong>${escapeHtml(usage.label)}</strong><span>${usage.appliedRevision == null ? "尚未应用" : `当前使用修订 ${usage.appliedRevision}`}</span></span></button>`).join("")}</div>`
    : "";
  const canApplyHere = selectedUsage?.projectId === state.currentProjectId;
  return {
    title: "维护配置条目",
    body: `
      <p class="drawer-lead">这里先维护配置库，引用关系保持不变；敏感值不会回显，留空表示保持原值。正在运行的环境不会被静默更新。</p>
      <div class="form-field"><label for="edit-config-label">配置说明</label><input id="edit-config-label" data-field="editConfigLabel" value="${fieldValue("editConfigLabel")}" ${fieldA11y("editConfigLabel")} autocomplete="off" />${fieldError("editConfigLabel")}</div>
      <div class="form-field"><label for="edit-config-key">配置名称</label><input id="edit-config-key" data-field="editConfigKey" value="${fieldValue("editConfigKey")}" ${fieldA11y("editConfigKey")} autocomplete="off" ${keyLocked ? "readonly aria-readonly=\"true\"" : ""} />${keyLocked ? "<small>正在被环境引用，配置名称不能直接改；可新建另一条配置后切换绑定。</small>" : ""}${fieldError("editConfigKey")}</div>
      <div class="form-field"><label for="edit-config-value">新的配置值</label><input id="edit-config-value" data-field="editConfigValue" type="password" value="${fieldValue("editConfigValue")}" placeholder="留空保持原值" autocomplete="off" /></div>
      ${environmentChoices}
      <div class="helper-note"><span class="helper-symbol">i</span><span>${selectedUsage ? `${escapeHtml(selectedUsage.label)} ${appliedRevision == null ? "尚未应用" : `当前使用修订 ${appliedRevision}`}；配置库最新修订 ${profile.revision}。仅保存不会改变运行环境。${canApplyHere ? "" : "请打开对应项目后再应用。"}` : "当前没有项目引用；保存后可在项目任务中选择这条配置。"}</span></div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="back-to-config-library">返回</button>${selectedUsage ? `<button class="text-button" type="button" data-action="unbind-config-profile">解除${escapeHtml(selectedUsage.label)}引用</button><button class="secondary-button" type="button" data-action="save-config-profile-edit">仅保存</button>${canApplyHere ? `<button class="primary-button" type="button" data-action="save-and-apply-config">保存并应用到${configEnvironmentLabel(selectedUsage.environment)}</button>` : ""}` : '<button class="primary-button" type="button" data-action="save-config-profile-edit">仅保存</button>'}`,
  };
}

function configApplyConfirmSheet() {
  const pending = state.pendingConfigApplication;
  const profile = state.configProfiles.find((item) => item.id === pending?.profileId);
  if (!pending || !profile) return configPickerSheet();
  const production = pending.environment === "production";
  return {
    title: `应用到${configEnvironmentLabel(pending.environment)}`,
    body: `
      <p class="drawer-lead">配置已经保存到配置中心，但运行环境仍使用原修订。确认后才创建一条环境变更任务。</p>
      <div class="review-list">
        <div class="review-row"><span>应用位置</span><strong>${escapeHtml(projectEnvironmentBindingLabel(pending.projectId, pending.environment))}</strong><span class="status-badge ${production ? "amber" : ""}">${production ? "正式影响" : "测试环境"}</span></div>
        <div class="review-row"><span>配置</span><strong>${escapeHtml(profile.label)} · ${escapeHtml(profile.key)}</strong><span class="status-badge">${pending.previousRevision == null ? `尚未应用 → 修订 ${pending.profileRevision}` : `修订 ${pending.previousRevision} → ${pending.profileRevision}`}</span></div>
        <div class="review-row"><span>当前版本</span><strong>${production ? currentProductionVersionDisplayName() ?? "尚未发布" : CURRENT_TEST_VERSION}</strong><span class="status-badge green">版本不变</span></div>
      </div>
      <div class="helper-note"><span class="helper-symbol">i</span><span>${production ? "会重启受影响的正式服务；健康检查通过前当前正式版继续在线。" : "只更新测试环境；不会生成新版本，也不会发布正式环境。"}</span></div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="cancel-config-application">暂不应用</button><button class="primary-button" type="button" data-action="confirm-config-application">确认应用到${configEnvironmentLabel(pending.environment)}</button>`,
  };
}

function configApplyProgressSheet() {
  const pending = state.pendingConfigApplication;
  return {
    title: `正在更新${configEnvironmentLabel(pending.environment)}`,
    body: `<p class="drawer-lead">配置应用是独立任务，不会产生新版本。当前在线版本会保留到新配置通过检查。</p><div class="activity-list progress-list"><div class="activity-row"><span class="check-icon done">✓</span><span class="activity-copy"><strong>固定配置修订</strong><span>修订 ${pending.profileRevision}</span></span><span class="status-badge green">完成</span></div><div class="activity-row"><span class="check-icon current-progress">2</span><span class="activity-copy"><strong>应用并检查服务</strong><span>任务 #${pending.taskId}</span></span><span class="status-badge amber">进行中</span></div></div>`,
    footer: `<button class="prototype-next" type="button" data-action="finish-config-application">原型：模拟应用完成</button>`,
  };
}

function connectionsSheet() {
  const accountReady = codeAccountConnectionReady();
  const codeReady = sourceBindingReady();
  const codeExists = Boolean(state.codeConnection);
  const codeStatus = state.codeConnectionStatus === "invalid"
    ? "账号需要更新"
    : codeReady
      ? "当前仓库已核对"
      : accountReady
        ? "账号可用，仓库待核对"
        : "尚未连接";
  const registryReady = state.registryConnectionStatus === "ready" && Boolean(state.registryConnection);
  const stagingServerId = state.environmentBindings.staging.serverConnectionId;
  const productionServerId = state.environmentBindings.production.serverConnectionId;
  const stagingServer = state.serverConnections[stagingServerId];
  const productionServer = state.serverConnections[productionServerId];
  const stagingReady = serverConnectionReady(stagingServerId);
  const productionServerReady = serverConnectionReady(productionServerId);
  return {
    title: "连接与运行资源",
    body: `
      <p class="drawer-lead">这些能力可以被多个项目复用。项目只保存引用，更换授权不会删除项目、版本或部署历史。</p>
      <div class="review-list">
        <div class="review-row resource-action-row"><span>代码更新连接</span><strong>${codeExists ? `${escapeHtml(state.codeConnection.provider)} · ${escapeHtml(expectedSourceIdentity()?.repositoryScope ?? state.sourceBinding?.repositoryScope ?? "当前项目尚未识别仓库")}` : "尚未选择"}<small>${codeExists ? `账号连接修订 ${state.codeConnection.revision}` : ""}</small></strong><span class="status-badge ${state.codeConnectionStatus === "invalid" || accountReady && !codeReady ? "amber" : codeReady ? "green" : ""}">${codeStatus}</span><button class="text-button" type="button" data-action="replace-code-connection">${codeExists ? "更换授权" : "添加连接"}</button></div>
        <div class="review-row resource-action-row"><span>版本保存位置</span><strong>${registryReady ? escapeHtml(state.registryConnection.endpoint) : "尚未选择"}</strong><span class="status-badge ${registryReady ? "green" : ""}">${registryReady ? "推送和读取已验证" : "尚未连接"}</span><button class="text-button" type="button" data-action="edit-registry-connection">${registryReady ? "维护" : "添加连接"}</button></div>
        <div class="review-row resource-action-row"><span>测试运行位置</span><strong>${stagingServer ? `${escapeHtml(stagingServer.label)} · ${escapeHtml(stagingServer.host)}` : "尚未绑定"}</strong><span class="status-badge ${stagingReady ? "green" : stagingServer ? "amber" : state.serverConnectionStatus === "checking" ? "amber" : ""}">${stagingReady ? "能力已验证" : stagingServer ? "需要重新验证" : state.serverConnectionStatus === "checking" ? "正在判断能力" : "尚未连接"}</span><button class="text-button" type="button" data-action="edit-server-connection" data-server-scope="staging">${stagingServer ? "重新验证" : "添加运行位置"}</button></div>
        <div class="review-row resource-action-row"><span>正式运行位置</span><strong>${productionServer ? `${escapeHtml(productionServer.label)} · ${escapeHtml(productionServer.host)}` : "尚未绑定"}</strong><span class="status-badge ${productionServerReady ? "green" : productionServer ? "amber" : ""}">${productionServerReady ? "能力已验证" : productionServer ? "需要重新验证" : "首次发布时再设置"}</span><button class="text-button" type="button" data-action="edit-server-connection" data-server-scope="production">${productionServer ? "重新验证" : "提前添加"}</button></div>
      </div>
      <details class="technical-details"><summary>查看提供方与最近验证</summary><p>代码平台：CNB；版本存储：腾讯云 TCR；运行位置：Linux。技术名称只在维护连接时出现。</p></details>
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">完成</button>`,
  };
}

function connectionEditSheet() {
  const isServer = state.connectionEditTarget === "server";
  const serverScope = state.connectionServerScope;
  const serverBindingId = isServer ? state.environmentBindings[serverScope]?.serverConnectionId : null;
  if (isServer && state.connectionServerStep === "identity") {
    return {
      title: "确认服务器身份",
      body: `
        <p class="drawer-lead">登录信息已验证。确认主机指纹后，这个运行位置才会被标记为可用。</p>
        <div class="action-panel warn"><span class="action-copy"><strong>${escapeHtml(state.formValues.connectionHost)}</strong><span>主机指纹：SHA256:R4d8…mN6c · 首次连接</span></span></div>
        <div class="helper-note"><span class="helper-symbol">i</span><span>这一步只建立可复用连接，不会部署或重启任何项目。</span></div>
      `,
      footer: `<button class="secondary-button" type="button" data-action="back-to-connections">取消</button><button class="primary-button" type="button" data-action="confirm-resource-server-identity">确认身份并检查运行能力</button>`,
    };
  }
  if (isServer && state.connectionServerStep === "capability") {
    return {
      title: "确认运行位置能力",
      body: `
        <p class="drawer-lead">服务器身份已经确认。只有运行前提和共享访问能力检查通过，这个连接才会成为可选运行位置。</p>
        ${serverCapabilityPanel()}
      `,
      footer: `<button class="secondary-button" type="button" data-action="back-to-connections">取消</button><button class="primary-button" type="button" data-action="save-resource-server">保存这个运行位置</button>`,
    };
  }
  if (isServer && state.connectionServerStep === "credentials") {
    return {
      title: `添加${serverScope === "production" ? "正式" : "测试"}运行位置`,
      body: `
        <p class="drawer-lead">先填写可以登录的 Linux 服务器。系统会验证身份和运行能力；不会仅凭一段凭据假定服务器可用。</p>
        <div class="form-field"><label for="connection-host">服务器地址</label><input id="connection-host" data-field="connectionHost" value="${fieldValue("connectionHost")}" placeholder="例如 203.0.113.10" ${fieldA11y("connectionHost")} autocomplete="off" />${fieldError("connectionHost")}</div>
        <div class="form-field"><label for="connection-user">登录用户</label><input id="connection-user" data-field="connectionUser" value="${fieldValue("connectionUser")}" placeholder="例如 ubuntu" ${fieldA11y("connectionUser")} autocomplete="off" />${fieldError("connectionUser")}</div>
        <div class="form-field"><label for="connection-secret">密码或 SSH 密钥</label><input id="connection-secret" data-field="connectionServerSecret" type="password" value="${fieldValue("connectionServerSecret")}" placeholder="只保存到系统密钥库" ${fieldA11y("connectionServerSecret")} autocomplete="off" />${fieldError("connectionServerSecret")}</div>
      `,
      footer: `<button class="secondary-button" type="button" data-action="back-to-connections">返回</button><button class="primary-button" type="button" data-action="save-resource-connection">连接并核对身份</button>`,
    };
  }
  if (state.connectionEditTarget === "registry") {
    return {
      title: "维护版本保存连接",
      body: `
        <p class="drawer-lead">版本保存位置是一条可复用连接。系统分别验证构建端推送和服务器读取；更换默认位置不会改写已生成版本的原仓库引用。</p>
        <div class="form-field"><label for="connection-registry-endpoint">版本仓库地址</label><input id="connection-registry-endpoint" data-field="connectionRegistryEndpoint" value="${fieldValue("connectionRegistryEndpoint")}" placeholder="例如 ccr.ccs.tencentyun.com/team" ${fieldA11y("connectionRegistryEndpoint")} autocomplete="off" />${fieldError("connectionRegistryEndpoint")}</div>
        <div class="form-field"><label for="connection-registry-account">登录账号</label><input id="connection-registry-account" data-field="connectionRegistryAccount" value="${fieldValue("connectionRegistryAccount")}" placeholder="版本保存账号" ${fieldA11y("connectionRegistryAccount")} autocomplete="off" />${fieldError("connectionRegistryAccount")}</div>
        <div class="form-field"><label for="connection-token">访问密码</label><input id="connection-token" data-field="connectionToken" type="password" value="${fieldValue("connectionToken")}" placeholder="留空则保持现有密码" ${fieldA11y("connectionToken")} autocomplete="off" />${fieldError("connectionToken")}</div>
        <details class="technical-details"><summary>查看端点处理</summary><p>首版允许填写一个仓库地址，验证后记录实际 push endpoint 与 pull endpoint；二者可能因地域或内网不同。历史版本继续引用原 Connection revision，原连接保留读取能力。</p></details>
      `,
      footer: `<button class="secondary-button" type="button" data-action="back-to-connections">返回</button><button class="primary-button" type="button" data-action="save-resource-connection">验证并保存</button>`,
    };
  }
  const meta = {
    code: { title: "更换代码更新授权", lead: "新的授权验证通过后会替换原连接。引用它的项目不需要移除或重新添加。", label: "新的授权信息", placeholder: "粘贴新的授权信息", action: "save-code-connection" },
    server: { title: `重新验证${serverScope === "production" ? "正式" : "测试"}运行位置`, lead: "系统只重新验证登录、容器运行和访问服务能力，不会重启在线项目。", label: "新的服务器凭据", placeholder: "粘贴密码或密钥信息", action: "save-resource-connection" },
  }[state.connectionEditTarget] ?? {};
  return {
    title: meta.title,
    body: `
      <p class="drawer-lead">${meta.lead}</p>
      <div class="form-field"><label for="connection-token">${meta.label}</label><input id="connection-token" data-field="connectionToken" type="password" value="${fieldValue("connectionToken")}" placeholder="${meta.placeholder}" ${fieldA11y("connectionToken")} autocomplete="off" />${fieldError("connectionToken")}</div>
      <div class="helper-note"><span class="helper-symbol">i</span><span>只更新授权内容；项目、服务器、配置和在线版本都不会变化。</span></div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="back-to-connections">返回</button><button class="primary-button" type="button" data-action="${meta.action}">验证并保存</button>`,
  };
}

function tasksSheet() {
  const task = activeTask();
  const activeStatus = task?.status === "running"
    ? "进行中"
    : task?.status === "waiting-address"
      ? "等待完成地址"
      : task?.status === "waiting-input" || task?.status === "waiting"
        ? "等待处理"
        : "已完成";
  const activeTaskLabel = task?.kind === "production"
    ? task.intent === "rollback" ? "正式恢复" : "正式发布"
    : task?.kind === "config"
      ? `应用${configEnvironmentLabel(task.environment)}配置`
      : "生成测试版";
  const statusLabel = (attempt) => ({ running: "进行中", succeeded: "成功", failed: "失败", blocked: "被阻断" }[attempt.status] ?? attempt.status);
  const stageLabel = (stage) => ({ "trigger-build": "触发生成", "read-result": "读取生成结果", "deploy-services": "启动项目服务", "service-deployed": "项目服务已启动" }[stage] ?? "执行任务");
  const attemptRows = task
    ? taskAttempts(task.id)
      .map((attempt) => `<span>执行 #${attempt.sequence} · ${statusLabel(attempt)} · ${stageLabel(attempt.stage)}</span>`)
      .join("")
    : "";
  const attemptTechnicalDetails = taskAttempts(task?.id).some((attempt) => attempt.errorCode)
    ? `<details class="technical-details"><summary>查看执行错误编号</summary><p>${taskAttempts(task.id).filter((attempt) => attempt.errorCode).map((attempt) => `执行 #${attempt.sequence} · ${attempt.errorCode} · ${attempt.externalRunId}`).join("；")}</p></details>`
    : "";
  const executionCopy = taskAttempts(task?.id).length
    ? attemptRows
    : `<span>尚未开始远程执行 · ${activeStatus}</span>`;
  const active = task
    ? `<div class="task-attempt"><strong>任务 #${task.id} · ${activeTaskLabel}</strong><span>目标：${task.target ?? "测试环境"}</span>${executionCopy}${attemptTechnicalDetails}<button class="text-button" type="button" data-action="resume-active-task">回到停点</button></div>`
    : `<div class="empty-inline">目前没有进行中的任务</div>`;
  const recentTasks = Object.values(state.tasksById).filter((item) => item.id !== state.activeTaskId && ["completed", "canceled"].includes(item.status));
  const recent = recentTasks.length
    ? recentTasks.map((item) => {
        const attempts = taskAttempts(item.id);
        return `<div class="task-attempt"><strong>任务 #${item.id} · ${item.status === "canceled" ? "已放弃" : "已完成"}</strong><span>目标：${item.target}</span><span>${attempts.length ? `共 ${attempts.length} 次执行 · ${statusLabel(attempts.at(-1))}` : "没有开始远程执行"}</span></div>`;
      }).join("")
    : `<div class="empty-inline">完成过的任务会保留在这里</div>`;
  return {
    title: "任务与执行记录",
    body: `<p class="drawer-lead">任务保存“要得到什么”，每次重试只增加一次执行记录，不会复制目标或丢掉已完成结果。</p><h3 class="subsection-title">正在处理</h3>${active}<h3 class="subsection-title">最近完成</h3>${recent}`,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">完成</button>`,
  };
}

function projectsSheet() {
  const rows = state.projects.map((project) => `<div class="review-row resource-action-row"><span>${escapeHtml(project.name)}</span><strong>${escapeHtml(project.path)}</strong><span class="status-badge ${project.id === state.currentProjectId ? "green" : ""}">${project.id === state.currentProjectId ? "当前项目" : "可以打开"}</span><button class="text-button" type="button" data-action="open-project" data-project-id="${escapeHtml(project.id)}">打开</button></div>`).join("");
  return {
    title: "所有项目",
    body: `<p class="drawer-lead">项目只负责选择当前工作对象；部署连接、运行位置和配置可以跨项目复用。</p><div class="review-list">${rows}</div><div class="helper-note"><span class="helper-symbol">+</span><span>选择项目目录后先识别服务和已有部署，不会立即创建远程任务。</span></div>`,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">完成</button><button class="primary-button" type="button" data-action="add-project">选择项目目录</button>`,
  };
}

function sourceVerificationSheet() {
  const repositoryScope = state.sourceVerificationIssue?.repositoryScope
    ?? expectedSourceIdentity(state)?.repositoryScope
    ?? "当前项目仓库";
  return {
    title: "当前账号还不能读取这个项目",
    body: `
      <p class="drawer-lead">代码平台账号仍然保留，只是尚未证明它可以读取 <strong>${escapeHtml(repositoryScope)}</strong>。系统没有创建任务，也没有开始远程执行。</p>
      <div class="error-panel" role="alert"><div><h3>项目仓库核对未通过</h3><p>请先在代码平台确认这个账号拥有当前仓库的读取和构建权限，然后重新核对。其他项目的授权和部署不会受影响。</p></div></div>
      <div class="helper-note"><span class="helper-symbol">i</span><span>重新核对只读取本机 Git remote 和代码平台仓库，不会推送代码、创建构建或修改线上环境。</span></div>
      <button class="text-button inline-action" type="button" data-action="open-source-permissions">打开代码平台检查权限</button>
      <details class="technical-details"><summary>查看技术详情</summary><p>错误编号：${escapeHtml(state.sourceVerificationIssue?.code ?? "AD-SOURCE-101")} · 账号连接修订 ${escapeHtml(state.codeConnection?.revision ?? "—")}</p></details>
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">暂不处理</button><button class="secondary-button" type="button" data-action="change-source-account">更换账号授权</button><button class="primary-button" type="button" data-action="recheck-source-binding">重新核对并继续</button>`,
  };
}

function credentialHelpSheet() {
  const code = state.credentialHelpTarget === "code";
  return {
    title: code ? "获取代码平台授权" : "创建版本保存位置",
    body: code
      ? `
        <p class="drawer-lead">不需要理解权限术语。按下面三步完成后，回到原题粘贴授权即可。</p>
        <div class="compact-plan">
          <div class="check-row"><span class="check-icon">1</span><span class="check-copy"><strong>打开代码平台授权页</strong><span>使用保存当前项目代码的账号登录。</span></span></div>
          <div class="check-row"><span class="check-icon">2</span><span class="check-copy"><strong>创建项目自动更新授权</strong><span>允许读取当前仓库、触发生成并读取结果；页面会标出首版所需范围。</span></span></div>
          <div class="check-row"><span class="check-icon">3</span><span class="check-copy"><strong>复制并带回 ABCDeploy</strong><span>授权只保存到系统密钥库，不写入项目目录。</span></span></div>
        </div>`
      : `
        <p class="drawer-lead">版本仓库用来保存测试通过的不可变版本。按下面步骤创建一次，以后其他项目可以复用。</p>
        <div class="compact-plan">
          <div class="check-row"><span class="check-icon">1</span><span class="check-copy"><strong>打开镜像仓库控制台</strong><span>首版可使用腾讯云 TCR；已有兼容仓库也可以。</span></span></div>
          <div class="check-row"><span class="check-icon">2</span><span class="check-copy"><strong>创建实例或选择已有实例</strong><span>复制仓库地址、登录账号和访问密码。</span></span></div>
          <div class="check-row"><span class="check-icon">3</span><span class="check-copy"><strong>回到原题粘贴</strong><span>系统会自动验证保存和读取能力，不要求区分 push 与 pull。</span></span></div>
        </div>`,
    footer: `<button class="secondary-button" type="button" data-action="return-to-setup-question">回到原题</button><button class="primary-button" type="button" data-action="open-credential-console">打开${code ? "代码平台" : "镜像仓库"}控制台</button>`,
  };
}

function existingResetSheet() {
  return {
    title: "重新设置这个项目的部署",
    body: `
      <p class="drawer-lead">只重置 ABCDeploy 在本机保存的项目绑定和任务停点，线上测试版、正式版、服务器文件和版本仓库都不会被停止或删除。</p>
      <div class="error-panel"><div><h3>不会自动接管或清理现有服务</h3><p>确认后回到首次设置，并按当前仍缺少的能力重新提问。</p></div></div>
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">取消</button><button class="danger-button" type="button" data-action="confirm-reset-existing">确认重新设置</button>`,
  };
}

function existingAdoptSheet() {
  const needsCodeAccount = !codeAccountConnectionReady();
  const needsSourceBinding = !needsCodeAccount && !sourceBindingReady();
  const needsRegistryConnection = !needsCodeAccount && !needsSourceBinding && !registryConnectionReady();
  const existingServerId = state.environmentBindings.staging.serverConnectionId;
  const existingServer = state.serverConnections[existingServerId];
  const existingServerReadable = serverConnectionReady(existingServerId) && existingServer?.capability === "compatible";
  const needsServerConnection = !needsCodeAccount && !needsSourceBinding && !needsRegistryConnection && !existingServerReadable;
  const discovery = state.existingDiscoverySnapshotId ? state.discoverySnapshotsById[state.existingDiscoverySnapshotId] : null;
  const discoveryMatches = Boolean(discovery?.observedAt
    && discovery.serverConnectionId === existingServerId
    && discovery.serverConnectionRevision === `${existingServerId}@${existingServer?.revision ?? 1}`
    && discovery.serverHost === existingServer?.host
    && discovery.serverFingerprint === existingServer?.fingerprint);
  const needsDiscovery = !needsCodeAccount && !needsSourceBinding && !needsRegistryConnection && !needsServerConnection && !discoveryMatches;
  const reviewReady = !needsCodeAccount && !needsSourceBinding && !needsRegistryConnection && !needsServerConnection && discoveryMatches;
  const currentStep = needsCodeAccount ? "1. 补充代码平台账号" : needsSourceBinding ? "1. 核对当前项目仓库" : needsRegistryConnection ? "2. 补充版本保存连接" : needsServerConnection ? "3. 验证运行服务器" : needsDiscovery ? "4. 核对远程部署事实" : "5. 确认接入事实";
  const stagingObserved = discovery?.environments?.staging;
  const productionObserved = discovery?.environments?.production;
  return {
    title: "核对并接入已有部署",
    body: `
      <p class="drawer-lead">你已经允许本次核对。系统只读取在线版本、地址和连接缺口；确认前不会修改服务器或创建部署任务。</p>
      <div class="sheet-plan-summary"><strong>${currentStep}</strong><span>一次只处理一个缺口</span></div>
      <div class="review-list">
        <div class="review-row"><span>测试环境</span><strong>${stagingObserved?.displayName ?? "等待远程读取"}</strong><span class="status-badge ${stagingObserved?.healthCheck === "passed" ? "green" : ""}">${stagingObserved?.healthCheck === "passed" ? "已核对在线" : "尚未核对"}</span></div>
        <div class="review-row"><span>正式环境</span><strong>${productionObserved?.displayName ?? "等待远程读取"}</strong><span class="status-badge ${productionObserved?.healthCheck === "passed" ? "green" : ""}">${productionObserved?.healthCheck === "passed" ? "已核对在线" : "尚未核对"}</span></div>
        <div class="review-row"><span>代码更新</span><strong>${needsCodeAccount ? "还需要账号授权" : needsSourceBinding ? "账号可用，当前仓库待核对" : "账号和仓库均可用"}</strong><span class="status-badge ${needsCodeAccount || needsSourceBinding ? "amber" : "green"}">${needsCodeAccount || needsSourceBinding ? "待处理" : "已验证"}</span></div>
        <div class="review-row"><span>版本保存</span><strong>${needsRegistryConnection ? "还需要连接" : state.registryConnection?.endpoint ?? "等待核对"}</strong><span class="status-badge ${needsRegistryConnection ? "amber" : "green"}">${needsRegistryConnection ? "待补充" : "已验证"}</span></div>
        <div class="review-row"><span>运行服务器</span><strong>${needsServerConnection ? "还需要验证" : existingServer ? `${escapeHtml(existingServer.label)} · ${escapeHtml(existingServer.host)}` : "等待核对"}</strong><span class="status-badge ${needsServerConnection ? "amber" : "green"}">${needsServerConnection ? "待补充" : "已验证"}</span></div>
      </div>
      ${needsCodeAccount ? `<div class="form-field"><label for="existing-code-token">代码平台授权</label><input id="existing-code-token" data-field="connectionToken" type="password" value="${fieldValue("connectionToken")}" placeholder="粘贴授权信息" ${fieldA11y("connectionToken")} autocomplete="off" /><small>验证通过后才会建立账号连接并核对当前项目仓库。</small>${fieldError("connectionToken")}</div><button class="text-button inline-action" type="button" data-action="open-code-credential-help">还没有授权？查看获取步骤</button>` : ""}
      ${needsSourceBinding ? '<div class="action-panel warn"><span class="action-copy"><strong>账号已经可用，不需要重新粘贴授权</strong><span>只需重新读取当前项目仓库。</span></span><button class="secondary-button" type="button" data-action="recheck-source-binding">核对当前仓库</button></div>' : ""}
      ${needsRegistryConnection ? `
        <div class="form-field"><label for="existing-registry-endpoint">版本仓库地址</label><input id="existing-registry-endpoint" data-field="connectionRegistryEndpoint" value="${fieldValue("connectionRegistryEndpoint")}" placeholder="例如 ccr.ccs.tencentyun.com/team" ${fieldA11y("connectionRegistryEndpoint")} autocomplete="off" />${fieldError("connectionRegistryEndpoint")}</div>
        <div class="form-field"><label for="existing-registry-account">登录账号</label><input id="existing-registry-account" data-field="connectionRegistryAccount" value="${fieldValue("connectionRegistryAccount")}" placeholder="版本保存账号" ${fieldA11y("connectionRegistryAccount")} autocomplete="off" />${fieldError("connectionRegistryAccount")}</div>
        <div class="form-field"><label for="existing-registry-secret">访问密码</label><input id="existing-registry-secret" data-field="connectionToken" type="password" value="${fieldValue("connectionToken")}" placeholder="只保存到系统密钥库" ${fieldA11y("connectionToken")} autocomplete="off" />${fieldError("connectionToken")}</div><button class="text-button inline-action" type="button" data-action="open-registry-credential-help">还没有版本仓库？查看创建步骤</button>` : ""}
      ${needsServerConnection ? '<div class="action-panel warn"><span class="action-copy"><strong>需要确认服务器身份和运行能力</strong><span>接下来仍然只建立连接，不会部署、停止或替换在线服务。</span></span><button class="secondary-button" type="button" data-action="connect-existing-server">验证运行服务器</button></div>' : ""}
      ${needsDiscovery ? `<div class="error-panel" role="alert"><div><h3>${existingServer ? "没有在这台服务器发现对应部署" : "还没有远程发现证据"}</h3><p>本机线索指向 203.0.113.10；必须从匹配服务器读取版本、产物、配置引用、地址和健康状态后才能接入。</p></div><button class="secondary-button" type="button" data-action="connect-existing-server">${existingServer ? "核对正确服务器" : "验证运行服务器"}</button></div>` : ""}
      ${reviewReady ? `<div class="helper-note"><span class="helper-symbol">i</span><span>远程事实快照 ${escapeHtml(discovery.id)} · ${escapeHtml(discovery.observedAt)}。确认后只映射已证明的事实，线上服务保持原样。</span></div>` : ""}
    `,
    footer: `<button class="secondary-button" type="button" data-action="close-sheet">暂不接入</button>${needsSourceBinding || needsServerConnection || needsDiscovery ? "" : `<button class="primary-button" type="button" data-action="confirm-adopt-existing">${reviewReady ? "确认接入" : "验证并继续"}</button>`}`,
  };
}

function taskSheet() {
  const sheets = {
    setup: setupSheet,
    recovery: recoverySheet,
    "production-setup": productionSetupSheet,
    production: productionSheet,
    "address-edit": addressEditSheet,
    "config-picker": configPickerSheet,
    "config-edit": configEditSheet,
    "config-apply-confirm": configApplyConfirmSheet,
    "config-apply-progress": configApplyProgressSheet,
    automation: automationSheet,
    connections: connectionsSheet,
    "connection-edit": connectionEditSheet,
    tasks: tasksSheet,
    projects: projectsSheet,
    "source-verification": sourceVerificationSheet,
    "credential-help": credentialHelpSheet,
    "existing-reset": existingResetSheet,
    "existing-adopt": existingAdoptSheet,
  };
  const content = (sheets[state.sheet] ?? tasksSheet)();
  return `
    <div class="backdrop" data-action="close-sheet"></div>
    <section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header class="drawer-header"><h2 id="drawer-title">${content.title}</h2><button class="close-button" type="button" data-action="close-sheet" aria-label="关闭">×</button></header>
      <div class="drawer-body">${content.body}</div>
      <footer class="drawer-footer">${content.footer}</footer>
    </section>
  `;
}

function currentView() {
  if (state.page === "local") return localView();
  if (state.page === "versions") return versionsView();
  if (state.page === "settings") return settingsView();
  return releaseCenterView();
}

const requiredFieldLabels = {
  publishToken: "请填写代码平台授权",
  versionAccount: "请填写版本保存账号",
  versionPassword: "请填写版本保存密码",
  registryEndpoint: "请填写版本仓库地址",
  testHost: "请填写服务器地址",
  testUser: "请填写服务器登录用户",
  serverPassword: "请填写服务器登录密码或改用密钥文件",
  serverSshKey: "请粘贴 SSH 私钥或改用登录密码",
  adminPassword: "请填写管理员初始密码",
  productionAdminPassword: "请填写管理员正式密码",
  replacementToken: "请填写新的授权信息",
  connectionToken: "请填写新的授权信息",
  connectionRegistryEndpoint: "请填写版本仓库地址",
  connectionRegistryAccount: "请填写版本保存账号",
  connectionHost: "请填写服务器地址",
  connectionUser: "请填写登录用户",
  connectionServerSecret: "请填写服务器密码或 SSH 密钥",
  newConfigLabel: "请填写便于识别的配置说明",
  newConfigKey: "请填写配置名称（Key）",
  newConfigValue: "请填写配置值",
  editConfigLabel: "请填写配置说明",
  editConfigKey: "请填写配置名称（Key）",
};

function focusAfterRender(selector) {
  window.setTimeout(() => document.querySelector(selector)?.focus(), 0);
}

function focusMainHeading() {
  focusAfterRender(".content-scroll h1");
}

function applyValidationErrors(errors, focusSelector) {
  state = { ...state, formErrors: errors };
  persistState();
  render();
  focusAfterRender(focusSelector);
  return false;
}

function validateRequiredFields(names) {
  const errors = {};
  for (const name of names) {
    if (!String(state.formValues[name] ?? "").trim()) errors[name] = requiredFieldLabels[name];
  }
  if (!Object.keys(errors).length) return true;
  const first = Object.keys(errors)[0];
  return applyValidationErrors(errors, `[data-field="${first}"]`);
}

function validDomain(value) {
  if (value.length > 253 || value.includes("://") || value.includes("/") || /\s/.test(value)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function validateSetupQuestion(question) {
  if (question.key === "permission") return validateRequiredFields(["publishToken"]);
  if (question.key === "version-storage") {
    if (!validateRequiredFields(["registryEndpoint", "versionAccount", "versionPassword"])) return false;
    if (!canonicalRegistryEndpoint(state.formValues.registryEndpoint)) {
      return applyValidationErrors({ registryEndpoint: "请填写不含账号、密码或参数的有效版本仓库地址" }, '[data-field="registryEndpoint"]');
    }
    return true;
  }
  if (question.key === "destination") {
    if (state.setupNeedReasons.destination === "multiple") {
      if (!serverConnectionReady(state.stagingServerConnectionId)) return applyValidationErrors({ serverCapability: "请选择一个已经验证的运行位置" }, '[data-action="select-recommended-runtime"]');
      return true;
    }
    if (state.setupNeedReasons.destination === "server-identity") {
      if (!state.serverFingerprintConfirmed) return applyValidationErrors({ serverFingerprint: "请先确认主机指纹属于你的服务器" }, '[data-action="confirm-server-fingerprint"]');
      return true;
    }
    if (state.setupNeedReasons.destination === "server-capability") {
      if (state.serverCapability === "missing-runtime") return applyValidationErrors({ serverCapability: "先按准备说明补齐运行组件，再重新检查" }, '[data-server-capability="missing-runtime"]');
      if (["conflict", "adaptable"].includes(state.serverCapability)) return applyValidationErrors({ serverCapability: "现有访问服务无法安全复用，请先按接入要求整理或选择其他运行位置" }, '[data-server-capability="conflict"]');
      if (state.serverCapability === "clean" && !state.serverChangeConfirmed) return applyValidationErrors({ serverCapability: "这一步会初始化统一访问服务，请先确认允许准备" }, '[data-action="confirm-server-change"]');
      return true;
    }
    return validateRequiredFields(["testHost", "testUser", state.serverAuthMethod === "ssh-key" ? "serverSshKey" : "serverPassword"]);
  }
  if (question.key === "config") {
    const errors = {};
    if (!configProfileForKey("staging", "PROVIDER_API_KEY")) errors.configBinding = "请选择或新建第三方服务访问密钥";
    if (!String(state.formValues.adminPassword ?? "").trim()) errors.adminPassword = requiredFieldLabels.adminPassword;
    if (!Object.keys(errors).length) return true;
    const selector = errors.configBinding ? '[data-action="use-config-center"]' : '[data-field="adminPassword"]';
    return applyValidationErrors(errors, selector);
  }
  return true;
}

function validateProductionQuestion(question) {
  if (question.key === "production-destination") {
    const selectedId = state.productionSelectedRuntime === "alternative"
      ? state.productionServerConnectionId
      : state.environmentBindings.staging.serverConnectionId;
    if (!serverConnectionReady(selectedId)) {
      return applyValidationErrors({ productionServerConnectionId: "请先选择或添加一个已经验证的运行位置" }, state.productionSelectedRuntime === "alternative" ? '[data-action="add-production-server"]' : '[data-action="select-recommended-runtime"]');
    }
  }
  if (question.key === "production-config") {
    if (!configProfileForKey("production", "PROVIDER_API_KEY")) {
      return applyValidationErrors({ productionConfigBinding: "请选择或新建正式环境密钥" }, '[data-action="use-production-config"]');
    }
    if (!configProfileForKey("production", "ADMIN_PASSWORD")
      && !String(state.formValues.productionAdminPassword ?? "").trim()) {
      return applyValidationErrors({ productionAdminPassword: "请填写管理员正式密码" }, '[data-field="productionAdminPassword"]');
    }
  }
  if (question.key === "production-address") {
    const value = String(state.formValues.productionDomain ?? "").trim().toLowerCase();
    if (!value) return applyValidationErrors({ productionDomain: "请填写正式访问地址" }, '[data-field="productionDomain"]');
    if (!validDomain(value)) return applyValidationErrors({ productionDomain: "只填写有效域名，例如 app.example.com" }, '[data-field="productionDomain"]');
    state = { ...state, formValues: { ...state.formValues, productionDomain: value }, formErrors: {} };
  }
  if (question.key === "production-impact" && !productionSetupReady()) {
    const binding = state.environmentBindings.production;
    const domain = String(state.formValues.productionDomain ?? "").trim().toLowerCase();
    const canonicalAddress = domain ? `https://${domain}` : null;
    const repairIndex = !serverConnectionReady(binding.serverConnectionId)
      ? 0
      : missingRequiredConfigKeys("production").length
        ? 1
        : 2;
    state = {
      ...state,
      productionQuestionIndex: repairIndex,
      formErrors: repairIndex === 0
        ? { productionServerConnectionId: "运行位置状态已经变化，请重新选择或验证" }
        : repairIndex === 1
          ? { productionConfigBinding: "正式配置已经变化，请补齐必填项" }
          : { productionDomain: validDomain(domain) && canonicalAddress !== binding.desiredAddress && canonicalAddress !== binding.address ? "地址草稿与环境绑定不一致，请重新保存" : "请重新确认正式访问地址" },
    };
    persistState();
    render();
    focusAfterRender(repairIndex === 0 ? '[data-action="select-recommended-runtime"]' : repairIndex === 1 ? '[data-action="use-production-config"]' : '[data-field="productionDomain"]');
    showToast("正式发布条件已经变化，已带你回到需要修复的位置");
    return false;
  }
  return true;
}

function returnFromConfigPicker() {
  if (state.recoveryIssue?.type === "config-missing" && state.configTarget === "production") {
    const task = activeTask();
    const missingKeys = missingRequiredConfigKeys("production");
    if (!task || task.kind !== "production") {
      showToast("原正式任务已经不存在，不能凭空创建新的执行记录");
      return;
    }
    if (missingKeys.length) {
      state = { ...state, page: "release", sheet: null, configTarget: null, formErrors: {} };
      persistState();
      render();
      focusMainHeading();
      showToast(`仍缺少 ${missingKeys.join("、")}，原任务和已完成结果都已保留`);
      return;
    }
    const recoveryPatch = resumeProductionRecoveryPatch(task, state, "validate-config");
    state = { ...state, configTarget: null, ...recoveryPatch };
    persistState();
    render();
    focusMainHeading();
    showToast(`正式配置已经补齐，任务 #${task.id} 从原停点继续`);
    return;
  }
  const nextSheet = state.configTarget === "staging" ? "setup" : state.configTarget === "production" ? "production-setup" : null;
  state = { ...state, sheet: nextSheet, formErrors: {}, configTarget: nextSheet ? state.configTarget : null };
  persistState();
  render();
  if (nextSheet) focusAfterRender(state.configTarget === "staging" ? '[data-action="use-config-center"]' : '[data-action="use-production-config"]');
}

function preparedConfigProfileEdit(sourceState = state) {
  const profileId = sourceState.configEditProfileId;
  const currentProfile = sourceState.configProfiles.find((profile) => profile.id === profileId);
  if (!currentProfile) return null;
  const valueChanged = Boolean(String(sourceState.formValues.editConfigValue ?? "").trim());
  const nextRevision = valueChanged ? (currentProfile.revision ?? 0) + 1 : currentProfile.revision ?? 1;
  const profile = {
    ...currentProfile,
    label: sourceState.formValues.editConfigLabel.trim(),
    key: configProfileUsages(currentProfile.id, sourceState).length ? currentProfile.key : sourceState.formValues.editConfigKey.trim(),
    valueReady: valueChanged ? true : currentProfile.valueReady,
    revision: nextRevision,
  };
  return {
    profile,
    valueChanged,
    configProfiles: sourceState.configProfiles.map((item) => item.id === profileId ? profile : item),
  };
}

function startConfigApplicationPatch(task, pending, sourceState = state) {
  if (!configApplicationReady(task, pending, sourceState)) {
    throw new Error("配置应用目标、在线版本、运行位置或当前任务状态不允许开始执行");
  }
  const attempts = sourceState.attemptsByTaskId[task.id] ?? [];
  const binding = sourceState.environmentBindings[pending.environment];
  const server = sourceState.serverConnections[binding.serverConnectionId];
  const attempt = attemptRecord(task.id, attempts.length + 1, {
    stage: "apply-config",
    inputSnapshot: {
      targetVersionId: task.goalSnapshot.targetVersionId,
      environment: pending.environment,
      profileId: pending.profileId,
      profileRevision: pending.profileRevision,
      previousConfigRevision: pending.previousRevision,
      serverConnectionId: binding.serverConnectionId,
      serverConnectionRevision: serverConnectionReady(binding.serverConnectionId, sourceState) ? `${binding.serverConnectionId}@${server.revision ?? 1}` : null,
      configProfileIds: [...(binding.configProfileIds ?? [])],
      configProfileRevisions: desiredConfigRevisions(pending.environment, sourceState),
      configRevision: configRevision(pending.environment, sourceState),
      previousAppliedConfigRevisions: { ...(binding.appliedConfigRevisions ?? {}) },
      address: binding.address,
    },
  });
  return {
    activeTaskId: task.id,
    tasksById: { ...sourceState.tasksById, [task.id]: { ...task, status: "running" } },
    attemptsByTaskId: { ...sourceState.attemptsByTaskId, [task.id]: [...attempts, attempt] },
  };
}

function openSheet(sheet, returnFocusAction, patch = {}) {
  setState({ ...patch, sheet, returnFocusAction });
}

function closeSheet() {
  if (state.sheet === "credential-help") {
    setState({ sheet: state.credentialHelpReturnSheet ?? "setup", credentialHelpTarget: null, credentialHelpReturnSheet: null, formErrors: {} });
    return;
  }
  if (state.sheet === "config-picker" && ["staging", "production"].includes(state.configTarget)) {
    returnFromConfigPicker();
    return;
  }
  if (state.sheet === "connection-edit") {
    if (state.connectionReturnSheet === "task-recovery") {
      setState({ page: "release", sheet: null, connectionServerStep: "credentials", connectionDraftServerId: null, connectionReturnSheet: null, sourceVerificationReturnSheet: null, sourceVerificationResumeAction: null, formErrors: {} });
      focusMainHeading();
      return;
    }
    if (state.connectionReturnSheet === "release") {
      setState({ page: "release", sheet: null, connectionServerStep: "credentials", connectionDraftServerId: null, connectionReturnSheet: null, sourceVerificationReturnSheet: null, sourceVerificationResumeAction: null, formErrors: {} });
      focusMainHeading();
      return;
    }
    setState({ sheet: state.connectionReturnSheet ?? "connections", connectionServerStep: "credentials", connectionDraftServerId: null, connectionReturnSheet: null, sourceVerificationReturnSheet: null, sourceVerificationResumeAction: null, formErrors: {} });
    return;
  }
  if (state.sheet === "address-edit") {
    const returnFocusAction = state.returnFocusAction;
    state = { ...state, sheet: null, returnFocusAction: null, formValues: { ...state.formValues, addressDraftDomain: "" }, formErrors: {} };
    persistState();
    render();
    if (returnFocusAction) focusAfterRender(`[data-action="${returnFocusAction}"]`);
    return;
  }
  if (state.sheet === "source-verification") {
    const returnFocusAction = state.returnFocusAction;
    state = {
      ...state,
      sheet: null,
      returnFocusAction: null,
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
    };
    persistState();
    render();
    if (returnFocusAction) focusAfterRender(`[data-action="${returnFocusAction}"]`);
    return;
  }
  const returnFocusAction = state.returnFocusAction;
  state = { ...state, sheet: null, returnFocusAction: null };
  persistState();
  render();
  if (returnFocusAction) {
    window.setTimeout(() => {
      document.querySelector(`[data-action="${returnFocusAction}"]`)?.focus();
    }, 0);
  }
}

function openProduction(versionId, returnFocusAction, intent = "publish") {
  const environmentBindings = environmentBindingsWithUniqueConfigMatches("production", state);
  const preparedState = { ...state, environmentBindings };
  const currentTask = openMutationTask(preparedState);
  const resumable = currentTask?.kind === "production"
    && currentTask.status === "waiting-input"
    && currentTask.goalSnapshot.targetVersionId === versionId;
  if (currentTask && !resumable) {
    showToast(currentTask.kind === "conflict"
      ? "检测到多条未结束任务，请先到任务中心处理状态冲突"
      : `任务 #${currentTask.id} 还没有结束，请先完成或处理该任务`);
    return;
  }
  if (productionBusy() && !resumable) {
    setState({ page: "release", sheet: null });
    showToast("已有正式任务正在处理，请先完成当前任务");
    return;
  }
  if (!isVersionQualified(versionId, preparedState)) {
    showToast("只有测试通过并保留验证证据的版本才能发布");
    return;
  }
  const resumeIndex = resumable ? state.productionQuestionIndex : 0;
  const task = resumable
    ? currentTask
    : createProductionTask({ id: state.nextTaskId, versionId, intent }, preparedState);
  if (!task) {
    showToast("版本记录不完整，未创建正式任务");
    return;
  }
  openSheet(productionSetupReady(preparedState) ? "production" : "production-setup", returnFocusAction, {
    environmentBindings,
    productionVersionId: versionId,
    productionIntent: intent,
    productionQuestionIndex: resumeIndex,
    ...(resumable ? {} : activateTaskPatch(task)),
    nextTaskId: resumable ? state.nextTaskId : state.nextTaskId + 1,
  });
}

function handleAction(action, target) {
  if (action === "start-first-test") {
    const slotOwner = openMutationTask(state);
    if (slotOwner && slotOwner.kind !== "test") {
      showToast(`任务 #${slotOwner.id} 还在处理，请先完成后再生成测试版`);
      return;
    }
    let sourcePatch = {};
    let executionState = state;
    if (codeAccountConnectionReady(state) && !sourceBindingReady(state)) {
      sourcePatch = verifyCurrentSourceBinding(state);
      executionState = { ...state, ...sourcePatch };
      if (!sourceBindingReady(executionState)) {
        openSheet("source-verification", "start-first-test", {
          ...sourcePatch,
          sourceVerificationReturnSheet: null,
          sourceVerificationResumeAction: "start-first-test",
        });
        return;
      }
    }
    const setupNeeds = setupNeedsFromFacts(executionState);
    if (!setupNeeds.length) {
      const preparedTask = stagingSetupTaskPatch(executionState);
      if (!preparedTask) {
        showToast(expectedSourceIdentity(executionState)
          ? "还没有读取到完整代码版本，请重新扫描项目后再生成测试版"
          : "还没有识别当前项目的代码仓库，请重新扫描项目");
        return;
      }
      const { task, patch: taskPatch } = preparedTask;
      const taskState = { ...executionState, ...taskPatch };
      setState({
        scenario: "deploying",
        setupNeeds: [],
        ...sourcePatch,
        ...taskPatch,
        ...startNextAttemptPatch(task, {}, taskState),
      });
      focusMainHeading();
      return;
    }
    const preparedTask = sourceBindingReady(executionState)
      ? stagingSetupTaskPatch(executionState)
      : { task: null, patch: {} };
    if (!preparedTask) {
      showToast("当前还有其他上线任务，不能同时修改测试环境");
      return;
    }
    openSheet("setup", "continue-setup", {
      scenario: "needs",
      setupNeeds,
      questionIndex: 0,
      resetNotice: false,
      ...sourcePatch,
      ...preparedTask.patch,
    });
    return;
  }
  if (action === "continue-setup") {
    let sourcePatch = {};
    let executionState = state;
    if (codeAccountConnectionReady(state) && !sourceBindingReady(state)) {
      sourcePatch = verifyCurrentSourceBinding(state);
      executionState = { ...state, ...sourcePatch };
      if (!sourceBindingReady(executionState)) {
        openSheet("source-verification", action, {
          ...sourcePatch,
          sourceVerificationReturnSheet: null,
          sourceVerificationResumeAction: "continue-setup",
        });
        return;
      }
    }
    if (sourceBindingReady(executionState)) {
      const preparedTask = stagingSetupTaskPatch(executionState);
      if (!preparedTask) {
        showToast("当前还有其他上线任务，不能同时修改测试环境");
        return;
      }
      sourcePatch = { ...sourcePatch, ...preparedTask.patch };
      executionState = { ...executionState, ...preparedTask.patch };
    }
    openSheet("setup", action, {
      ...sourcePatch,
      ...(sourcePatch.sourceBinding ? { setupNeeds: setupNeedsFromFacts(executionState), questionIndex: 0 } : {}),
    });
    return;
  }
  if (action === "open-code-credential-help" || action === "open-registry-credential-help") {
    setState({
      sheet: "credential-help",
      credentialHelpTarget: action === "open-code-credential-help" ? "code" : "registry",
      credentialHelpReturnSheet: state.sheet ?? "setup",
      formErrors: {},
    });
    return;
  }
  if (action === "open-credential-console") {
    showToast(`已打开${state.credentialHelpTarget === "code" ? "代码平台授权页" : "镜像仓库控制台"}（原型）`);
    return;
  }
  if (action === "return-to-setup-question") {
    setState({ sheet: state.credentialHelpReturnSheet ?? "setup", credentialHelpTarget: null, credentialHelpReturnSheet: null, formErrors: {} });
    return;
  }
  if (action === "save-setup-question") {
    const questions = activeSetupQuestions();
    const question = questions[state.questionIndex];
    if (!question || !validateSetupQuestion(question)) return;
    const currentSetupTask = openMutationTask(state);
    if (question.key !== "permission"
      && (!currentSetupTask
        || currentSetupTask.kind !== "test"
        || currentSetupTask.projectId !== state.currentProjectId
        || currentSetupTask.environment !== "staging")) {
      showToast("当前生成测试版任务已经不存在；未保存这一步，请重新开始");
      return;
    }
    if (question.key === "destination" && state.setupNeedReasons.destination === "new") {
      setState({
        setupNeedReasons: { ...state.setupNeedReasons, destination: "server-identity" },
        serverFingerprintConfirmed: false,
        serverCapability: null,
        serverChangeConfirmed: false,
        serverImpactPreviewed: false,
        serverConnectionStatus: "checking",
        formValues: { ...state.formValues, serverPassword: "", serverSshKey: "" },
        formErrors: {},
      });
      showToast("登录信息验证通过，请确认服务器身份");
      return;
    }
    if (question.key === "destination" && state.setupNeedReasons.destination === "server-identity") {
      setState({
        setupNeedReasons: { ...state.setupNeedReasons, destination: "server-capability" },
        serverCapability: "clean",
        serverChangeConfirmed: false,
        serverImpactPreviewed: false,
        formErrors: {},
      });
      showToast("服务器身份已确认，能力检查完成");
      return;
    }
    const secretField = { permission: "publishToken", "version-storage": "versionPassword", destination: "serverPassword", config: "adminPassword" }[question.key];
    const formValues = secretField ? { ...state.formValues, [secretField]: "" } : state.formValues;
    let configProfiles = state.configProfiles;
    let stagingConfigProfileIds = state.environmentBindings.staging.configProfileIds;
    if (question.key === "config") {
      const adminProfileId = projectOwnedConfigProfileId("staging", "ADMIN_PASSWORD");
      const existingAdminProfile = state.configProfiles.find((profile) => profile.id === adminProfileId);
      if (existingAdminProfile && existingAdminProfile.projectId !== state.currentProjectId) {
        showToast("管理员配置归属与当前项目不一致；未保存这一步");
        return;
      }
      configProfiles = state.configProfiles.some((profile) => profile.id === adminProfileId)
        ? state.configProfiles.map((profile) => profile.id === adminProfileId ? { ...profile, valueReady: true, revision: (profile.revision ?? 0) + 1 } : profile)
        : [...state.configProfiles, { id: adminProfileId, label: "管理员初始密码", key: "ADMIN_PASSWORD", valueReady: true, revision: 1, environmentScope: "staging", projectId: state.currentProjectId, scope: "project" }];
      stagingConfigProfileIds = [...new Set([...stagingConfigProfileIds, adminProfileId])];
    }
    const environmentBindings = question.key === "destination"
      ? {
          ...state.environmentBindings,
          staging: {
            ...state.environmentBindings.staging,
            serverConnectionId: state.setupNeedReasons.destination === "multiple"
              ? state.stagingServerConnectionId
              : state.stagingSelectedRuntime === "alternative" ? "server-staging-alternative" : "server-staging-shared",
          },
        }
      : question.key === "config"
        ? {
            ...state.environmentBindings,
            staging: { ...state.environmentBindings.staging, configProfileIds: stagingConfigProfileIds },
          }
        : state.environmentBindings;
    const selectedServerId = environmentBindings.staging.serverConnectionId;
    const selectedCapability = state.serverCapability ?? state.serverConnections[selectedServerId]?.capability ?? "compatible";
    const serverConnections = question.key === "destination" && selectedServerId
      ? {
          ...state.serverConnections,
          [selectedServerId]: {
            ...state.serverConnections[selectedServerId],
            label: state.serverConnections[selectedServerId]?.label ?? "已验证运行服务器",
            host: String(formValues.testHost ?? "").trim() || state.serverConnections[selectedServerId]?.host,
            fingerprint: state.serverConnections[selectedServerId]?.fingerprint ?? "SHA256:K7m9…pQ2x",
            verified: true,
            capability: selectedCapability,
            revision: (state.serverConnections[selectedServerId]?.revision ?? 0) + 1,
            verifiedAt: "刚刚",
          },
        }
      : state.serverConnections;
    const serverEvidenceByRevision = question.key === "destination" && selectedServerId
      ? serverEvidenceLedgerWith(selectedServerId, serverConnections[selectedServerId], state)
      : state.serverEvidenceByRevision;
    const codePatch = question.key === "permission"
      ? verifiedCodeAndCurrentSourcePatch(state)
      : {
          codeConnectionStatus: state.codeConnectionStatus,
          codeConnection: state.codeConnection,
          sourceBinding: state.sourceBinding,
          sourceEvidenceById: state.sourceEvidenceById,
        };
    if (question.key === "permission" && !sourceBindingReady({ ...state, ...codePatch })) {
      setState({
        ...codePatch,
        formValues,
        sheet: "source-verification",
        sourceVerificationReturnSheet: "setup",
        sourceVerificationResumeAction: "continue-setup",
        formErrors: {},
      });
      showToast("账号已保存，但还不能读取当前项目；其他上线信息暂不需要填写");
      return;
    }
    const { codeConnectionStatus, codeConnection, sourceBinding, sourceEvidenceById } = codePatch;
    const registryConnectionStatus = question.key === "version-storage" ? "ready" : state.registryConnectionStatus;
    const registryEndpoint = question.key === "version-storage"
      ? canonicalRegistryEndpoint(formValues.registryEndpoint)
      : null;
    const registryConnection = question.key === "version-storage"
      ? {
          id: state.registryConnection?.id ?? "registry-primary",
          endpoint: registryEndpoint,
          pushEndpoint: registryEndpoint,
          pullEndpoint: registryEndpoint,
          accountLabel: String(formValues.versionAccount).trim(),
          verifiedAt: "刚刚",
          revision: (state.registryConnection?.revision ?? 0) + 1,
          readable: true,
        }
      : state.registryConnection;
    const registryConnectionsById = registryConnection
      ? { ...state.registryConnectionsById, [registryConnection.id]: { ...registryConnection } }
      : state.registryConnectionsById;
    const registryEvidenceByRevision = registryConnection
      ? registryEvidenceLedgerWith(registryConnection, state)
      : state.registryEvidenceByRevision;
    const activeRegistryConnectionId = registryConnection?.id ?? state.activeRegistryConnectionId;
    const serverConnectionStatus = question.key === "destination" ? "ready" : state.serverConnectionStatus;
    const postQuestionState = {
      ...state,
      formValues,
      environmentBindings,
      serverConnections,
      serverEvidenceByRevision,
      configProfiles,
      codeConnectionStatus,
      codeConnection,
      sourceBinding,
      sourceEvidenceById,
      registryConnectionStatus,
      registryConnection,
      registryConnectionsById,
      registryEvidenceByRevision,
      activeRegistryConnectionId,
      serverConnectionStatus,
    };
    const preparedTask = stagingSetupTaskPatch(postQuestionState);
    if (!preparedTask) {
      showToast("当前项目仓库或任务状态已经变化；未保存这一步，请重新开始");
      return;
    }
    const { task, patch: activationPatch } = preparedTask;
    if (state.questionIndex < questions.length - 1) {
      setState({ questionIndex: state.questionIndex + 1, sheet: "setup", formValues, environmentBindings, serverConnections, serverEvidenceByRevision, configProfiles, codeConnectionStatus, codeConnection, sourceBinding, sourceEvidenceById, registryConnectionStatus, registryConnection, registryConnectionsById, registryEvidenceByRevision, activeRegistryConnectionId, serverConnectionStatus, formErrors: {}, ...activationPatch });
    } else {
      const executionState = {
        ...postQuestionState,
        ...activationPatch,
      };
      setState({
        questionIndex: questions.length,
        setupNeeds: [],
        sheet: null,
        returnFocusAction: null,
        scenario: "deploying",
        recoveryTask: false,
        formValues,
        environmentBindings,
        serverConnections,
        serverEvidenceByRevision,
        configProfiles,
        codeConnectionStatus,
        codeConnection,
        sourceBinding,
        sourceEvidenceById,
        registryConnectionStatus,
        registryConnection,
        registryConnectionsById,
        registryEvidenceByRevision,
        activeRegistryConnectionId,
        serverConnectionStatus,
        formErrors: {},
        ...activationPatch,
        ...startNextAttemptPatch(task, {}, executionState),
      });
      focusMainHeading();
    }
    return;
  }
  if (action === "close-sheet") {
    closeSheet();
    return;
  }
  if (action === "finish-deployment") {
    const completed = activeTask();
    if (!completed || completed.kind !== "test" || completed.status !== "running") {
      showToast("没有正在执行的测试任务，未创建完成记录");
      return;
    }
    const isDailyUpdate = state.recoveryTask || Boolean(state.currentProductionVersionId) || state.hasHistory;
    const resultVersionId = currentTestVersionId();
    const runningAttempt = runningAttemptForTask(completed);
    if (!runningAttempt) {
      showToast("测试任务没有可完成的进行中执行，未生成版本");
      return;
    }
    if (!executionEnvironmentInputStillMatches(completed, runningAttempt)) {
      showToast("测试任务执行期间运行位置、配置或地址发生变化，未生成版本");
      return;
    }
    const frozenRegistryId = runningAttempt.inputSnapshot.registryConnectionId;
    const frozenRegistryEvidence = state.registryEvidenceByRevision?.[runningAttempt.inputSnapshot.registryConnectionRevision];
    const frozenRegistry = registryConnectionFromEvidence(frozenRegistryEvidence);
    if (!frozenRegistry
      || frozenRegistry.id !== frozenRegistryId
      || frozenRegistry.readable === false
      || registryConnectionRevision(frozenRegistry) !== runningAttempt.inputSnapshot.registryConnectionRevision) {
      showToast("这次执行使用的版本仓库连接已不可读取，未生成版本");
      return;
    }
    const frozenStagingAddress = runningAttempt.inputSnapshot.address;
    const succeededAttempt = runningAttempt
      ? { ...runningAttempt, status: "succeeded", stage: "completed", endedAt: "刚刚" }
      : null;
    const completedAttempt = succeededAttempt
      ? {
          ...succeededAttempt,
          outputSnapshot: {
            versionId: resultVersionId,
            artifactRefs: canonicalArtifactRefs(fixtureArtifactRefs(resultVersionId, state, frozenRegistry)),
            environmentSnapshot: succeededEnvironmentSnapshot(succeededAttempt, {
              address: frozenStagingAddress,
              healthCheck: "passed",
            }),
          },
        }
      : null;
    const completedTask = { ...completed, status: "completed", resultVersionId };
    const appliedStagingBinding = bindingWithAppliedAttemptConfig("staging", completedAttempt, state);
    if (!appliedStagingBinding) {
      showToast("测试环境的配置绑定在执行中发生变化，请重新确认后重试当前任务");
      return;
    }
    const environmentBindings = {
      ...state.environmentBindings,
      staging: {
        ...appliedStagingBinding,
        address: frozenStagingAddress,
      },
    };
    const tasksById = { ...state.tasksById, [completed.id]: completedTask };
    const attemptsByTaskId = {
      ...state.attemptsByTaskId,
      [completed.id]: (state.attemptsByTaskId[completed.id] ?? []).map((attempt) => attempt.id === completedAttempt?.id ? completedAttempt : attempt),
    };
    const completedState = { ...state, environmentBindings, tasksById, attemptsByTaskId };
    const version = versionFromSucceededAttempt({
      versionId: resultVersionId,
      displayName: CURRENT_TEST_VERSION,
      task: completedTask,
      attempt: completedAttempt,
      sourceState: completedState,
    });
    if (!version) {
      showToast("任务结果缺少完整代码或产物记录，未创建版本");
      return;
    }
    const completedVersionState = {
      ...completedState,
      versionsById: { ...state.versionsById, [resultVersionId]: version },
    };
    setState({
      scenario: isDailyUpdate ? "update" : "available",
      recoveryTask: false,
      testOpened: false,
      activeTaskId: null,
      tasksById,
      attemptsByTaskId,
      environmentBindings,
      automationRule: syncedAutomationRule(completedState, "enabled"),
      versionsById: completedVersionState.versionsById,
      versionValidations: {
        ...state.versionValidations,
        [resultVersionId]: stagingValidationEvidence(resultVersionId, "pending", completedVersionState),
      },
    });
    focusMainHeading();
    return;
  }
  if (action === "open-test-site") {
    setState({ testOpened: true });
    showToast("测试地址已在新窗口打开（原型）");
    return;
  }
  if (action === "confirm-test-passed") {
    if (!state.testOpened) return;
    const resultVersionId = currentTestVersionId();
    const previousEvidence = state.versionValidations[resultVersionId];
    if (!versionRecord(resultVersionId)) return;
    setState({
      versionValidations: {
        ...state.versionValidations,
        [resultVersionId]: { ...previousEvidence, versionId: resultVersionId, outcome: "passed", checkedAt: "刚刚" },
      },
    });
    return;
  }
  if (action === "mark-test-issue") {
    const resultVersionId = currentTestVersionId();
    const previousEvidence = state.versionValidations[resultVersionId];
    if (!versionRecord(resultVersionId)) return;
    setState({
      testOpened: true,
      versionValidations: {
        ...state.versionValidations,
        [resultVersionId]: { ...previousEvidence, versionId: resultVersionId, outcome: "issue", checkedAt: "刚刚" },
      },
    });
    showToast("已记录：这个版本暂不发布，等待下一次代码更新");
    return;
  }
  if (action === "go-versions") {
    setState({ page: "versions" });
    return;
  }
  if (action === "publish-current") {
    openProduction(currentTestVersionId(), action);
    return;
  }
  if (action === "publish-history") {
    openProduction(HISTORY_VERSION_ID, action);
    return;
  }
  if (action === "rollback-history") {
    openProduction(HISTORY_VERSION_ID, action, "rollback");
    return;
  }
  if (action === "resume-production-setup") {
    openProduction(state.productionVersionId, action, state.productionIntent);
    return;
  }
  if (action === "cancel-production-preparation") {
    const task = activeTask();
    if (task?.kind !== "production" || task.status !== "waiting-input") return;
    setState({
      sheet: null,
      returnFocusAction: null,
      page: "versions",
      activeTaskId: null,
      tasksById: taskPatch(task, { status: "canceled" }),
      productionVersionId: null,
      productionQuestionIndex: 0,
      productionIntent: "publish",
    });
    focusMainHeading();
    showToast("这次正式任务已放弃，没有产生远程变更");
    return;
  }
  if (action === "previous-production-question") {
    setState({ productionQuestionIndex: Math.max(0, state.productionQuestionIndex - 1), sheet: "production-setup", formErrors: {} });
    return;
  }
  if (action === "save-production-question") {
    const question = productionSetupQuestions[state.productionQuestionIndex];
    if (!question || !validateProductionQuestion(question)) return;
    let environmentBindings = state.environmentBindings;
    let configProfiles = state.configProfiles;
    if (question.key === "production-destination") {
      environmentBindings = {
        ...state.environmentBindings,
        production: {
          ...state.environmentBindings.production,
          serverConnectionId: state.productionSelectedRuntime === "alternative"
            ? state.productionServerConnectionId
            : state.environmentBindings.staging.serverConnectionId,
        },
      };
    }
    if (question.key === "production-config") {
      const boundAdminProfile = configProfileForKey("production", "ADMIN_PASSWORD");
      if (!boundAdminProfile) {
        const adminProfileId = projectOwnedConfigProfileId("production", "ADMIN_PASSWORD");
        const existingAdminProfile = state.configProfiles.find((profile) => profile.id === adminProfileId);
        if (existingAdminProfile && existingAdminProfile.projectId !== state.currentProjectId) {
          showToast("管理员配置归属与当前项目不一致；未保存这一步");
          return;
        }
        configProfiles = state.configProfiles.some((profile) => profile.id === adminProfileId)
          ? state.configProfiles.map((profile) => profile.id === adminProfileId
            ? { ...profile, valueReady: true, revision: (profile.revision ?? 0) + 1 }
            : profile)
          : [...state.configProfiles, { id: adminProfileId, label: "管理员正式密码", key: "ADMIN_PASSWORD", valueReady: true, revision: 1, environmentScope: "production", projectId: state.currentProjectId, scope: "project" }];
        environmentBindings = {
          ...state.environmentBindings,
          production: {
            ...state.environmentBindings.production,
            configProfileIds: [...new Set([...state.environmentBindings.production.configProfileIds, adminProfileId])],
          },
        };
      }
    }
    if (question.key === "production-address") {
      environmentBindings = {
        ...state.environmentBindings,
        production: { ...state.environmentBindings.production, desiredAddress: `https://${state.formValues.productionDomain}` },
      };
    }
    if (state.productionQuestionIndex < productionSetupQuestions.length - 1) {
      setState({
        productionQuestionIndex: state.productionQuestionIndex + 1,
        sheet: "production-setup",
        environmentBindings,
        configProfiles,
        formValues: question.key === "production-config"
          ? { ...state.formValues, productionAdminPassword: "" }
          : state.formValues,
        formErrors: {},
      });
    } else {
      const task = activeTask();
      if (!task || task.kind !== "production") {
        showToast("正式任务已经不存在，请回到版本页重新发起");
        return;
      }
      const executionState = { ...state, environmentBindings, configProfiles };
      if (!isVersionQualified(task.goalSnapshot?.targetVersionId, executionState)) {
        showToast("目标版本的测试验证事实已经变化，请回到版本页重新核对");
        return;
      }
      if (!productionExecutionReady(task, executionState)) {
        showToast("正式运行位置、必填配置或访问地址尚未准备好，请回到对应步骤核对");
        return;
      }
      const executionPatch = startNextAttemptPatch(task, {}, executionState);
      setState({
        productionQuestionIndex: productionSetupQuestions.length,
        productionAddressReady: false,
        sheet: null,
        returnFocusAction: null,
        page: "release",
        productionTask: { id: task.id, attemptId: `attempt-${task.id}-${taskAttempts(task.id).length + 1}`, targetVersionId: task.goalSnapshot.targetVersionId, intent: task.intent },
        ...executionPatch,
        scenario: "update",
        environmentBindings,
        configProfiles,
        formErrors: {},
      });
      focusMainHeading();
    }
    return;
  }
  if (action === "create-production-task") {
    if (state.productionTask || state.productionServiceDeployed) return;
    if (!productionSetupReady()) {
      setState({ sheet: "production-setup", productionQuestionIndex: 0, formErrors: {} });
      showToast("正式发布条件已经变化，请重新确认运行位置、配置和地址");
      return;
    }
    const task = activeTask();
    if (!task || task.kind !== "production") {
      showToast("正式任务已经不存在，请回到版本页重新发起");
      return;
    }
    if (!isVersionQualified(task.goalSnapshot?.targetVersionId)) {
      showToast("目标版本的测试验证事实已经变化，请回到版本页重新核对");
      return;
    }
    if (!productionExecutionReady(task)) {
      showToast("正式运行位置、必填配置或访问地址尚未准备好，请重新确认");
      return;
    }
    const executionPatch = startNextAttemptPatch(task);
    setState({
      sheet: null,
      returnFocusAction: null,
      page: "release",
      productionTask: { id: task.id, attemptId: `attempt-${task.id}-${taskAttempts(task.id).length + 1}`, targetVersionId: task.goalSnapshot.targetVersionId, intent: task.intent },
      ...executionPatch,
      scenario: "update",
    });
    focusMainHeading();
    return;
  }
  if (action === "finish-production") {
    const task = activeTask();
    if (!task || task.kind !== "production" || task.status !== "running") {
      showToast("没有正在执行的正式任务，未创建完成记录");
      return;
    }
    const runningAttempt = runningAttemptForTask(task);
    if (!runningAttempt
      || state.productionTask?.id !== task.id
      || state.productionTask?.attemptId !== runningAttempt.id
      || state.productionTask?.targetVersionId !== task.goalSnapshot.targetVersionId) {
      showToast("正式任务没有匹配的进行中执行，未提升正式版本");
      return;
    }
    const completedAttempt = runningAttempt ? { ...runningAttempt, status: "succeeded", stage: "completed", endedAt: "刚刚" } : null;
    const targetVersion = versionRecord(task.goalSnapshot.targetVersionId);
    if (!targetVersion
      || !isVersionQualified(task.goalSnapshot.targetVersionId)
      || !artifactRefsEqual(completedAttempt?.inputSnapshot?.artifactRefs, targetVersion.artifactRefs)) {
      showToast("正式任务的目标版本或不可变产物记录不一致，已停止提升正式版本");
      return;
    }
    if (!productionAttemptInputStillMatches(task, completedAttempt)) {
      showToast("正式任务执行期间运行位置、配置或地址发生变化，已停止提升正式版本");
      return;
    }
    const appliedProductionBinding = bindingWithAppliedAttemptConfig("production", completedAttempt);
    if (!appliedProductionBinding) {
      showToast("正式环境的配置绑定在执行中发生变化，请重新确认后重试当前任务");
      return;
    }
    const completedVersionId = task.goalSnapshot.targetVersionId;
    const frozenDesiredAddress = completedAttempt.inputSnapshot.desiredAddress;
    const frozenReleaseAddress = frozenDesiredAddress ?? completedAttempt.inputSnapshot.activeAddress;
    if (state.productionAddressReady) {
      const desiredDomain = frozenReleaseAddress?.replace(/^https?:\/\//, "") ?? null;
      setState({
        productionTask: null,
        productionComplete: true,
        addressCheckTarget: null,
        currentProductionVersionId: completedVersionId,
        productionActiveDomain: desiredDomain ?? state.productionActiveDomain,
        environmentBindings: {
          ...state.environmentBindings,
          production: frozenReleaseAddress
            ? { ...appliedProductionBinding, address: frozenReleaseAddress, desiredAddress: null }
            : appliedProductionBinding,
        },
        page: "release",
        ...completeActiveTaskPatch(task),
      });
    } else {
      const attempts = taskAttempts(task.id);
      setState({
        productionTask: null,
        productionServiceDeployed: true,
        productionComplete: false,
        addressCheckState: "pending",
        addressCheckPreviousState: null,
        addressLastCheckedAt: null,
        addressCheckTarget: frozenReleaseAddress,
        currentProductionVersionId: completedVersionId,
        page: "release",
        environmentBindings: {
          ...state.environmentBindings,
          production: appliedProductionBinding,
        },
        activeTaskId: task.id,
        tasksById: taskPatch(task, { status: "waiting-address" }),
        attemptsByTaskId: attemptsPatch(task.id, attempts.map((attempt, index) => index === attempts.length - 1 ? { ...attempt, status: "succeeded", stage: "service-deployed", endedAt: "刚刚" } : attempt)),
      });
    }
    focusMainHeading();
    return;
  }
  if (action === "finish-address-check") {
    if (state.addressCheckState !== "propagating") {
      setState({ addressCheckState: "propagating", addressLastCheckedAt: "刚刚" });
      return;
    }
    const completed = activeTask();
    const deploymentAttempt = completed?.kind === "production" ? latestAttempt(completed.id) : null;
    if (completed?.kind === "production" && (!state.productionServiceDeployed
      || deploymentAttempt?.status !== "succeeded"
      || state.currentProductionVersionId !== completed.goalSnapshot.targetVersionId)) {
      showToast("正式版服务结果不完整，未把地址检查标记为发布完成");
      return;
    }
    const addressTarget = state.addressCheckTarget
      ?? state.environmentBindings.production.desiredAddress
      ?? deploymentAttempt?.inputSnapshot?.desiredAddress
      ?? deploymentAttempt?.inputSnapshot?.activeAddress;
    const nextActiveDomain = String(addressTarget ?? state.formValues.productionDomain ?? "")
      .replace(/^https?:\/\//, "")
      .trim()
      .toLowerCase();
    setState({
      productionServiceDeployed: false,
      productionAddressReady: true,
      productionActiveDomain: nextActiveDomain,
      productionComplete: Boolean(completed),
      lastCompletion: { kind: completed ? "deployment" : "address", at: "刚刚", environment: "production" },
      currentProductionVersionId: completed?.goalSnapshot?.targetVersionId ?? state.currentProductionVersionId,
      page: "release",
      addressCheckState: "ready",
      addressCheckPreviousState: "propagating",
      addressLastCheckedAt: "刚刚",
      addressCheckTarget: null,
      environmentBindings: {
        ...state.environmentBindings,
        production: {
          ...state.environmentBindings.production,
          address: `https://${nextActiveDomain}`,
          desiredAddress: null,
        },
      },
      ...(completed ? completeActiveTaskPatch(completed) : { activeTaskId: null }),
    });
    focusMainHeading();
    return;
  }
  if (action === "simulate-address-offline") {
    setState({ addressCheckPreviousState: state.addressCheckState ?? "pending", addressCheckState: "offline", addressLastCheckedAt: "刚刚（网络中断）" });
    return;
  }
  if (action === "copy-dns-record") {
    const dnsRecord = dnsRecordFor(productionDomain(), productionRuntimeAddress());
    const record = `${dnsRecord.domain} ${dnsRecord.type} ${dnsRecord.value}`;
    navigator.clipboard?.writeText(record).catch(() => {});
    showToast("解析记录已复制");
    return;
  }
  if (action === "edit-production-address") {
    openSheet("address-edit", action, { formValues: { ...state.formValues, addressDraftDomain: productionDomain() }, formErrors: {} });
    return;
  }
  if (action === "save-production-address") {
    const value = String(state.formValues.addressDraftDomain ?? "").trim().toLowerCase();
    if (!value || !validDomain(value)) {
      applyValidationErrors({ addressDraftDomain: value ? "只填写有效域名，例如 app.example.com" : "请填写正式访问地址" }, '[data-field="addressDraftDomain"]');
      return;
    }
    const formValues = { ...state.formValues, productionDomain: value, addressDraftDomain: "" };
    const environmentBindings = {
      ...state.environmentBindings,
      production: { ...state.environmentBindings.production, desiredAddress: `https://${value}` },
    };
    const blockedRouteTask = state.recoveryIssue?.type === "route-conflict" ? activeTask() : null;
    if (blockedRouteTask?.kind === "production") {
      const executionState = { ...state, formValues, environmentBindings };
      const recoveryPatch = resumeProductionRecoveryPatch(blockedRouteTask, executionState, "activate-route");
      if (!recoveryPatch) {
        showToast("原正式任务已经不存在，请回到版本页重新发起");
        return;
      }
      setState({
        ...recoveryPatch,
        formValues,
        environmentBindings,
        productionAddressReady: false,
        formErrors: {},
      });
      focusMainHeading();
      showToast(`正式地址已更换，任务 #${blockedRouteTask.id} 正在检查新路由`);
      return;
    }
    setState({
      sheet: null,
      returnFocusAction: null,
      page: "release",
      productionVersionId: state.productionVersionId ?? state.currentProductionVersionId,
      productionAddressReady: false,
      productionComplete: false,
      productionServiceDeployed: true,
      addressCheckTarget: `https://${value}`,
      formValues,
      environmentBindings,
      addressCheckState: "pending",
      addressCheckPreviousState: null,
      addressLastCheckedAt: null,
      formErrors: {},
    });
    focusMainHeading();
    return;
  }
  if (action === "go-release-center") {
    setState({ page: "release", sheet: null });
    return;
  }
  if (action === "open-recovery-task") {
    openSheet("recovery", action);
    return;
  }
  if (action === "resume-authorization-task") {
    const task = activeTask();
    if (!task || task.kind !== "test" || task.status !== "waiting") {
      showToast("原测试任务已经不存在，不能凭空继续");
      return;
    }
    if (!sourceBindingReady()) {
      const sourcePatch = verifyCurrentSourceBinding(state);
      const executionState = { ...state, ...sourcePatch };
      if (!sourceBindingReady(executionState)) {
        openSheet("source-verification", action, {
          ...sourcePatch,
          sourceVerificationReturnSheet: "release",
          sourceVerificationResumeAction: action,
        });
        return;
      }
      setState({ ...sourcePatch });
    }
    const executionState = state;
    setState({
      scenario: "deploying",
      recoveryTask: true,
      recoveryIssue: null,
      page: "release",
      sheet: null,
      returnFocusAction: null,
      ...startNextAttemptPatch(task, { stage: "read-result" }, executionState),
    });
    focusMainHeading();
    showToast(`任务 #${task.id} 已从原停点继续`);
    return;
  }
  if (action === "retry-production-start") {
    const task = activeTask();
    const recoveryPatch = resumeProductionRecoveryPatch(task, state, "health-check");
    if (!recoveryPatch) {
      showToast("原正式任务已经不存在，不能凭空开始新的部署");
      return;
    }
    setState(recoveryPatch);
    focusMainHeading();
    showToast(`任务 #${task.id} 正在重新启动同一版本，当前正式版保持在线`);
    return;
  }
  if (action === "repair-task-config") {
    const task = activeTask();
    if (!task || task.kind !== "production") return;
    setState({ sheet: "config-picker", configTarget: "production", returnFocusAction: action, formErrors: {} });
    return;
  }
  if (action === "repair-task-server") {
    const task = activeTask();
    const serverId = state.recoveryIssue?.serverConnectionId ?? state.environmentBindings.production.serverConnectionId;
    if (!task || task.kind !== "production" || !serverId) return;
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "server",
      connectionServerScope: "production",
      connectionServerStep: "revalidate",
      connectionDraftServerId: serverId,
      connectionReturnSheet: "task-recovery",
      returnFocusAction: action,
      formErrors: {},
    });
    return;
  }
  if (action === "review-route-conflict") {
    openSheet("recovery", action);
    return;
  }
  if (action === "confirm-route-takeover") {
    const task = activeTask();
    const issue = state.recoveryIssue;
    const recoveryPatch = resumeProductionRecoveryPatch(task, state, "activate-route");
    if (!recoveryPatch || issue?.type !== "route-conflict" || issue.ownerType !== "abcdeploy-project" || !issue.ownerProjectId) return;
    setState({ ...recoveryPatch, productionAddressReady: true });
    focusMainHeading();
    showToast(`已确认只接管 ${issue.host}，任务 #${task.id} 正在校验并热加载路由`);
    return;
  }
  if (action === "save-recovery") {
    if (!validateRequiredFields(["replacementToken"])) return;
    const previous = activeTask();
    if (!previous || previous.kind !== "test") {
      showToast("原任务已经不存在，不能凭空创建新的执行记录");
      return;
    }
    const codePatch = verifiedCodeAndCurrentSourcePatch(state, "ready", null, state.replacementSourceProbeOutcome);
    const recoveredState = { ...state, ...codePatch };
    setState({
      sheet: null,
      returnFocusAction: null,
      scenario: "deploying",
      recoveryTask: true,
      ...codePatch,
      ...startNextAttemptPatch(previous, { stage: "read-result" }, recoveredState),
      formValues: { ...state.formValues, replacementToken: "" },
      formErrors: {},
    });
    focusMainHeading();
    return;
  }
  if (action === "use-config-center") {
    setState({ sheet: "config-picker", configTarget: "staging", formErrors: {} });
    return;
  }
  if (action === "use-production-config") {
    setState({ sheet: "config-picker", configTarget: "production", formErrors: {} });
    return;
  }
  if (action === "return-from-config") {
    returnFromConfigPicker();
    return;
  }
  if (action === "bind-config-profile") {
    if (state.configTarget === "library") {
      showToast("配置条目已保留，可以在项目环境中引用");
      return;
    }
    const profileId = target?.dataset.profileId ?? (state.configTarget === "production" ? "config-production-provider" : "config-staging-provider");
    const profile = state.configProfiles.find((item) => item.id === profileId);
    if (!configProfileAvailableToProject(profile)) {
      showToast("这个配置只属于另一个项目，当前项目不能引用");
      return;
    }
    const environmentKey = state.configTarget === "production" ? "production" : "staging";
    const otherProfileIds = state.environmentBindings[environmentKey].configProfileIds.filter((id) => {
      const existing = state.configProfiles.find((item) => item.id === id);
      return existing && existing.key !== profile.key;
    });
    const appliedConfigRevisions = Object.fromEntries(Object.entries(state.environmentBindings[environmentKey].appliedConfigRevisions ?? {})
      .filter(([id]) => otherProfileIds.includes(id)));
    const selectedAppliedRevision = state.environmentBindings[environmentKey].appliedConfigRevisions?.[profileId];
    state = {
      ...state,
      environmentBindings: {
        ...state.environmentBindings,
        [environmentKey]: {
          ...state.environmentBindings[environmentKey],
          configProfileIds: [...otherProfileIds, profileId],
          autoMatchBlockedKeys: (state.environmentBindings[environmentKey].autoMatchBlockedKeys ?? []).filter((key) => key !== profile.key),
          appliedConfigRevisions: {
            ...appliedConfigRevisions,
            ...(selectedAppliedRevision == null ? {} : { [profileId]: selectedAppliedRevision }),
          },
        },
      },
      formErrors: {},
    };
    persistState();
    returnFromConfigPicker();
    return;
  }
  if (action === "create-config-profile") {
    if (!validateRequiredFields(["newConfigLabel", "newConfigKey", "newConfigValue"])) return;
    const label = state.formValues.newConfigLabel.trim();
    const key = state.formValues.newConfigKey.trim();
    const profileId = `config-${Date.now()}`;
    const bindsToEnvironment = ["production", "staging"].includes(state.configTarget);
    state = {
      ...state,
      configProfiles: [...state.configProfiles, {
        id: profileId,
        label,
        key,
        valueReady: true,
        revision: 1,
        environmentScope: ["staging", "production"].includes(state.configTarget) ? state.configTarget : null,
      }],
      environmentBindings: bindsToEnvironment
        ? {
            ...state.environmentBindings,
            [state.configTarget]: {
              ...state.environmentBindings[state.configTarget],
              configProfileIds: [
                ...state.environmentBindings[state.configTarget].configProfileIds.filter((id) => {
                  const existing = state.configProfiles.find((item) => item.id === id);
                  return existing && existing.key !== key;
                }),
                profileId,
              ],
              autoMatchBlockedKeys: (state.environmentBindings[state.configTarget].autoMatchBlockedKeys ?? []).filter((blockedKey) => blockedKey !== key),
              appliedConfigRevisions: Object.fromEntries(Object.entries(state.environmentBindings[state.configTarget].appliedConfigRevisions ?? {}).filter(([id]) => {
                const existing = state.configProfiles.find((item) => item.id === id);
                return existing && existing.key !== key;
              })),
            },
          }
        : state.environmentBindings,
      formValues: { ...state.formValues, newConfigLabel: "", newConfigKey: "", newConfigValue: "" },
      formErrors: {},
    };
    persistState();
    if (state.configTarget === "library") {
      render();
      showToast(`已新建配置“${label}”`);
    } else {
      returnFromConfigPicker();
    }
    return;
  }
  if (action === "edit-config-profile") {
    const profile = state.configProfiles.find((item) => item.id === target?.dataset.profileId);
    if (!profile) return;
    const usages = configProfileUsages(profile.id);
    const selectedUsage = usages.find((usage) => usage.projectId === state.currentProjectId) ?? usages[0] ?? null;
    setState({
      sheet: "config-edit",
      configEditProfileId: profile.id,
      configEditProjectId: selectedUsage?.projectId ?? null,
      configEditEnvironment: selectedUsage?.environment ?? null,
      formValues: { ...state.formValues, editConfigLabel: profile.label, editConfigKey: profile.key, editConfigValue: "" },
      formErrors: {},
    });
    return;
  }
  if (action === "back-to-config-library") {
    setState({ sheet: "config-picker", configTarget: "library", configEditProfileId: null, configEditProjectId: null, configEditEnvironment: null, pendingConfigApplication: null, formErrors: {} });
    return;
  }
  if (action === "select-config-edit-environment") {
    const environment = target?.dataset.configEnvironment;
    const projectId = target?.dataset.projectId;
    if (!["staging", "production"].includes(environment) || !state.projects.some((project) => project.id === projectId)) return;
    setState({ configEditProjectId: projectId, configEditEnvironment: environment, formErrors: {} });
    return;
  }
  if (action === "save-config-profile-edit") {
    if (!validateRequiredFields(["editConfigLabel", "editConfigKey"])) return;
    const prepared = preparedConfigProfileEdit();
    if (!prepared) return;
    setState({
      sheet: "config-picker",
      configTarget: "library",
      configEditProfileId: null,
      configEditProjectId: null,
      configEditEnvironment: null,
      configProfiles: prepared.configProfiles,
      formValues: { ...state.formValues, editConfigLabel: "", editConfigKey: "", editConfigValue: "" },
      formErrors: {},
    });
    showToast("配置条目已更新，引用关系保持不变");
    return;
  }
  if (action === "save-and-apply-config") {
    if (!validateRequiredFields(["editConfigLabel", "editConfigKey"])) return;
    const projectId = state.configEditProjectId;
    const environment = state.configEditEnvironment;
    const prepared = preparedConfigProfileEdit();
    if (!prepared || projectId !== state.currentProjectId || !["staging", "production"].includes(environment)) return;
    const binding = state.environmentBindings[environment];
    const appliedRevision = binding.appliedConfigRevisions?.[prepared.profile.id] ?? null;
    if (!prepared.valueChanged && appliedRevision != null && prepared.profile.revision <= appliedRevision) {
      showToast(`${configEnvironmentLabel(environment)}已经在使用当前修订，没有需要应用的变化`);
      return;
    }
    const slotOwner = openMutationTask(state);
    if (slotOwner) {
      showToast(slotOwner.kind === "conflict"
        ? "检测到多条未结束任务，请先到任务中心处理状态冲突"
        : `任务 #${slotOwner.id} 还在处理，请先完成后再应用配置`);
      return;
    }
    if (environment === "production" && productionBusy()) {
      showToast("正式环境仍有发布或地址操作，请完成后再应用配置");
      return;
    }
    const previousRevision = appliedRevision;
    setState({
      sheet: "config-apply-confirm",
      configProfiles: prepared.configProfiles,
      pendingConfigApplication: {
        profileId: prepared.profile.id,
        projectId,
        environment,
        profileRevision: prepared.profile.revision,
        previousRevision,
        taskId: null,
      },
      formValues: { ...state.formValues, editConfigValue: "" },
      formErrors: {},
    });
    return;
  }
  if (action === "cancel-config-application") {
    setState({ sheet: "config-picker", configTarget: "library", configEditProfileId: null, configEditProjectId: null, configEditEnvironment: null, pendingConfigApplication: null, formErrors: {} });
    showToast("配置已保存到配置中心，运行环境保持原修订");
    return;
  }
  if (action === "confirm-config-application") {
    const pending = state.pendingConfigApplication;
    const profile = state.configProfiles.find((item) => item.id === pending?.profileId);
    if (!pending || !profile) return;
    const slotOwner = openMutationTask(state);
    if (slotOwner) {
      showToast(slotOwner.kind === "conflict"
        ? "检测到多条未结束任务，请先到任务中心处理状态冲突"
        : `任务 #${slotOwner.id} 还在处理，配置尚未应用`);
      return;
    }
    if (pending.environment === "production" && productionBusy()) {
      showToast("正式环境仍有发布或地址操作，配置尚未应用");
      return;
    }
    const taskId = state.nextTaskId;
    const onlineVersionId = onlineVersionIdForEnvironment(pending.environment, state);
    if (!onlineVersionId) {
      showToast(`${configEnvironmentLabel(pending.environment)}还没有可验证的在线版本，配置已保存但不能直接应用`);
      return;
    }
    const baseTask = taskRecord({ id: taskId, kind: "config", status: "waiting", target: `${profile.label} 修订 ${pending.profileRevision}`, intent: "apply-config", environment: pending.environment, projectId: state.currentProjectId });
    const task = {
      ...baseTask,
      goalSnapshot: {
        ...baseTask.goalSnapshot,
        targetVersionId: onlineVersionId ?? null,
        profileId: profile.id,
        profileRevision: pending.profileRevision,
        previousConfigRevision: pending.previousRevision,
        expectedResult: "config-applied",
      },
    };
    const nextPending = { ...pending, taskId };
    const sourceState = { ...state, tasksById: { ...state.tasksById, [taskId]: task }, pendingConfigApplication: nextPending };
    setState({
      sheet: "config-apply-progress",
      nextTaskId: taskId + 1,
      pendingConfigApplication: nextPending,
      ...startConfigApplicationPatch(task, nextPending, sourceState),
    });
    return;
  }
  if (action === "finish-config-application") {
    const pending = state.pendingConfigApplication;
    const task = activeTask();
    if (!pending || pending.projectId !== state.currentProjectId || !task || task.id !== pending.taskId || task.kind !== "config") return;
    const runningAttempt = runningAttemptForTask(task);
    if (!runningAttempt || !configAttemptInputStillMatches(task, pending, runningAttempt)) {
      showToast("配置应用的在线版本、运行位置或输入已经变化，未推进环境修订");
      return;
    }
    const succeededAttempt = runningAttempt ? { ...runningAttempt, status: "succeeded", stage: "completed", endedAt: "刚刚" } : null;
    if (!succeededAttempt) return;
    const appliedBinding = bindingWithAppliedAttemptConfig(pending.environment, succeededAttempt);
    if (!appliedBinding) {
      showToast(`${configEnvironmentLabel(pending.environment)}的配置绑定已变化，请重新发起应用`);
      return;
    }
    const appliedRevision = succeededAttempt.inputSnapshot.configProfileRevisions?.[pending.profileId] ?? null;
    setState({
      sheet: "config-picker",
      configTarget: "library",
      configEditProfileId: null,
      configEditProjectId: null,
      configEditEnvironment: null,
      pendingConfigApplication: null,
      lastConfigApplication: { ...pending, profileRevision: appliedRevision, completedAt: "刚刚" },
      environmentBindings: {
        ...state.environmentBindings,
        [pending.environment]: appliedBinding,
      },
      ...completeActiveTaskPatch(task),
    });
    showToast(`${configEnvironmentLabel(pending.environment)}已经使用配置修订 ${appliedRevision}`);
    return;
  }
  if (action === "unbind-config-profile") {
    const profileId = state.configEditProfileId;
    const profile = state.configProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    const projectId = state.configEditProjectId;
    const environment = state.configEditEnvironment;
    if (!projectId || !["staging", "production"].includes(environment)) return;
    const bindingPatch = updateProjectEnvironmentBinding(state, projectId, environment, (environmentBinding) => {
      const appliedConfigRevisions = { ...(environmentBinding.appliedConfigRevisions ?? {}) };
      delete appliedConfigRevisions[profileId];
      return {
        ...environmentBinding,
        configProfileIds: environmentBinding.configProfileIds.filter((id) => id !== profileId),
        autoMatchBlockedKeys: [...new Set([...(environmentBinding.autoMatchBlockedKeys ?? []), profile.key])],
        appliedConfigRevisions,
      };
    });
    if (!bindingPatch) return;
    const usageLabel = projectEnvironmentBindingLabel(projectId, environment);
    setState({
      sheet: "config-picker",
      configTarget: "library",
      configEditProfileId: null,
      configEditProjectId: null,
      configEditEnvironment: null,
      ...bindingPatch,
      formValues: { ...state.formValues, editConfigLabel: "", editConfigKey: "", editConfigValue: "" },
      formErrors: {},
    });
    showToast(`只解除了“${profile.label}”在${usageLabel}的引用，其他项目和环境不受影响`);
    return;
  }
  if (action === "select-recommended-runtime") {
    const inProduction = state.sheet === "production-setup" || state.configTarget === "production";
    setState(inProduction
      ? { productionSelectedRuntime: "recommended", formErrors: {} }
      : { stagingSelectedRuntime: "recommended", stagingServerConnectionId: target?.dataset.serverId ?? "server-staging-shared", formErrors: {} });
    showToast("已选择推荐的运行位置");
    return;
  }
  if (action === "show-alternative-server") {
    const useRecommended = state.productionSelectedRuntime === "alternative";
    setState({ productionSelectedRuntime: useRecommended ? "recommended" : "alternative", productionServerConnectionId: useRecommended ? state.productionServerConnectionId : null, formErrors: {} });
    showToast(useRecommended ? "已返回推荐运行位置" : "请选择一个已验证的正式运行位置");
    return;
  }
  if (action === "select-production-server") {
    const serverId = target?.dataset.serverId;
    if (!serverId || !state.serverConnections[serverId]) return;
    setState({ productionSelectedRuntime: "alternative", productionServerConnectionId: serverId, formErrors: {} });
    showToast(`已选择 ${state.serverConnections[serverId].label}`);
    return;
  }
  if (action === "select-alternative-runtime") {
    const inProduction = state.sheet === "production-setup" || state.configTarget === "production";
    setState(inProduction
      ? { productionSelectedRuntime: "alternative" }
      : { stagingSelectedRuntime: "alternative", stagingServerConnectionId: target?.dataset.serverId ?? "server-staging-alternative", formErrors: {} });
    showToast("已选择独立运行位置；正式保存前还可以更改");
    return;
  }
  if (action === "confirm-server-change") {
    setState({ serverChangeConfirmed: true, formErrors: {} });
    showToast("已允许准备服务器共享访问服务");
    return;
  }
  if (action === "select-server-auth") {
    const method = target?.dataset.authMethod;
    if (!['password', 'ssh-key'].includes(method)) return;
    setState({ serverAuthMethod: method, formErrors: {} });
    return;
  }
  if (action === "confirm-server-fingerprint") {
    setState({ serverFingerprintConfirmed: true, formErrors: {} });
    showToast("已确认服务器身份");
    return;
  }
  if (action === "recheck-server-capability") {
    setState({ serverCapability: "compatible", serverChangeConfirmed: false, serverImpactPreviewed: false, formErrors: {} });
    showToast("已重新检查：现有访问服务可以安全复用（原型）");
    return;
  }
  if (action === "copy-server-preparation") {
    navigator.clipboard?.writeText("请安装 Docker Engine 和 Docker Compose 插件，并确认当前登录用户可以运行 docker info。完成后回到 ABCDeploy 重新检查。").catch(() => {});
    showToast("服务器准备说明已复制");
    return;
  }
  if (action === "replace-server-details") {
    setState({
      setupNeedReasons: { ...state.setupNeedReasons, destination: "new" },
      serverCapability: null,
      serverChangeConfirmed: false,
      serverImpactPreviewed: false,
      serverFingerprintConfirmed: false,
      serverConnectionStatus: "missing",
      formValues: { ...state.formValues, testHost: "", testUser: "", serverPassword: "", serverSshKey: "" },
      formErrors: {},
    });
    focusAfterRender('[data-field="testHost"]');
    return;
  }
  if (action === "open-source-permissions") {
    showToast("已打开代码平台权限页面（原型）");
    return;
  }
  if (action === "change-source-account") {
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "code",
      connectionReturnSheet: state.sourceVerificationReturnSheet ?? "release",
      formErrors: {},
    });
    return;
  }
  if (action === "recheck-source-binding") {
    const sourcePatch = verifyCurrentSourceBinding(state);
    if (!sourcePatch.sourceBinding?.verified) {
      setState({ ...sourcePatch, sheet: "source-verification", formErrors: {} });
      showToast("当前账号仍然无法读取这个项目，尚未创建任务");
      return;
    }
    const returnSheet = state.sourceVerificationReturnSheet;
    const resumeAction = state.sourceVerificationResumeAction;
    setState({
      ...sourcePatch,
      sheet: returnSheet,
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      formErrors: {},
    });
    showToast("当前项目仓库已经核对，不需要重新授权账号");
    if (resumeAction) handleAction(resumeAction);
    return;
  }
  if (action === "show-connections") {
    openSheet("connections", action);
    return;
  }
  if (action === "replace-code-connection") {
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "code",
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      formErrors: {},
    });
    return;
  }
  if (action === "edit-registry-connection") {
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "registry",
      formValues: {
        ...state.formValues,
        connectionRegistryEndpoint: state.registryConnection?.endpoint ?? "",
        connectionRegistryAccount: state.registryConnection?.accountLabel ?? "",
        connectionToken: "",
      },
      formErrors: {},
    });
    return;
  }
  if (action === "edit-server-connection") {
    const scope = target?.dataset.serverScope === "production" ? "production" : "staging";
    const hasBinding = Boolean(state.environmentBindings[scope].serverConnectionId);
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "server",
      connectionServerScope: scope,
      connectionServerStep: hasBinding ? "revalidate" : "credentials",
      connectionDraftServerId: hasBinding ? state.environmentBindings[scope].serverConnectionId : null,
      connectionReturnSheet: null,
      formErrors: {},
    });
    return;
  }
  if (action === "add-production-server") {
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "server",
      connectionServerScope: "production",
      connectionServerStep: "credentials",
      connectionDraftServerId: null,
      connectionReturnSheet: "production-setup",
      serverCapability: null,
      serverChangeConfirmed: false,
      serverImpactPreviewed: false,
      formValues: { ...state.formValues, connectionHost: "", connectionUser: "", connectionServerSecret: "" },
      formErrors: {},
    });
    return;
  }
  if (action === "back-to-connections") {
    const returnSheet = state.connectionReturnSheet ?? "connections";
    if (returnSheet === "task-recovery") {
      setState({ page: "release", sheet: null, connectionServerStep: "credentials", connectionDraftServerId: null, connectionReturnSheet: null, sourceVerificationReturnSheet: null, sourceVerificationResumeAction: null, formErrors: {} });
      focusMainHeading();
      return;
    }
    setState({
      page: returnSheet === "release" ? "release" : state.page,
      sheet: returnSheet === "release" ? null : returnSheet,
      connectionServerStep: "credentials",
      connectionDraftServerId: null,
      connectionReturnSheet: null,
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      formErrors: {},
    });
    return;
  }
  if (action === "save-code-connection") {
    if (!validateRequiredFields(["connectionToken"])) return;
    const codePatch = verifiedCodeAccessPatch(state);
    const currentTask = activeTask();
    const resumesAuthorizationBlockedTask = currentTask?.kind === "test"
      && currentTask.status === "waiting"
      && state.recoveryIssue?.type === "authorization"
      && !state.sourceVerificationResumeAction
      && state.connectionReturnSheet !== "automation";
    if (resumesAuthorizationBlockedTask) {
      const sourcePatch = verifyCurrentSourceBinding({ ...state, ...codePatch }, state.replacementSourceProbeOutcome);
      const recoveredState = { ...state, ...codePatch, ...sourcePatch };
      if (!sourceBindingReady(recoveredState)) {
        setState({
          ...codePatch,
          ...sourcePatch,
          sourceProbeOutcome: state.replacementSourceProbeOutcome,
          sheet: "source-verification",
          connectionReturnSheet: null,
          sourceVerificationReturnSheet: "release",
          sourceVerificationResumeAction: "resume-authorization-task",
          formValues: { ...state.formValues, connectionToken: "" },
          formErrors: {},
        });
        showToast("新账号仍然不能读取当前项目，原任务没有新增执行");
        return;
      }
      setState({
        ...codePatch,
        ...sourcePatch,
        setupNeeds: state.setupNeeds.filter((need) => need !== "permission"),
        scenario: "deploying",
        recoveryTask: true,
        recoveryIssue: null,
        page: "release",
        sheet: null,
        returnFocusAction: null,
        connectionReturnSheet: null,
        sourceVerificationReturnSheet: null,
        sourceVerificationResumeAction: null,
        ...startNextAttemptPatch(currentTask, { stage: "read-result" }, recoveredState),
        formValues: { ...state.formValues, connectionToken: "" },
        formErrors: {},
      });
      focusMainHeading();
      showToast("新授权已验证，任务 #24 已从原停点继续");
      return;
    }
    const returnSheet = state.connectionReturnSheet ?? "connections";
    const resumeAction = state.sourceVerificationResumeAction;
    setState({
      ...codePatch,
      sourceProbeOutcome: state.replacementSourceProbeOutcome,
      automationRule: state.automationRule,
      recoveryIssue: state.recoveryIssue?.type === "authorization" && resumeAction
        ? { ...state.recoveryIssue, type: "authorization-resolved" }
        : state.recoveryIssue,
      setupNeeds: state.setupNeeds.filter((need) => need !== "permission"),
      page: returnSheet === "release" ? "release" : state.page,
      sheet: returnSheet === "release" ? null : returnSheet,
      connectionReturnSheet: null,
      sourceVerificationReturnSheet: null,
      sourceVerificationResumeAction: null,
      formValues: { ...state.formValues, connectionToken: "" },
      formErrors: {},
    });
    showToast(resumeAction
      ? "新授权已验证，继续刚才的操作"
      : returnSheet === "automation" ? "授权已经更新；当前项目将在下一次规则操作时核对" : "账号授权已更新；当前项目会在下一次操作时核对");
    if (resumeAction) handleAction(resumeAction);
    return;
  }
  if (action === "save-resource-connection") {
    const isServer = state.connectionEditTarget === "server";
    const revalidatingServer = isServer && state.connectionServerStep === "revalidate";
    if (isServer && !revalidatingServer) {
      if (!validateRequiredFields(["connectionHost", "connectionUser", "connectionServerSecret"])) return;
      const serverId = state.connectionDraftServerId ?? `server-resource-${Date.now()}`;
      setState({
        sheet: "connection-edit",
        connectionServerStep: "identity",
        connectionDraftServerId: serverId,
        serverConnectionStatus: "checking",
        serverConnections: {
          ...state.serverConnections,
          [serverId]: {
            label: "自定义运行服务器",
            host: state.formValues.connectionHost.trim(),
            user: state.formValues.connectionUser.trim(),
            verified: false,
            capability: null,
            revision: 0,
          },
        },
        formValues: { ...state.formValues, connectionServerSecret: "" },
        formErrors: {},
      });
      return;
    }
    if (isServer) {
      if (!validateRequiredFields(["connectionToken"])) return;
      const serverId = state.environmentBindings[state.connectionServerScope].serverConnectionId;
      setState({
        sheet: "connection-edit",
        connectionServerStep: "capability",
        connectionDraftServerId: serverId,
        serverCapability: state.serverConnections[serverId]?.capability ?? "compatible",
        serverChangeConfirmed: false,
        serverImpactPreviewed: false,
        formValues: { ...state.formValues, connectionToken: "" },
        formErrors: {},
      });
      return;
    }
    const requiredRegistryFields = ["connectionRegistryEndpoint", "connectionRegistryAccount", "connectionToken"];
    if (!validateRequiredFields(requiredRegistryFields)) return;
    const endpoint = canonicalRegistryEndpoint(state.formValues.connectionRegistryEndpoint);
    if (!endpoint) {
      applyValidationErrors({ connectionRegistryEndpoint: "请填写不含账号、密码或参数的有效版本仓库地址" }, '[data-field="connectionRegistryEndpoint"]');
      return;
    }
    const currentEndpoint = canonicalRegistryEndpoint(state.registryConnection?.endpoint);
    const sameRegistryEndpoint = Boolean(state.registryConnection && endpoint === currentEndpoint);
    const registryConnection = {
      id: sameRegistryEndpoint ? state.registryConnection.id : `registry-${Object.keys(state.registryConnectionsById).length + 1}`,
      endpoint,
      pushEndpoint: endpoint,
      pullEndpoint: endpoint,
      accountLabel: state.formValues.connectionRegistryAccount.trim(),
      verifiedAt: "刚刚",
      revision: sameRegistryEndpoint ? (state.registryConnection.revision ?? 0) + 1 : 1,
      readable: true,
      writable: true,
    };
    const registryEvidenceByRevision = registryEvidenceLedgerWith(registryConnection, state);
    setState({
      sheet: state.connectionReturnSheet ?? "connections",
      registryConnectionStatus: "ready",
      registryConnection,
      activeRegistryConnectionId: registryConnection.id,
      registryConnectionsById: { ...state.registryConnectionsById, [registryConnection.id]: registryConnection },
      registryEvidenceByRevision,
      setupNeeds: state.setupNeeds.filter((need) => need !== "version-storage"),
      connectionReturnSheet: null,
      formValues: { ...state.formValues, connectionToken: "" },
      formErrors: {},
    });
    showToast("版本保存连接的推送和读取能力已验证");
    return;
  }
  if (action === "confirm-resource-server-identity") {
    const serverId = state.connectionDraftServerId;
    if (!serverId || !state.serverConnections[serverId]) return;
    setState({
      sheet: "connection-edit",
      connectionServerStep: "capability",
      serverFingerprintConfirmed: true,
      serverCapability: state.connectionReturnSheet === "existing-adopt" ? "compatible" : "clean",
      serverConnections: {
        ...state.serverConnections,
        [serverId]: { ...state.serverConnections[serverId], fingerprint: "SHA256:R4d8…mN6c" },
      },
      serverChangeConfirmed: false,
      serverImpactPreviewed: false,
      formErrors: {},
    });
    showToast("服务器身份已确认，运行能力检查完成");
    return;
  }
  if (action === "save-resource-server") {
    const scope = state.connectionServerScope;
    const serverId = state.connectionDraftServerId;
    const connection = state.serverConnections[serverId];
    if (!connection) return;
    const returnSheet = state.connectionReturnSheet ?? "connections";
    if (returnSheet === "existing-adopt" && state.serverCapability !== "compatible") {
      applyValidationErrors({ serverCapability: "接入已有部署只能复用已存在且可验证的访问服务，不会初始化或改造服务器" }, `[data-server-capability="${state.serverCapability === "missing-runtime" ? "missing-runtime" : state.serverCapability === "clean" ? "clean" : "conflict"}"]`);
      return;
    }
    if (state.serverCapability === "missing-runtime") {
      applyValidationErrors({ serverCapability: "先按准备说明补齐运行组件，再重新检查" }, '[data-server-capability="missing-runtime"]');
      return;
    }
    if (["conflict", "adaptable"].includes(state.serverCapability)) {
      applyValidationErrors({ serverCapability: "现有访问服务无法安全复用，不能保存为可用运行位置" }, '[data-server-capability="conflict"]');
      return;
    }
    if (state.serverCapability === "clean" && !state.serverChangeConfirmed) {
      applyValidationErrors({ serverCapability: "请先确认允许系统初始化统一访问服务" }, '[data-action="confirm-server-change"]');
      return;
    }
    const verifiedConnection = { ...connection, verified: true, capability: state.serverCapability, revision: (connection.revision ?? 0) + 1, verifiedAt: "刚刚" };
    const serverEvidenceByRevision = serverEvidenceLedgerWith(serverId, verifiedConnection, state);
    const environmentBindings = returnSheet === "production-setup"
      ? state.environmentBindings
      : {
          ...state.environmentBindings,
          [scope]: { ...state.environmentBindings[scope], serverConnectionId: serverId },
        };
    const discoveryState = {
      ...state,
      environmentBindings,
      serverConnections: { ...state.serverConnections, [serverId]: verifiedConnection },
      serverEvidenceByRevision,
    };
    const discovery = returnSheet === "existing-adopt" ? discoveredDeploymentSnapshot(serverId, discoveryState) : null;
    if (returnSheet === "task-recovery") {
      const task = activeTask();
      const recoveryPatch = resumeProductionRecoveryPatch(task, discoveryState, "connect-server");
      if (!recoveryPatch) {
        showToast("原正式任务已经不存在，运行位置只保存为可复用连接");
      } else {
        setState({
          ...recoveryPatch,
          connectionServerStep: "credentials",
          connectionDraftServerId: null,
          connectionReturnSheet: null,
          serverConnectionStatus: "ready",
          serverConnections: discoveryState.serverConnections,
          serverEvidenceByRevision,
          environmentBindings,
          formValues: { ...state.formValues, connectionHost: "", connectionUser: "", connectionServerSecret: "" },
          formErrors: {},
        });
        focusMainHeading();
        showToast(`运行位置已经重新验证，任务 #${task.id} 从连接停点继续`);
        return;
      }
    }
    setState({
      sheet: returnSheet,
      connectionServerStep: "credentials",
      connectionDraftServerId: null,
      connectionReturnSheet: null,
      serverConnectionStatus: "ready",
      serverConnections: {
        ...state.serverConnections,
        [serverId]: verifiedConnection,
      },
      serverEvidenceByRevision,
      existingDiscoverySnapshotId: returnSheet === "existing-adopt" ? discovery?.id ?? null : state.existingDiscoverySnapshotId,
      discoverySnapshotsById: discovery ? { ...state.discoverySnapshotsById, [discovery.id]: discovery } : state.discoverySnapshotsById,
      productionSelectedRuntime: returnSheet === "production-setup" ? "alternative" : state.productionSelectedRuntime,
      productionServerConnectionId: returnSheet === "production-setup" ? serverId : state.productionServerConnectionId,
      environmentBindings,
      formValues: { ...state.formValues, connectionHost: "", connectionUser: "", connectionServerSecret: "" },
      formErrors: {},
    });
    showToast(returnSheet === "existing-adopt" && !discovery
      ? "服务器连接可用，但与本机发现的已有部署不一致"
      : "服务器身份、运行前提和共享访问能力已验证");
    return;
  }
  if (action === "show-tasks") {
    openSheet("tasks", action);
    return;
  }
  if (action === "show-projects") {
    openSheet("projects", action);
    return;
  }
  if (action === "add-project") {
    const project = {
      id: "project-customer-portal",
      name: "客户门户",
      path: "/Users/demo/Documents/customer-portal",
      services: 2,
      serviceIds: ["api", "web"],
      repositoryScope: "demo/customer-portal",
    };
    const projects = state.projects.some((item) => item.id === project.id)
      ? state.projects
      : [...state.projects, project];
    const nextState = stateForProject(project.id, projects);
    if (!nextState) return;
    state = nextState;
    persistState();
    render();
    focusMainHeading();
    showToast("已识别“客户门户”；只显示这个项目还缺少的上线信息，没有创建部署任务");
    return;
  }
  if (action === "open-project") {
    const projectId = target?.dataset.projectId;
    const nextState = stateForProject(projectId);
    if (!nextState) return;
    clearProjectDeepLink();
    state = nextState;
    persistState();
    render();
    focusMainHeading();
    return;
  }
  if (action === "resume-active-task") {
    const task = activeTask();
    if (!task) return;
    if (task.kind === "config" && state.pendingConfigApplication?.taskId === task.id) {
      setState({ page: "release", sheet: "config-apply-progress", returnFocusAction: "show-tasks" });
      return;
    }
    if (state.recoveryIssue) {
      handleAction(recoveryIssuePresentation().action, target);
      return;
    }
    if (task.kind === "production") {
      setState({ page: "release", sheet: null, returnFocusAction: null });
    } else if (task.status === "waiting") {
      setState({ page: "release", sheet: "recovery", returnFocusAction: "show-tasks" });
      return;
    } else {
      setState({ page: "release", sheet: null, returnFocusAction: null });
    }
    focusMainHeading();
    return;
  }
  if (action === "show-config-center") {
    openSheet("config-picker", action, { configTarget: "library", formErrors: {} });
    return;
  }
  if (action === "manage-automation") {
    openSheet("automation", action);
    return;
  }
  if (action === "pause-automation-rule") {
    if (!codeAccountConnectionReady()) {
      setState({
        sheet: "connection-edit",
        connectionEditTarget: "code",
        connectionReturnSheet: "automation",
        sourceVerificationReturnSheet: "automation",
        sourceVerificationResumeAction: action,
        formErrors: {},
      });
      return;
    }
    const sourcePatch = sourceBindingReady() ? {} : verifyCurrentSourceBinding(state);
    const verifiedState = { ...state, ...sourcePatch };
    if (!sourceBindingReady(verifiedState)) {
      setState({ ...sourcePatch, sheet: "source-verification", sourceVerificationReturnSheet: "automation", sourceVerificationResumeAction: action });
      return;
    }
    setState({ ...sourcePatch, sheet: "automation", automationRule: synchronizedAutomationRuleFor("paused", verifiedState) });
    showToast("自动更新已暂停；现有测试版和历史版本保持不变");
    return;
  }
  if (action === "resume-automation-rule") {
    if (!codeAccountConnectionReady()) {
      setState({
        sheet: "connection-edit",
        connectionEditTarget: "code",
        connectionReturnSheet: "automation",
        sourceVerificationReturnSheet: "automation",
        sourceVerificationResumeAction: action,
        formErrors: {},
      });
      return;
    }
    const sourcePatch = sourceBindingReady() ? {} : verifyCurrentSourceBinding(state);
    const verifiedState = { ...state, ...sourcePatch };
    if (!sourceBindingReady(verifiedState)) {
      setState({ ...sourcePatch, sheet: "source-verification", sourceVerificationReturnSheet: "automation", sourceVerificationResumeAction: action });
      return;
    }
    setState({ ...sourcePatch, sheet: "automation", automationRule: synchronizedAutomationRuleFor("enabled", verifiedState) });
    showToast("自动更新已经恢复，下一次 main 更新会生成测试版");
    return;
  }
  if (action === "simulate-automation-failure") {
    const rule = state.automationRule;
    setState({
      sheet: "automation",
      automationRule: {
        ...rule,
        observedState: { ...rule.observedState, status: "paused", observedAt: "刚刚" },
        syncState: {
          ...rule.syncState,
          status: "failed",
          lastError: { code: "AD-AUTO-101", message: "代码平台暂时没有接受这次规则更新", at: "刚刚" },
        },
      },
    });
    return;
  }
  if (action === "repair-automation-rule") {
    if (!codeAccountConnectionReady()) {
      setState({
        sheet: "connection-edit",
        connectionEditTarget: "code",
        connectionReturnSheet: "automation",
        sourceVerificationReturnSheet: "automation",
        sourceVerificationResumeAction: action,
        formErrors: {},
      });
      return;
    }
    const sourcePatch = sourceBindingReady() ? {} : verifyCurrentSourceBinding(state);
    const verifiedState = { ...state, ...sourcePatch };
    if (!sourceBindingReady(verifiedState)) {
      setState({ ...sourcePatch, sheet: "source-verification", sourceVerificationReturnSheet: "automation", sourceVerificationResumeAction: action });
      return;
    }
    setState({ ...sourcePatch, sheet: "automation", automationRule: syncedAutomationRule(verifiedState, state.automationRule.desiredState.status) });
    showToast("同一条自动更新规则已经重新同步");
    return;
  }
  if (action === "reset-existing-deployment") {
    openSheet("existing-reset", action);
    return;
  }
  if (action === "confirm-reset-existing") {
    const currentProjectId = state.currentProjectId;
    const projects = state.projects;
    const projectWorkspacesById = { ...state.projectWorkspacesById };
    delete projectWorkspacesById[currentProjectId];
    const resetState = freshProjectState(currentProjectId, state);
    state = {
      ...resetState,
      projects,
      currentProjectId,
      projectWorkspacesById,
      sourceRevision: cloneStateValue(state.sourceRevision),
      localServices: cloneStateValue(state.localServices),
      localDependencies: cloneStateValue(state.localDependencies),
      resetNotice: true,
      page: "release",
      sheet: null,
    };
    persistState();
    render();
    focusMainHeading();
    return;
  }
  if (action === "adopt-existing-deployment") {
    if (codeAccountConnectionReady() && !sourceBindingReady()) {
      const sourcePatch = verifyCurrentSourceBinding(state);
      if (!sourcePatch.sourceBinding?.verified) {
        openSheet("source-verification", action, {
          ...sourcePatch,
          sourceVerificationReturnSheet: "existing-adopt",
          sourceVerificationResumeAction: action,
        });
        return;
      }
      openSheet("existing-adopt", action, { ...sourcePatch, formErrors: {} });
      return;
    }
    openSheet("existing-adopt", action, { formErrors: {} });
    return;
  }
  if (action === "connect-existing-server") {
    setState({
      sheet: "connection-edit",
      connectionEditTarget: "server",
      connectionServerScope: "staging",
      connectionServerStep: "credentials",
      connectionDraftServerId: null,
      connectionReturnSheet: "existing-adopt",
      serverCapability: null,
      serverChangeConfirmed: false,
      serverImpactPreviewed: false,
      formValues: { ...state.formValues, connectionHost: "203.0.113.10", connectionUser: "ubuntu", connectionServerSecret: "" },
      formErrors: {},
    });
    return;
  }
  if (action === "confirm-adopt-existing") {
    if (!codeAccountConnectionReady()) {
      if (!validateRequiredFields(["connectionToken"])) return;
      const codePatch = verifiedCodeAndCurrentSourcePatch(state);
      setState({
        sheet: "existing-adopt",
        ...codePatch,
        formValues: { ...state.formValues, connectionToken: "" },
        formErrors: {},
      });
      showToast("代码更新连接已验证，继续核对版本保存位置");
      return;
    }
    if (!sourceBindingReady()) {
      const sourcePatch = verifyCurrentSourceBinding(state);
      if (!sourcePatch.sourceBinding?.verified) {
        openSheet("source-verification", action, {
          ...sourcePatch,
          sourceVerificationReturnSheet: "existing-adopt",
          sourceVerificationResumeAction: action,
        });
        return;
      }
      setState({ sheet: "existing-adopt", ...sourcePatch, formErrors: {} });
      return;
    }
    if (!registryConnectionReady()) {
      if (!validateRequiredFields(["connectionRegistryEndpoint", "connectionRegistryAccount", "connectionToken"])) return;
      const endpoint = canonicalRegistryEndpoint(state.formValues.connectionRegistryEndpoint);
      if (!endpoint) {
        applyValidationErrors({ connectionRegistryEndpoint: "请填写不含账号、密码或参数的有效版本仓库地址" }, '[data-field="connectionRegistryEndpoint"]');
        return;
      }
      const registryConnection = {
        id: `registry-${Object.keys(state.registryConnectionsById).length + 1}`,
        endpoint,
        pushEndpoint: endpoint,
        pullEndpoint: endpoint,
        accountLabel: state.formValues.connectionRegistryAccount.trim(),
        verifiedAt: "刚刚",
        revision: 1,
        readable: true,
        writable: true,
      };
      setState({
        sheet: "existing-adopt",
        registryConnectionStatus: "ready",
        registryConnection,
        activeRegistryConnectionId: registryConnection.id,
        registryConnectionsById: { ...state.registryConnectionsById, [registryConnection.id]: registryConnection },
        registryEvidenceByRevision: registryEvidenceLedgerWith(registryConnection, state),
        formValues: { ...state.formValues, connectionToken: "" },
        formErrors: {},
      });
      showToast("版本保存连接已验证，继续核对运行服务器");
      return;
    }
    const serverId = state.environmentBindings.staging.serverConnectionId;
    if (!serverConnectionReady(serverId) || state.serverConnections[serverId]?.capability !== "compatible") {
      applyValidationErrors({ serverCapability: "请先验证已有部署所在的运行服务器" }, '[data-action="connect-existing-server"]');
      return;
    }
    const discovery = state.existingDiscoverySnapshotId ? state.discoverySnapshotsById[state.existingDiscoverySnapshotId] : null;
    if (!discovery?.observedAt
      || discovery.serverConnectionId !== serverId
      || discovery.serverConnectionRevision !== `${serverId}@${state.serverConnections[serverId]?.revision ?? 1}`
      || discovery.serverHost !== state.serverConnections[serverId]?.host
      || discovery.serverFingerprint !== state.serverConnections[serverId]?.fingerprint) {
      applyValidationErrors({ serverCapability: "当前服务器与本机发现的已有部署不一致，请核对正确服务器" }, '[data-action="connect-existing-server"]');
      return;
    }
    const importedProfiles = Object.entries(discovery.environments).flatMap(([environment, facts]) => facts.configRefs
      .filter((ref) => ref.valueReady)
      .map((ref) => ({
        id: `config-imported-${discovery.projectId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${environment}-${ref.key.toLowerCase().replaceAll("_", "-")}`,
        label: `${environment === "staging" ? "已接入测试" : "已接入正式"}${ref.key === "PROVIDER_API_KEY" ? "配置" : "管理员配置"}`,
        key: ref.key,
        environment,
        secretRef: ref.secretRef,
        projectId: discovery.projectId,
        scope: "project",
      })));
    let configProfiles = state.configProfiles.map((profile) => ({ ...profile }));
    for (const imported of importedProfiles) {
      const existingIndex = configProfiles.findIndex((profile) => profile.id === imported.id);
      const nextProfile = {
        ...(existingIndex >= 0 ? configProfiles[existingIndex] : {}),
        id: imported.id,
        label: imported.label,
        key: imported.key,
        valueReady: true,
        revision: existingIndex >= 0 ? (configProfiles[existingIndex].revision ?? 1) : 1,
        secretRef: imported.secretRef,
        projectId: imported.projectId,
        scope: imported.scope,
        environmentScope: imported.environment,
        sourceDiscoverySnapshotId: discovery.id,
      };
      if (existingIndex >= 0) configProfiles[existingIndex] = nextProfile;
      else configProfiles.push(nextProfile);
    }
    const environmentBindings = {
      staging: { serverConnectionId: serverId, configProfileIds: importedProfiles.filter((profile) => profile.environment === "staging").map((profile) => profile.id), appliedConfigRevisions: {}, address: discovery.environments.staging.address, desiredAddress: null },
      production: { serverConnectionId: serverId, configProfileIds: importedProfiles.filter((profile) => profile.environment === "production").map((profile) => profile.id), appliedConfigRevisions: {}, address: discovery.environments.production.address, desiredAddress: null },
    };
    for (const environment of ["staging", "production"]) {
      environmentBindings[environment].appliedConfigRevisions = Object.fromEntries(
        environmentBindings[environment].configProfileIds.map((profileId) => [profileId, configProfiles.find((profile) => profile.id === profileId)?.revision ?? 1]),
      );
    }
    const importedState = { ...state, environmentBindings, configProfiles };
    const imports = ["staging", "production"]
      .map((environment) => importVersionRecord(discovery, environment, importedState))
      .filter(Boolean);
    if (imports.length !== 2) {
      showToast("已有部署缺少完整代码或产物来源，暂不能建立版本记录");
      return;
    }
    const tasksById = { ...state.tasksById };
    const attemptsByTaskId = { ...state.attemptsByTaskId };
    const versionsById = { ...state.versionsById };
    for (const imported of imports) {
      tasksById[imported.task.id] = imported.task;
      attemptsByTaskId[imported.task.id] = [imported.attempt];
      versionsById[imported.version.id] = imported.version;
    }
    const completedImportState = { ...importedState, tasksById, attemptsByTaskId, versionsById };
    setState({
      sheet: null,
      returnFocusAction: null,
      existingManaged: true,
      serverConnectionStatus: "ready",
      activeTaskId: null,
      productionAddressReady: true,
      productionActiveDomain: discovery.environments.production.address.replace(/^https?:\/\//, ""),
      currentProductionVersionId: discovery.environments.production.versionId,
      hasHistory: true,
      tasksById,
      attemptsByTaskId,
      versionsById,
      versionValidations: {
        [discovery.environments.staging.versionId]: stagingValidationEvidence(discovery.environments.staging.versionId, "passed", completedImportState, {
          checkedAt: discovery.observedAt,
        }),
      },
      formValues: { ...state.formValues, productionDomain: discovery.environments.production.address.replace(/^https?:\/\//, ""), connectionToken: "" },
      environmentBindings,
      configProfiles,
      automationRule: syncedAutomationRule(completedImportState, "enabled"),
    });
    showToast("已建立管理关系，没有触发远程部署");
    return;
  }
  if (action === "local-start-all") {
    setState({ localServices: Object.fromEntries(projectServiceDefinitions().map(([id]) => [id, true])) });
    showToast("全部项目服务已启动");
    return;
  }
  if (action === "local-stop-all") {
    setState({ localServices: Object.fromEntries(projectServiceDefinitions().map(([id]) => [id, false])) });
    showToast("全部项目服务已停止");
    return;
  }
  if (action === "local-service-toggle") {
    const id = target?.dataset.localService;
    if (!id) return;
    setState({ localServices: { ...state.localServices, [id]: !state.localServices[id] } });
    showToast(`${id === "api" ? "后端服务" : id === "web" ? "网页服务" : "OCR 服务"}状态已更新`);
    return;
  }
  if (action === "local-dependency-toggle") {
    const id = target?.dataset.localDependency;
    if (!id) return;
    setState({ localDependencies: { ...state.localDependencies, [id]: !state.localDependencies[id] } });
    showToast("本机运行依赖状态已更新");
    return;
  }
  if (action === "edit-address") {
    if (activeTask()?.kind === "production" || state.productionServiceDeployed) {
      showToast("当前正式任务还没有结束，请先回到发布中心完成地址检查");
      return;
    }
    if (state.currentProductionVersionId || state.productionServiceDeployed) {
      openSheet("address-edit", action, { formValues: { ...state.formValues, addressDraftDomain: productionDomain() }, formErrors: {} });
    } else {
      showToast("正式地址会在第一次正式发布时设置");
    }
  }
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-action]");
  if (!target) return;
  const scenario = target.dataset.scenario;
  if (scenario) {
    state = scenarioDefaults(scenario);
    persistState();
    render();
    return;
  }
  const page = target.dataset.page;
  if (page) {
    setState({ page, sheet: null, returnFocusAction: null });
    return;
  }
  const serverCapability = target.dataset.serverCapability;
  if (serverCapability) {
    setState({ serverCapability, serverChangeConfirmed: false, serverImpactPreviewed: false, formErrors: {} });
    return;
  }
  if (target.dataset.action) handleAction(target.dataset.action, target);
});

app.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  const formErrors = { ...state.formErrors };
  delete formErrors[field];
  state = {
    ...state,
    formValues: { ...state.formValues, [field]: event.target.value },
    formErrors,
  };
  persistState();
});

app.addEventListener("change", (event) => {
  if (!event.target.hasAttribute("data-failure-variant")) return;
  const failureVariant = event.target.value;
  state = scenarioDefaults("failure", failureVariant);
  persistState();
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.sheet) {
    event.preventDefault();
    closeSheet();
    return;
  }
  if (event.key !== "Tab" || !state.sheet) return;
  const drawer = document.querySelector(".drawer");
  const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function render() {
  const previousScroller = document.querySelector(".content-scroll");
  const previousDrawerBody = document.querySelector(".drawer-body");
  const previousScrollTop = previousScroller?.scrollTop ?? 0;
  const previousDrawerScrollTop = previousDrawerBody?.scrollTop ?? 0;
  const activeElement = document.activeElement;
  const focusSelector = activeElement?.dataset?.action
    ? `[data-action="${activeElement.dataset.action}"]`
    : activeElement?.dataset?.page
      ? `[data-page="${activeElement.dataset.page}"]`
      : activeElement?.dataset?.scenario
        ? `[data-scenario="${activeElement.dataset.scenario}"]`
        : activeElement?.dataset?.field
          ? `[data-field="${activeElement.dataset.field}"]`
          : activeElement?.dataset?.serverCapability
            ? `[data-server-capability="${activeElement.dataset.serverCapability}"]`
            : activeElement?.id
              ? `#${activeElement.id}`
              : null;
  const dialogKey = state.sheet
    ? [state.sheet, state.questionIndex, state.productionQuestionIndex, state.configTarget, state.configEditProjectId, state.configEditEnvironment].join(":")
    : null;
  const openingSheet = dialogKey && dialogKey !== lastRenderedDialogKey;
  const samePage = state.page === lastRenderedPage;
  const sameScenario = state.scenario === lastRenderedScenario;
  const sameDialog = dialogKey && dialogKey === lastRenderedDialogKey;
  app.innerHTML = shell(currentView());
  if (samePage && sameScenario && document.querySelector(".content-scroll")) document.querySelector(".content-scroll").scrollTop = previousScrollTop;
  if (sameDialog && document.querySelector(".drawer-body")) document.querySelector(".drawer-body").scrollTop = previousDrawerScrollTop;
  if (openingSheet) {
    window.setTimeout(() => {
      document.querySelector(".close-button")?.focus();
    }, 0);
  } else if (focusSelector && samePage && sameScenario) {
    focusAfterRender(focusSelector);
  } else if (!samePage || !sameScenario) {
    focusMainHeading();
  }
  lastRenderedDialogKey = dialogKey;
  lastRenderedPage = state.page;
  lastRenderedScenario = state.scenario;
}

render();
