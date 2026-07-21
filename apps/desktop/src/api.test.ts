import { beforeEach, describe, expect, it, vi } from "vitest";

describe("browser demo managed infrastructure", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("restores an ephemeral local database recommendation after a page reload", async () => {
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    localStorage.setItem(
      "abcdeploy.demo.config-profiles",
      JSON.stringify([
        {
          id: "profile-local-postgres",
          kind: "database",
          provider: "abcdeploy_local_postgres",
          name: "ABCDeploy 本机 PostgreSQL",
          scope: "local",
          values: {
            host: "127.0.0.1",
            port: "55432",
            user: "abcdeploy",
          },
          secretFields: ["password"],
          configuredSecretFields: ["password"],
          isDefault: true,
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
      ]),
    );

    const { recommendRuntimeConfig } = await import("./api");
    const recommendation = await recommendRuntimeConfig(
      "/demo/reloaded-project",
      "development",
      ["profile-local-postgres"],
      "DATABASE_URL=\nJWT_SECRET=\n",
    );

    expect(recommendation.content).toContain("DATABASE_URL=postgresql://");
    expect(recommendation.content).toMatch(/JWT_SECRET=[a-f0-9]{64}/);
    expect(
      localStorage.getItem("abcdeploy.demo.config-profiles"),
    ).not.toContain("demo-local-password");
  });

  it("reads many saved settings without inventing missing values", async () => {
    const { getAppSettings, setAppSetting } = await import("./api");
    await setAppSetting("project.demo.scene", "versions");
    await setAppSetting("project.demo.completed-progress", "");

    expect(
      await getAppSettings([
        "project.demo.scene",
        "project.demo.completed-progress",
        "project.demo.missing",
        "project.demo.scene",
      ]),
    ).toEqual({
      "project.demo.completed-progress": "",
      "project.demo.scene": "versions",
    });
  });

  it("persists canvas layouts independently for every project and deployment path", async () => {
    const {
      clearDeploymentPathCanvasLayout,
      getDeploymentPathCanvasLayout,
      saveDeploymentPathCanvasLayout,
    } = await import("./api");
    const firstLayout = {
      local: { x: 10, y: 20 },
      build: { x: 330, y: 21 },
      registry: { x: 650, y: 22 },
      server: { x: 970, y: 23 },
    };
    const secondPathLayout = {
      ...firstLayout,
      local: { x: -120, y: 88 },
    };
    const secondProjectLayout = {
      ...firstLayout,
      server: { x: 1200.5, y: -40.25 },
    };

    await saveDeploymentPathCanvasLayout(
      "/demo/project one",
      "path/primary",
      firstLayout,
    );
    await saveDeploymentPathCanvasLayout(
      "/demo/project one",
      "path/secondary",
      secondPathLayout,
    );
    await saveDeploymentPathCanvasLayout(
      "/demo/project two",
      "path/primary",
      secondProjectLayout,
    );

    await expect(
      getDeploymentPathCanvasLayout("/demo/project one", "path/primary"),
    ).resolves.toEqual(firstLayout);
    await expect(
      getDeploymentPathCanvasLayout("/demo/project one", "path/secondary"),
    ).resolves.toEqual(secondPathLayout);
    await expect(
      getDeploymentPathCanvasLayout("/demo/project two", "path/primary"),
    ).resolves.toEqual(secondProjectLayout);

    await clearDeploymentPathCanvasLayout("/demo/project one", "path/primary");
    await expect(
      getDeploymentPathCanvasLayout("/demo/project one", "path/primary"),
    ).resolves.toBeNull();
    await expect(
      getDeploymentPathCanvasLayout("/demo/project one", "path/secondary"),
    ).resolves.toEqual(secondPathLayout);
  });

  it("rejects malformed, incomplete, unknown, and non-finite canvas coordinates", async () => {
    const {
      getDeploymentPathCanvasLayout,
      saveDeploymentPathCanvasLayout,
      setAppSetting,
    } = await import("./api");
    const projectPath = "/demo/layout-validation";
    const pathId = "path-validation";
    const settingKey = `project.${encodeURIComponent(projectPath)}.deployment-path.${encodeURIComponent(pathId)}.canvas-layout.v1`;
    const validLayout = {
      local: { x: 10, y: 20 },
      build: { x: 330, y: 20 },
      registry: { x: 650, y: 20 },
      server: { x: 970, y: 20 },
    };
    const invalidSerializedLayouts = [
      "{not-json",
      JSON.stringify({ ...validLayout, server: undefined }),
      JSON.stringify({
        local: validLayout.local,
        build: validLayout.build,
        registry: validLayout.registry,
        stranger: validLayout.server,
      }),
      JSON.stringify({
        ...validLayout,
        local: { x: "10", y: 20 },
      }),
      `{"local":{"x":1e999,"y":20},"build":{"x":330,"y":20},"registry":{"x":650,"y":20},"server":{"x":970,"y":20}}`,
      JSON.stringify({
        ...validLayout,
        server: { x: 970, y: 20, z: 30 },
      }),
    ];

    for (const serialized of invalidSerializedLayouts) {
      await setAppSetting(settingKey, serialized);
      await expect(
        getDeploymentPathCanvasLayout(projectPath, pathId),
      ).resolves.toBeNull();
    }

    await expect(
      saveDeploymentPathCanvasLayout(projectPath, pathId, {
        ...validLayout,
        server: { x: Number.POSITIVE_INFINITY, y: 20 },
      }),
    ).rejects.toThrow("部署线路画布布局无效");
  });

  it("clears a deployment path canvas layout after deleting the path", async () => {
    const {
      deleteDeploymentPath,
      getDeploymentPathCanvasLayout,
      listDeploymentPaths,
      saveDeploymentPath,
      saveDeploymentPathCanvasLayout,
    } = await import("./api");
    const projectPath = "/demo/delete-layout";
    const pathId = "path-delete-layout";
    await saveDeploymentPath({
      id: pathId,
      projectPath,
      name: "待删除线路",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
    });
    await saveDeploymentPathCanvasLayout(projectPath, pathId, {
      local: { x: 10, y: 20 },
      build: { x: 330, y: 20 },
      registry: { x: 650, y: 20 },
      server: { x: 970, y: 20 },
    });

    await expect(deleteDeploymentPath(projectPath, pathId)).resolves.toBe(true);
    await expect(listDeploymentPaths(projectPath)).resolves.toEqual([]);
    await expect(
      getDeploymentPathCanvasLayout(projectPath, pathId),
    ).resolves.toBeNull();
  });

  it("keeps a successful path deletion authoritative when layout cleanup fails", async () => {
    const {
      deleteDeploymentPath,
      listDeploymentPaths,
      saveDeploymentPath,
      saveDeploymentPathCanvasLayout,
    } = await import("./api");
    const projectPath = "/demo/delete-layout-cleanup-failure";
    const pathId = "path-cleanup-failure";
    await saveDeploymentPath({
      id: pathId,
      projectPath,
      name: "清理失败线路",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
    });
    await saveDeploymentPathCanvasLayout(projectPath, pathId, {
      local: { x: 10, y: 20 },
      build: { x: 330, y: 20 },
      registry: { x: 650, y: 20 },
      server: { x: 970, y: 20 },
    });

    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.endsWith(".canvas-layout.v1")) {
          throw new Error("layout storage unavailable");
        }
        return originalSetItem.call(this, key, value);
      });
    try {
      await expect(deleteDeploymentPath(projectPath, pathId)).resolves.toBe(
        true,
      );
      await expect(listDeploymentPaths(projectPath)).resolves.toEqual([]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("lists stable connection resources and never returns stored credential material", async () => {
    const path = "/demo/connection-resources";
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      JSON.stringify({
        connected: true,
        displayName: "示例账号",
        username: "safe-user",
        defaultNamespace: "safe-team",
        namespaces: [],
        token: "cnb-token-sentinel",
        password: "password-sentinel",
        privateKey: "private-key-sentinel",
      }),
    );
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.namespace",
      "safe-team",
    );
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      "ccr.ccs.tencentyun.com",
    );
    localStorage.setItem(
      `abcdeploy.demo.manifest.${encodeURIComponent(path)}`,
      "providers:\n  build: { kind: cnb, repository: demo/sample }\n  registry: { kind: tcr, registry: ccr.ccs.tencentyun.com, namespace: safe-team }\n",
    );

    const {
      bindProjectServer,
      getProjectConnectionBindings,
      listConnections,
      replaceRegistryCredentials,
    } = await import("./api");
    const server = await bindProjectServer(path, "staging", {
      name: "测试服务器",
      host: "203.0.113.51",
      user: "ubuntu",
      port: 22,
      keyPath: "/tmp/private-key-sentinel",
      hostFingerprint: "SHA256:safe-fingerprint",
    });

    const connections = await listConnections();
    expect(connections.map((connection) => connection.id)).toContain(
      `legacy-server:${server.id}`,
    );
    expect(
      connections.find(
        (connection) => connection.id === "connection-cnb-default",
      ),
    ).toMatchObject({
      kind: "source",
      provider: "cnb",
      status: "configured",
      lastCheckedAt: null,
      metadata: {
        endpoint: "https://cnb.cool",
        username: "safe-user",
        namespace: "safe-team",
      },
    });
    expect(
      connections.find(
        (connection) => connection.id === "connection-tcr-default",
      ),
    ).toMatchObject({
      kind: "registry",
      provider: "tcr",
      status: "configured",
      lastCheckedAt: null,
    });
    expect(await listConnections("server")).toHaveLength(1);

    const serialized = JSON.stringify(connections);
    for (const forbidden of [
      "cnb-token-sentinel",
      "password-sentinel",
      "private-key-sentinel",
      "secretRef",
      "keyPath",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(await getProjectConnectionBindings(path)).toEqual({
      sourceConnectionId: "connection-cnb-default",
      staging: {
        targetConnectionId: `legacy-server:${server.id}`,
        registryConnectionId: "connection-tcr-default",
      },
      production: {
        targetConnectionId: null,
        registryConnectionId: "connection-tcr-default",
      },
    });

    await replaceRegistryCredentials(
      "ccr.ccs.tencentyun.com",
      "registry.tcr.v2",
      "safe-user",
      "runtime-password-sentinel",
    );
    expect((await listConnections("registry"))[0]).toMatchObject({
      status: "ready",
    });
    expect(JSON.stringify(await listConnections("registry"))).not.toContain(
      "runtime-password-sentinel",
    );
  });

  it("treats malformed historical connection cache as unconfigured", async () => {
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      '{"connected":true,"token":"secret-sentinel"',
    );
    const { listConnections } = await import("./api");

    await expect(listConnections("source")).resolves.toEqual([
      expect.objectContaining({
        id: "connection-cnb-default",
        status: "needs_authorization",
      }),
    ]);
    expect(JSON.stringify(await listConnections())).not.toContain(
      "secret-sentinel",
    );
  });

  it("stores one durable validation per immutable demo version", async () => {
    const path = "/demo/version-validation";
    const run = {
      id: "staging-version-1",
      projectPath: path,
      projectName: "version-validation",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "101",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/version-validation",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:01:00.000Z",
    };
    localStorage.setItem("abcdeploy.demo.runs", JSON.stringify([run]));
    const { listVersionValidations, setVersionValidation } =
      await import("./api");

    const passed = await setVersionValidation(path, run.id, "passed");
    expect(passed).toMatchObject({
      runId: run.id,
      state: "passed",
    });
    expect(await listVersionValidations(path)).toEqual([passed]);

    const rejected = await setVersionValidation(path, run.id, "rejected");
    expect(await listVersionValidations(path)).toEqual([rejected]);
    expect(await listVersionValidations("/demo/another-project")).toEqual([]);
  });

  it("keeps authoritative demo environment pointers on the last successful version", async () => {
    const path = "/demo/environment-pointers";
    const stableStaging = {
      id: "staging-stable",
      projectPath: path,
      projectName: "environment-pointers",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "201",
      commitSha: "a".repeat(40),
      sourceRunId: null,
      candidateTag: "candidate-stable",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/environment-pointers",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:01:00.000Z",
    };
    const stableProduction = {
      ...stableStaging,
      id: "production-stable",
      environment: "production",
      sourceRunId: stableStaging.id,
      startedAt: "2026-07-17T00:02:00.000Z",
      updatedAt: "2026-07-17T00:03:00.000Z",
    };
    const failedStaging = {
      ...stableStaging,
      id: "staging-failed",
      status: "failed",
      commitSha: "b".repeat(40),
      message: "新测试版本部署失败",
      startedAt: "2026-07-17T01:00:00.000Z",
      updatedAt: "2026-07-17T01:01:00.000Z",
    };
    const failedProduction = {
      ...failedStaging,
      id: "production-failed",
      environment: "production",
      sourceRunId: failedStaging.id,
      startedAt: "2026-07-17T01:02:00.000Z",
      updatedAt: "2026-07-17T01:03:00.000Z",
    };
    localStorage.setItem(
      "abcdeploy.demo.runs",
      JSON.stringify([
        failedProduction,
        failedStaging,
        stableProduction,
        stableStaging,
      ]),
    );

    const { listProjectEnvironments } = await import("./api");
    const environments = await listProjectEnvironments(path);

    expect(environments).toEqual([
      expect.objectContaining({
        environment: "development",
        currentVersionKey: null,
        currentRunId: null,
      }),
      expect.objectContaining({
        environment: "staging",
        status: "healthy",
        currentVersionKey: `commit:${stableStaging.commitSha}`,
        currentRunId: stableStaging.id,
      }),
      expect.objectContaining({
        environment: "production",
        status: "healthy",
        currentVersionKey: `commit:${stableStaging.commitSha}`,
        currentRunId: stableProduction.id,
      }),
    ]);
  });

  it("lists immutable demo versions with artifacts, validation, and environment ownership", async () => {
    const path = "/demo/project-versions";
    const firstStaging = {
      id: "staging-version-first",
      projectPath: path,
      projectName: "project-versions",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "301",
      commitSha: "c".repeat(40),
      sourceTitle: "第一个测试版本",
      sourceRunId: null,
      candidateTag: "candidate-version",
      artifacts: [
        {
          service: "web",
          image: "registry/demo/web",
          digest: `sha256:${"b".repeat(64)}`,
        },
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project-versions",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:01:00.000Z",
    };
    const sameVersionRedeployed = {
      ...firstStaging,
      id: "staging-version-redeployed",
      buildSerial: "302",
      sourceTitle: "同一镜像再次部署",
      startedAt: "2026-07-17T01:00:00.000Z",
      updatedAt: "2026-07-17T01:01:00.000Z",
    };
    const production = {
      ...firstStaging,
      id: "production-version",
      environment: "production",
      sourceRunId: firstStaging.id,
      startedAt: "2026-07-17T01:02:00.000Z",
      updatedAt: "2026-07-17T01:03:00.000Z",
    };
    const productionApproval = {
      ...sameVersionRedeployed,
      id: "production-approval-record",
      actionKind: "production-approval",
      startedAt: "2026-07-17T01:04:00.000Z",
      updatedAt: "2026-07-17T01:05:00.000Z",
    };
    const failedStaging = {
      ...firstStaging,
      id: "staging-version-failed",
      status: "failed",
      commitSha: "d".repeat(40),
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"d".repeat(64)}`,
        },
      ],
      startedAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:01:00.000Z",
    };
    localStorage.setItem(
      "abcdeploy.demo.runs",
      JSON.stringify([
        failedStaging,
        productionApproval,
        production,
        sameVersionRedeployed,
        firstStaging,
      ]),
    );

    const { listProjectVersions, setVersionValidation } = await import("./api");
    const validation = await setVersionValidation(
      path,
      firstStaging.id,
      "passed",
    );
    const versions = await listProjectVersions(path);

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionKey: validation.versionKey,
      status: "available",
      commitSha: sameVersionRedeployed.commitSha,
      sourceTitle: sameVersionRedeployed.sourceTitle,
      sourceBuildId: sameVersionRedeployed.buildSerial,
      repository: sameVersionRedeployed.repository,
      branch: "main",
      stagingRunId: sameVersionRedeployed.id,
      validation,
      currentEnvironments: ["staging", "production"],
    });
    expect(versions[0].artifacts.map((artifact) => artifact.service)).toEqual([
      "api",
      "web",
    ]);
    expect(await listProjectVersions("/demo/without-success")).toEqual([]);
  });

  it("binds multiple configuration entries to one environment and replaces them atomically", async () => {
    const {
      bindConfigProfile,
      listConfigProfileBindings,
      saveConfigProfile,
      setEnvironmentConfigBindings,
    } = await import("./api");
    const first = await saveConfigProfile({
      id: "profile-api-base-url",
      kind: "custom",
      provider: "environment",
      name: "服务地址",
      scope: "remote",
      values: { env_name: "API_BASE_URL", env_value: "https://api.test" },
      secretFields: [],
      secrets: {},
      isDefault: true,
    });
    const second = await saveConfigProfile({
      id: "profile-api-token",
      kind: "custom",
      provider: "environment",
      name: "访问令牌",
      scope: "remote",
      values: { env_name: "API_TOKEN" },
      secretFields: ["API_TOKEN"],
      secrets: { API_TOKEN: "test-only-secret" },
      isDefault: false,
    });

    await bindConfigProfile("/demo/project", "staging", "custom", first.id);
    await bindConfigProfile("/demo/project", "staging", "custom", second.id);
    expect(
      await listConfigProfileBindings("/demo/project", "staging"),
    ).toHaveLength(2);

    const replaced = await setEnvironmentConfigBindings(
      "/demo/project",
      "staging",
      [second.id, first.id, second.id],
    );
    expect(replaced.map((binding) => binding.profileId)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      localStorage.getItem("abcdeploy.demo.config-profiles"),
    ).not.toContain("test-only-secret");

    await setEnvironmentConfigBindings("/demo/project", "staging", []);
    expect(await listConfigProfileBindings("/demo/project", "staging")).toEqual(
      [],
    );
  });

  it("does not mark incomplete registry credentials as verified", async () => {
    const { checkRegistryCredentials } = await import("./api");

    await expect(
      checkRegistryCredentials("ccr.ccs.tencentyun.com", "demo-user", ""),
    ).resolves.toMatchObject({
      ok: false,
      code: "AD-IMG-201",
    });
    await expect(
      checkRegistryCredentials(
        "ccr.ccs.tencentyun.com",
        "demo-user",
        "demo-password",
      ),
    ).resolves.toMatchObject({
      ok: true,
      summary: "镜像仓库登录信息可用",
    });
  });

  it("restores the server bound to the current project instead of another project", async () => {
    const { bindProjectServer, getProjectServer } = await import("./api");
    await bindProjectServer("/demo/first", "staging", {
      name: "第一台服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/tmp/demo-key",
      hostFingerprint: "SHA256:first",
    });
    await bindProjectServer("/demo/second", "staging", {
      name: "第二台服务器",
      host: "203.0.113.20",
      user: "root",
      port: 22,
      keyPath: "/tmp/demo-key-2",
      hostFingerprint: "SHA256:second",
    });

    expect((await getProjectServer("/demo/first", "staging"))?.host).toBe(
      "203.0.113.10",
    );
    expect((await getProjectServer("/demo/second", "staging"))?.host).toBe(
      "203.0.113.20",
    );
  });

  it("keeps one recent successful record for each project environment", async () => {
    const base = {
      projectPath: "/demo/history",
      projectName: "history",
      status: "success",
      currentStage: "complete",
      buildSerial: "10",
      commitSha: "0123456789abcdef",
      sourceTitle: "第一版",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/history",
      branch: "main",
      message: "已经完成",
      completedSteps: ["healthcheck"],
    };
    localStorage.setItem(
      "abcdeploy.demo.runs",
      JSON.stringify([
        {
          ...base,
          id: "old-staging",
          environment: "staging",
          startedAt: "2026-07-10T00:00:00Z",
          updatedAt: "2026-07-10T00:00:00Z",
        },
        {
          ...base,
          id: "new-staging",
          environment: "staging",
          sourceTitle: "第二版",
          startedAt: "2026-07-12T00:00:00Z",
          updatedAt: "2026-07-12T00:00:00Z",
        },
        {
          ...base,
          id: "production",
          environment: "production",
          sourceRunId: "new-staging",
          sourceTitle: "第二版",
          startedAt: "2026-07-13T00:00:00Z",
          updatedAt: "2026-07-13T00:00:00Z",
        },
      ]),
    );

    const { listRecentSuccessfulDeploymentRuns } = await import("./api");
    const runs = await listRecentSuccessfulDeploymentRuns();

    expect(runs.map((run) => run.id)).toEqual(["production", "new-staging"]);
  });
});
