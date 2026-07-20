import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { ConfigProfile } from "../types";
import {
  fillGeneratedInternalSecrets,
  fillDeploymentRuntimeDefaults,
  mergeReusableLocalSecrets,
  RuntimeConfigFields,
  parseEnvFields,
} from "./RuntimeConfigFields";

afterEach(() => vi.restoreAllMocks());

describe("parseEnvFields", () => {
  it("uses the project comment as title metadata without guessing the key meaning", () => {
    const fields = parseEnvFields(
      [
        "# 数据库连接地址",
        "DATABASE_URL=postgresql://localhost/app",
        "",
        "CUSTOM_SETTING=",
      ].join("\n"),
      ["DATABASE_URL"],
    );

    expect(fields).toEqual([
      expect.objectContaining({
        comment: "数据库连接地址",
        key: "DATABASE_URL",
        required: true,
        value: "postgresql://localhost/app",
      }),
      expect.objectContaining({
        comment: "",
        key: "CUSTOM_SETTING",
        required: false,
        value: "",
      }),
    ]);
  });

  it("preserves quoted values and export-style dotenv declarations", () => {
    expect(
      parseEnvFields('export APP_SECRET="value with spaces"', ["APP_SECRET"]),
    ).toEqual([
      expect.objectContaining({
        key: "APP_SECRET",
        value: "value with spaces",
      }),
    ]);
  });

  it("reuses external service credentials without copying local infrastructure secrets", () => {
    const merged = mergeReusableLocalSecrets(
      [
        "DATABASE_URL=",
        "JWT_SECRET=",
        "MINIMAX_API_KEY=",
        "COS_SECRET_ID=",
        "COS_SECRET_KEY=",
        "VITE_API_BASE_URL=",
      ].join("\n"),
      [
        "DATABASE_URL=postgresql://localhost/app",
        "JWT_SECRET=local-session-secret",
        "MINIMAX_API_KEY=minimax-key",
        "COS_SECRET_ID=cos-id",
        "COS_SECRET_KEY=cos-key",
        "VITE_API_BASE_URL=/api",
      ].join("\n"),
      [
        "DATABASE_URL",
        "JWT_SECRET",
        "MINIMAX_API_KEY",
        "COS_SECRET_ID",
        "COS_SECRET_KEY",
      ],
    );

    expect(merged.filledVariables).toEqual([
      "MINIMAX_API_KEY",
      "COS_SECRET_ID",
      "COS_SECRET_KEY",
      "VITE_API_BASE_URL",
    ]);
    expect(merged.content).toContain("DATABASE_URL=\n");
    expect(merged.content).toContain("JWT_SECRET=\n");
    expect(merged.content).toContain("MINIMAX_API_KEY=minimax-key");
    expect(merged.content).toContain("COS_SECRET_KEY=cos-key");
    expect(merged.content).toContain("VITE_API_BASE_URL=/api");
  });

  it("generates only internal application secrets in the current document", () => {
    const generated = fillGeneratedInternalSecrets(
      "DATABASE_URL=\nJWT_SECRET=\nMINIMAX_API_KEY=\n",
    );

    expect(generated.filledVariables).toEqual(["JWT_SECRET"]);
    expect(generated.content).toMatch(/JWT_SECRET=[a-f0-9]{64}/);
    expect(generated.content).toContain("DATABASE_URL=\n");
    expect(generated.content).toContain("MINIMAX_API_KEY=\n");
  });

  it("uses the conventional same-origin API path only for remote environments", () => {
    const content = "VITE_API_BASE_URL=\nCUSTOM_API_BASE_URL=\n";
    expect(fillDeploymentRuntimeDefaults(content, "staging")).toContain(
      "VITE_API_BASE_URL=/api",
    );
    expect(fillDeploymentRuntimeDefaults(content, "staging")).toContain(
      "CUSTOM_API_BASE_URL=\n",
    );
    expect(fillDeploymentRuntimeDefaults(content, "development")).toBe(content);
  });

  it("does not reload configuration when only a callback identity changes", async () => {
    const load = vi.spyOn(api, "loadRuntimeConfig");
    const { rerender } = render(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/stable-scroll"
      />,
    );

    expect(await screen.findByText("必要配置")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);

    rerender(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/stable-scroll"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("blocks saving when the existing runtime configuration cannot be read", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockRejectedValue(
      new Error("系统密钥库暂时不可用"),
    );
    const store = vi.spyOn(api, "storeRuntimeConfig");

    render(
      <RuntimeConfigFields
        environment="production"
        onError={() => undefined}
        path="/demo/runtime-load-failure"
      />,
    );

    expect(await screen.findByText("暂时无法读取正式配置")).toBeInTheDocument();
    expect(
      screen.getByText(
        "为避免覆盖原有配置，本页已停止保存。重新读取成功后才能继续修改。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /保存|同步|使用当前配置/ }),
    ).not.toBeInTheDocument();
    expect(store).not.toHaveBeenCalled();
  });

  it("does not offer a redundant save when the configuration is already current", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      sourceFiles: [".env.example"],
      content: "APP_SECRET=saved\n",
      templateContent: "APP_SECRET=\n",
      requiredVariables: ["APP_SECRET"],
      stored: true,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);

    render(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/already-saved"
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存本机配置" }),
    ).not.toBeInTheDocument();
  });

  it("automatically saves complete local defaults without making the user confirm a mechanical step", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      sourceFiles: [".env.example"],
      content: "NODE_ENV=development\nAPP_PORT=3000\n",
      templateContent: "NODE_ENV=development\nAPP_PORT=3000\n",
      requiredVariables: ["NODE_ENV", "APP_PORT"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    const write = vi.spyOn(api, "writeLocalEnv").mockResolvedValue({
      path: "/demo/complete-defaults/.env",
      written: true,
      requiresConfirmation: false,
      backupPath: null,
    });
    const store = vi.spyOn(api, "storeRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      stored: true,
    });

    render(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/complete-defaults"
      />,
    );

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        "/demo/complete-defaults",
        "NODE_ENV=development\nAPP_PORT=3000\n",
        false,
      ),
    );
    await waitFor(() => expect(store).toHaveBeenCalledTimes(1));
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(
      store.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存本机配置" }),
    ).not.toBeInTheDocument();
  });

  it("does not automatically overwrite an existing local env file", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      sourceFiles: [".env.example"],
      content: "APP_PORT=3000\n",
      templateContent: "APP_PORT=3000\n",
      requiredVariables: ["APP_PORT"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    const write = vi.spyOn(api, "writeLocalEnv").mockResolvedValue({
      path: "/demo/existing-env/.env",
      written: false,
      requiresConfirmation: true,
      backupPath: null,
    });
    const store = vi.spyOn(api, "storeRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      stored: true,
    });

    render(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/existing-env"
      />,
    );

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(store).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "更新项目现有的 .env？" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "保存本机配置" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "更新项目现有的 .env？",
      }),
    ).toBeInTheDocument();
    expect(store).not.toHaveBeenCalled();
  });

  it("lets a missing project setting reuse the matching optional configuration", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      templateContent: "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      requiredVariables: ["SERVICE_ACCESS_KEY"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([
      {
        id: "shared-service-key",
        kind: "custom",
        provider: "environment",
        name: "共享服务令牌",
        scope: "any",
        values: { env_name: "SERVICE_ACCESS_KEY" },
        secretFields: ["SERVICE_ACCESS_KEY"],
        configuredSecretFields: ["SERVICE_ACCESS_KEY"],
        isDefault: true,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    ]);
    vi.spyOn(api, "listConfigProfileBindings").mockResolvedValue([]);
    const bindProfiles = vi
      .spyOn(api, "setEnvironmentConfigBindings")
      .mockResolvedValue([
        {
          environment: "staging",
          kind: "custom",
          profileId: "shared-service-key",
        },
      ]);
    const recommend = vi
      .spyOn(api, "recommendRuntimeConfig")
      .mockResolvedValue({
        content: "# 服务访问令牌\nSERVICE_ACCESS_KEY=saved-value\n",
        appliedProfiles: ["共享服务令牌"],
        filledVariables: ["SERVICE_ACCESS_KEY"],
      });

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        path="/demo/reuse-config-center"
      />,
    );

    const selector = await screen.findByRole("combobox", {
      name: "SERVICE_ACCESS_KEY 使用配置中心已有值",
    });
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("option", { name: "共享服务令牌" }),
    );

    await waitFor(() =>
      expect(recommend).toHaveBeenCalledWith(
        "/demo/reuse-config-center",
        "staging",
        ["shared-service-key"],
        "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      ),
    );
    expect(bindProfiles).toHaveBeenCalledWith(
      "/demo/reuse-config-center",
      "staging",
      ["shared-service-key"],
    );
    expect(screen.getByText("引用配置中心 1 项")).toBeInTheDocument();
    expect(screen.getByText("配置项已经齐全，等待保存")).toBeInTheDocument();
    expect(
      screen.getByText("没有缺失项，需要核对时可查看全部配置"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    expect(screen.getByLabelText("服务访问令牌")).toHaveValue("saved-value");
  });

  it("restores an environment's configuration-center references and lets the user detach them", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      sourceFiles: [".env.example"],
      content: "# 服务访问令牌\nSERVICE_ACCESS_KEY=outdated-value\n",
      templateContent: "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      requiredVariables: ["SERVICE_ACCESS_KEY"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([
      {
        id: "production-service-key",
        kind: "custom",
        provider: "environment",
        name: "正式服务令牌",
        scope: "remote",
        values: { env_name: "SERVICE_ACCESS_KEY" },
        secretFields: ["SERVICE_ACCESS_KEY"],
        configuredSecretFields: ["SERVICE_ACCESS_KEY"],
        isDefault: true,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    ]);
    vi.spyOn(api, "listConfigProfileBindings").mockResolvedValue([
      {
        environment: "production",
        kind: "custom",
        profileId: "production-service-key",
      },
    ]);
    const recommend = vi
      .spyOn(api, "recommendRuntimeConfig")
      .mockResolvedValue({
        content: "# 服务访问令牌\nSERVICE_ACCESS_KEY=restored-value\n",
        appliedProfiles: ["正式服务令牌"],
        filledVariables: ["SERVICE_ACCESS_KEY"],
      });
    const setBindings = vi
      .spyOn(api, "setEnvironmentConfigBindings")
      .mockResolvedValue([]);

    render(
      <RuntimeConfigFields
        environment="production"
        onError={() => undefined}
        path="/demo/restore-config-center"
      />,
    );

    expect(await screen.findByText("引用配置中心 1 项")).toBeInTheDocument();
    expect(screen.getByText("配置中心有已引用的敏感值")).toBeInTheDocument();
    expect(recommend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "读取引用配置" }));
    await waitFor(() => expect(recommend).toHaveBeenCalledTimes(1));
    expect(recommend).toHaveBeenCalledWith(
      "/demo/restore-config-center",
      "production",
      ["production-service-key"],
      "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
    );
    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    expect(screen.getByLabelText("服务访问令牌")).toHaveValue("restored-value");
    expect(screen.getByLabelText("服务访问令牌")).toHaveAttribute("readonly");

    const selector = screen.getByRole("combobox", {
      name: "SERVICE_ACCESS_KEY 使用配置中心已有值",
    });
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "手动填写" }));

    await waitFor(() =>
      expect(setBindings).toHaveBeenCalledWith(
        "/demo/restore-config-center",
        "production",
        [],
      ),
    );
    expect(screen.queryByText("引用配置中心 1 项")).not.toBeInTheDocument();
    expect(screen.getByLabelText("服务访问令牌")).toHaveValue("restored-value");
    expect(screen.getByLabelText("服务访问令牌")).not.toHaveAttribute(
      "readonly",
    );
  });

  it("creates a common configuration beside a missing field and binds it without leaving the deployment page", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      templateContent: "# 服务访问令牌\nSERVICE_ACCESS_KEY=\n",
      requiredVariables: ["SERVICE_ACCESS_KEY"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    vi.spyOn(api, "listConfigProfileBindings").mockResolvedValue([]);
    const savedProfile: ConfigProfile = {
      id: "new-service-key",
      kind: "custom",
      provider: "environment",
      name: "服务访问令牌",
      scope: "any",
      values: { env_name: "SERVICE_ACCESS_KEY" },
      secretFields: ["SERVICE_ACCESS_KEY"],
      configuredSecretFields: ["SERVICE_ACCESS_KEY"],
      isDefault: true,
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const saveProfile = vi
      .spyOn(api, "saveConfigProfile")
      .mockResolvedValue(savedProfile);
    const setBindings = vi
      .spyOn(api, "setEnvironmentConfigBindings")
      .mockResolvedValue([
        {
          environment: "staging",
          kind: "custom",
          profileId: savedProfile.id,
        },
      ]);

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        path="/demo/create-common-config"
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "添加常用配置" }),
    );
    expect(
      screen.getByRole("heading", { name: "添加常用配置" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("配置名称")).toHaveValue("SERVICE_ACCESS_KEY");
    expect(screen.getByLabelText("说明")).toHaveValue("服务访问令牌");
    fireEvent.change(screen.getByLabelText("值"), {
      target: { value: "saved-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));

    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith({
        id: undefined,
        kind: "custom",
        provider: "environment",
        name: "服务访问令牌",
        scope: "any",
        values: { env_name: "SERVICE_ACCESS_KEY" },
        secretFields: ["SERVICE_ACCESS_KEY"],
        secrets: { SERVICE_ACCESS_KEY: "saved-secret" },
        isDefault: true,
      }),
    );
    expect(setBindings).toHaveBeenCalledWith(
      "/demo/create-common-config",
      "staging",
      ["new-service-key"],
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("引用配置中心 1 项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    expect(screen.getByLabelText("服务访问令牌")).toHaveValue("saved-secret");
    expect(screen.getByLabelText("服务访问令牌")).toHaveAttribute("readonly");
  });

  it("offers to save an existing manual value as a common configuration", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "development",
      filename: ".env",
      sourceFiles: [".env.example"],
      content: "# 公共接口地址\nPUBLIC_ENDPOINT=https://example.com\n",
      templateContent: "# 公共接口地址\nPUBLIC_ENDPOINT=\n",
      requiredVariables: ["PUBLIC_ENDPOINT"],
      stored: true,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    vi.spyOn(api, "listConfigProfileBindings").mockResolvedValue([]);

    render(
      <RuntimeConfigFields
        environment="development"
        onError={() => undefined}
        path="/demo/save-manual-common-config"
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "查看全部配置" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存为常用配置" }));
    expect(
      screen.getByRole("heading", { name: "保存为常用配置" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("值")).toHaveValue("https://example.com");
  });

  it("keeps the current value and old bindings when a newly saved common configuration cannot be bound", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      sourceFiles: [".env.example"],
      content: [
        "# 旧令牌",
        "OLD_TOKEN=kept-value",
        "# 新令牌",
        "NEW_TOKEN=typed-value",
        "",
      ].join("\n"),
      templateContent: "OLD_TOKEN=\nNEW_TOKEN=\n",
      requiredVariables: ["OLD_TOKEN", "NEW_TOKEN"],
      stored: false,
      authorizationRequired: false,
    });
    const oldProfile: ConfigProfile = {
      id: "old-profile",
      kind: "custom",
      provider: "environment",
      name: "旧令牌",
      scope: "any",
      values: { env_name: "OLD_TOKEN" },
      secretFields: ["OLD_TOKEN"],
      configuredSecretFields: ["OLD_TOKEN"],
      isDefault: true,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([oldProfile]);
    vi.spyOn(api, "listConfigProfileBindings").mockResolvedValue([
      {
        environment: "production",
        kind: "custom",
        profileId: oldProfile.id,
      },
    ]);
    const newProfile: ConfigProfile = {
      id: "new-profile",
      kind: "custom",
      provider: "environment",
      name: "新令牌",
      scope: "any",
      values: { env_name: "NEW_TOKEN" },
      secretFields: ["NEW_TOKEN"],
      configuredSecretFields: ["NEW_TOKEN"],
      isDefault: false,
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const saveProfile = vi
      .spyOn(api, "saveConfigProfile")
      .mockResolvedValue(newProfile);
    const setBindings = vi
      .spyOn(api, "setEnvironmentConfigBindings")
      .mockRejectedValueOnce(new Error("暂时无法更新引用"))
      .mockResolvedValueOnce([
        {
          environment: "production",
          kind: "custom",
          profileId: oldProfile.id,
        },
        {
          environment: "production",
          kind: "custom",
          profileId: newProfile.id,
        },
      ]);
    const onError = vi.fn();

    render(
      <RuntimeConfigFields
        environment="production"
        onError={onError}
        path="/demo/common-config-bind-failure"
      />,
    );

    expect(await screen.findByText("引用配置中心 1 项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存为常用配置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));

    expect(
      await screen.findByText("暂时无法更新引用。当前内容和原有引用均未改变。"),
    ).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith("暂时无法更新引用");
    expect(setBindings).toHaveBeenLastCalledWith(
      "/demo/common-config-bind-failure",
      "production",
      ["old-profile", "new-profile"],
    );
    expect(screen.getByText("引用配置中心 1 项")).toBeInTheDocument();
    expect(screen.getByLabelText("新令牌", { selector: "input" })).toHaveValue(
      "typed-value",
    );

    fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
    await waitFor(() => expect(setBindings).toHaveBeenCalledTimes(2));
    expect(saveProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "new-profile" }),
    );
    expect(await screen.findByText("引用配置中心 2 项")).toBeInTheDocument();
  });

  it("hides managed infrastructure and fills the standard same-origin API path", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "DATABASE_URL=\nVITE_API_BASE_URL=\nMINIMAX_API_KEY=saved\n",
      templateContent: "DATABASE_URL=\nVITE_API_BASE_URL=\nMINIMAX_API_KEY=\n",
      requiredVariables: [
        "DATABASE_URL",
        "VITE_API_BASE_URL",
        "MINIMAX_API_KEY",
      ],
      stored: true,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        path="/demo/no-reusable-secret"
        secretVariables={["DATABASE_URL", "MINIMAX_API_KEY"]}
      />,
    );

    expect(await screen.findByText("测试配置")).toBeInTheDocument();
    expect(screen.getByText("配置项已经齐全，等待保存")).toBeInTheDocument();
    expect(
      screen.getByText("没有缺失项，需要核对时可查看全部配置"),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("由系统自动准备（可选覆盖）"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("输入部署后的地址"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "从本机配置补全" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存测试配置" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    expect(
      screen.getByRole("button", { name: "显示MINIMAX_API_KEY配置值" }),
    ).toBeInTheDocument();
  });

  it("lets the client generate internal secrets before asking for external services", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "DATABASE_URL=\nJWT_SECRET=\n",
      templateContent: "DATABASE_URL=\nJWT_SECRET=\n",
      requiredVariables: ["DATABASE_URL", "JWT_SECRET"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        path="/demo/auto-fill"
        secretVariables={["DATABASE_URL", "JWT_SECRET"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "自动补全" }));
    expect(screen.getByRole("button", { name: "保存测试配置" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "自动补全" }),
    ).not.toBeInTheDocument();
  });

  it("can replace a locked saved value with the project's current configuration", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "MINIMAX_API_KEY=\n",
      templateContent: "MINIMAX_API_KEY=\n",
      requiredVariables: ["MINIMAX_API_KEY"],
      stored: true,
      authorizationRequired: true,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    vi.spyOn(api, "loadExistingProjectConfig").mockResolvedValue({
      sourceFiles: [".env"],
      content: "MINIMAX_API_KEY=project-value\n",
    });

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        path="/demo/replace-locked"
        secretVariables={["MINIMAX_API_KEY"]}
      />,
    );

    const reuse = await screen.findByRole("button", {
      name: "从本机配置补全",
    });
    expect(screen.getByRole("button", { name: "保存测试配置" })).toBeDisabled();
    fireEvent.click(reuse);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "保存测试配置" }),
      ).toBeEnabled(),
    );
  });

  it("keeps a previously verified server configuration usable without reading its secrets", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      sourceFiles: [".env.example"],
      content: "APP_SECRET=\n",
      templateContent: "APP_SECRET=\n",
      requiredVariables: ["APP_SECRET"],
      stored: false,
      authorizationRequired: true,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    const onReadyChange = vi.fn();

    render(
      <RuntimeConfigFields
        environment="production"
        onError={() => undefined}
        onReadyChange={onReadyChange}
        path="/demo/verified-remote-config"
        server={{
          name: "生产服务器",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/Users/demo/.ssh/server",
          hostFingerprint: "SHA256:server",
        }}
        verifiedReady
      />,
    );

    expect(
      await screen.findByText("配置已在运行服务器准备好"),
    ).toBeInTheDocument();
    expect(screen.getByText("可以继续部署")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看或修改配置" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "读取已保存配置" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("APP_SECRET")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(onReadyChange).toHaveBeenLastCalledWith(true, false),
    );
  });

  it("lets the user explicitly stop an unused setting from blocking deployment", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "# AI（未来使用）\nMINIMAX_API_KEY=\n",
      templateContent: "# AI（未来使用）\nMINIMAX_API_KEY=\n",
      requiredVariables: ["MINIMAX_API_KEY"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    const markOptional = vi.fn().mockResolvedValue(true);

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        onMarkOptional={markOptional}
        path="/demo/optional"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "项目不需要" }));
    expect(
      screen.getByRole("heading", { name: "确认项目不需要这项配置？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认不需要" }));

    await waitFor(() =>
      expect(markOptional).toHaveBeenCalledWith("MINIMAX_API_KEY"),
    );
    await waitFor(() => expect(screen.getByText("可选")).toBeInTheDocument());
  });

  it("does not mark a remote configuration ready until the server copy matches", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      sourceFiles: [".env.example"],
      content: "APP_SECRET=saved\n",
      templateContent: "APP_SECRET=\n",
      requiredVariables: ["APP_SECRET"],
      stored: true,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    let finishCheck:
      | ((status: { stored: boolean; synchronized: boolean }) => void)
      | undefined;
    vi.spyOn(api, "getRuntimeConfigSyncStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    vi.spyOn(api, "storeRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      stored: true,
    });
    const synchronize = vi
      .spyOn(api, "syncRuntimeConfigToServer")
      .mockResolvedValue({ stored: true, synchronized: true });
    const onReadyChange = vi.fn();

    render(
      <RuntimeConfigFields
        environment="production"
        onError={() => undefined}
        onReadyChange={onReadyChange}
        path="/demo/remote-sync"
        server={{
          name: "test",
          host: "server.example.com",
          user: "ubuntu",
          port: 22,
          keyPath: "/tmp/test-key",
          hostFingerprint: "SHA256:test",
        }}
      />,
    );

    expect(
      await screen.findByText("正在确认运行服务器中的配置"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "正在确认正式配置" }),
    ).toBeDisabled();
    expect(onReadyChange).toHaveBeenCalledWith(false, true);
    act(() => finishCheck?.({ stored: true, synchronized: false }));
    await waitFor(() =>
      expect(onReadyChange).toHaveBeenLastCalledWith(false, false),
    );
    expect(
      await screen.findByText("配置已保存在本机，需要同步到运行服务器"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "同步正式配置" }));
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已准备")).toBeInTheDocument();
    expect(screen.getByText("配置已保存到运行服务器")).toBeInTheDocument();
    expect(screen.getByText("需要核对时可以查看全部配置")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存正式配置" }),
    ).not.toBeInTheDocument();
    expect(onReadyChange).toHaveBeenLastCalledWith(true, false);

    fireEvent.click(screen.getByRole("button", { name: "查看全部配置" }));
    fireEvent.change(screen.getByLabelText("APP_SECRET"), {
      target: { value: "updated" },
    });
    expect(screen.getByRole("button", { name: "保存正式配置" })).toBeEnabled();
  });

  it("automatically prepares an empty test configuration without asking for a meaningless save", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    let finishStore: (() => void) | undefined;
    const store = vi
      .spyOn(api, "storeRuntimeConfig")
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finishStore = resolve;
        });
        return {
          environment: "staging",
          filename: ".env.staging",
          stored: true,
        };
      });
    const synchronize = vi
      .spyOn(api, "syncRuntimeConfigToServer")
      .mockResolvedValue({ stored: true, synchronized: true });
    const onReadyChange = vi.fn();

    render(
      <RuntimeConfigFields
        environment="staging"
        onError={() => undefined}
        onReadyChange={onReadyChange}
        path="/demo/empty-test-config"
        server={{
          name: "test",
          host: "server.example.com",
          user: "ubuntu",
          port: 22,
          keyPath: "/tmp/test-key",
          hostFingerprint: "SHA256:test",
        }}
      />,
    );

    await waitFor(() => expect(store).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("没有需要填写的配置，正在自动准备"),
    ).toBeInTheDocument();
    expect(onReadyChange).toHaveBeenLastCalledWith(false, true);
    expect(
      screen.queryByRole("button", { name: /测试配置/ }),
    ).not.toBeInTheDocument();
    act(() => finishStore?.());
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onReadyChange).toHaveBeenLastCalledWith(true, false),
    );
    expect(screen.getByText("已准备")).toBeInTheDocument();
    expect(screen.getByText("项目默认设置已经准备")).toBeInTheDocument();
    expect(screen.getByText("不需要额外操作")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存测试配置" }),
    ).not.toBeInTheDocument();
  });

  it("keeps ABCDeploy-managed variables out of the user form while preserving them on save", async () => {
    const content = [
      "# 由 ABCDeploy 生成",
      "DEPLOYDESK_ENV=production",
      "DEPLOYDESK_RELEASE_CHANNEL=stable",
      "",
    ].join("\n");
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      sourceFiles: [],
      content,
      templateContent: content,
      requiredVariables: ["DEPLOYDESK_ENV", "DEPLOYDESK_RELEASE_CHANNEL"],
      stored: false,
      authorizationRequired: false,
    });
    vi.spyOn(api, "listConfigProfiles").mockResolvedValue([]);
    const store = vi.spyOn(api, "storeRuntimeConfig").mockResolvedValue({
      environment: "production",
      filename: ".env.production",
      stored: true,
    });
    const synchronize = vi
      .spyOn(api, "syncRuntimeConfigToServer")
      .mockResolvedValue({ stored: true, synchronized: true });

    render(
      <RuntimeConfigFields
        environment="production"
        onError={() => undefined}
        path="/demo/managed-production-config"
        server={{
          name: "production",
          host: "server.example.com",
          user: "ubuntu",
          port: 22,
          keyPath: "/tmp/production-key",
          hostFingerprint: "SHA256:production",
        }}
      />,
    );

    expect(
      await screen.findByText("无需填写，使用当前配置即可"),
    ).toBeInTheDocument();
    expect(screen.getByText("系统会保留项目默认设置")).toBeInTheDocument();
    expect(screen.queryByText("DEPLOYDESK_ENV")).not.toBeInTheDocument();
    expect(
      screen.queryByText("DEPLOYDESK_RELEASE_CHANNEL"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "使用当前配置并继续" }));
    await waitFor(() =>
      expect(store).toHaveBeenCalledWith(
        "/demo/managed-production-config",
        "production",
        content,
      ),
    );
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
  });
});
