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
