import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ApplyResult,
  ProviderCheck,
  ServerForm,
  SystemPreflight,
  WorkspacePreview,
} from "./types";

export async function selectProjectDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择项目目录",
  });
  return typeof selected === "string" ? selected : null;
}

export async function selectPrivateKey(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: false,
    multiple: false,
    title: "选择 SSH 私钥",
  });
  return typeof selected === "string" ? selected : null;
}

export async function getPreflight(): Promise<SystemPreflight> {
  if (!isTauri()) return demoPreflight;
  return invoke<SystemPreflight>("get_preflight");
}

export async function openProject(path: string): Promise<WorkspacePreview> {
  if (!isTauri()) return demoWorkspace(path);
  return invoke<WorkspacePreview>("open_project", { path });
}

export async function previewManifest(
  path: string,
  manifestYaml: string,
): Promise<WorkspacePreview> {
  if (!isTauri()) return { ...demoWorkspace(path), manifestYaml };
  return invoke<WorkspacePreview>("preview_manifest", { path, manifestYaml });
}

export async function applyManifest(
  path: string,
  manifestYaml: string,
): Promise<ApplyResult> {
  if (!isTauri()) {
    return {
      planId: "demo-plan",
      writtenFiles: ["deploy.yaml"],
      backupDirectory: `${path}/.deploydesk/backups/demo-plan`,
    };
  }
  return invoke<ApplyResult>("apply_manifest", {
    path,
    manifestYaml,
    confirmed: true,
  });
}

export async function checkDocker(): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "docker",
      ok: true,
      summary: "Docker Engine 29.4.3 可用",
      details: [],
    };
  }
  return invoke<ProviderCheck>("check_docker");
}

export async function checkServer(form: ServerForm): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "ssh",
      ok: Boolean(form.host && form.user && form.keyPath),
      summary: form.host ? "服务器连接正常" : "请填写服务器信息",
      details: ["未执行远程写操作"],
    };
  }
  return invoke<ProviderCheck>("check_server", {
    name: form.name,
    host: form.host,
    user: form.user,
    keyPath: form.keyPath,
    port: form.port,
  });
}

export async function bootstrapServerCaddy(
  form: ServerForm,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "caddy",
      ok: true,
      summary: `服务器 ${form.name} 的 DeployDesk Caddy 已就绪`,
      details: ["已创建 ~/.deploydesk，未修改其他反向代理配置"],
    };
  }
  return invoke<ProviderCheck>("bootstrap_server_caddy", {
    name: form.name,
    host: form.host,
    user: form.user,
    keyPath: form.keyPath,
    port: form.port,
    confirmed: true,
  });
}

export async function connectCnb(
  token: string,
  persist: boolean,
): Promise<{ connected: boolean; displayName: string }> {
  if (!isTauri()) return { connected: true, displayName: "示例用户" };
  return invoke("connect_cnb", { token, persist });
}

const demoPreflight: SystemPreflight = {
  operating_system: "macos",
  architecture: "aarch64",
  ready_for_cloud_deploy: true,
  ready_for_local_preview: true,
  tools: [
    {
      name: "Git",
      available: true,
      version: "git version 2.50.1",
      required_for: "读取和同步项目代码",
      resolution: null,
    },
    {
      name: "OpenSSH",
      available: true,
      version: "OpenSSH_10.2",
      required_for: "安全连接目标服务器",
      resolution: null,
    },
    {
      name: "Docker",
      available: true,
      version: "29.4.3",
      required_for: "本地完整预览",
      resolution: null,
    },
    {
      name: "Node.js",
      available: true,
      version: "v22.22.3",
      required_for: "本地开发预览",
      resolution: null,
    },
  ],
};

function demoWorkspace(path: string): WorkspacePreview {
  return {
    manifestExists: false,
    manifestYaml: `version: 1
project:
  name: ecat-energy
source:
  integration_branch: test
  stable_branch: main
environments:
  staging:
    target:
      server: staging-server
    branch: test
    domains: []
    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.staging.yml
  production:
    target:
      server: production-server
    branch: main
    domains: []
    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml
release:
  production_mode: approval
`,
    validation: { valid: true, issues: [] },
    inspection: {
      project_root: path,
      project_name: "ecat-energy",
      package_manager: "pnpm",
      monorepo: true,
      frameworks: [
        {
          framework: "nest_js",
          path: "apps/api",
          confidence: 98,
          evidence: ["依赖 @nestjs/core", "包含构建脚本"],
        },
        {
          framework: "vite",
          path: "apps/admin",
          confidence: 98,
          evidence: ["依赖 vite", "包含构建脚本"],
        },
        {
          framework: "taro",
          path: "apps/miniapp",
          confidence: 98,
          evidence: ["依赖 @tarojs/taro", "包含构建脚本"],
        },
        {
          framework: "prisma",
          path: "prisma/schema.prisma",
          confidence: 100,
          evidence: ["检测到 schema.prisma"],
        },
      ],
      services: [
        {
          id: "api",
          package_name: "@ecat-energy/api",
          path: "apps/api",
          kind: "api",
          framework: "nest_js",
          dockerfile: "apps/api/Dockerfile",
          suggested_port: 3000,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
        {
          id: "admin",
          package_name: "@ecat-energy/admin",
          path: "apps/admin",
          kind: "static",
          framework: "vite",
          dockerfile: "apps/admin/Dockerfile",
          suggested_port: 80,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
        {
          id: "miniapp",
          package_name: "@ecat-energy/miniapp",
          path: "apps/miniapp",
          kind: "static",
          framework: "taro",
          dockerfile: "apps/miniapp/Dockerfile",
          suggested_port: 80,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
      ],
      prisma_schemas: ["prisma/schema.prisma"],
      dockerfiles: [
        "apps/api/Dockerfile",
        "apps/admin/Dockerfile",
        "apps/miniapp/Dockerfile",
      ],
      environment_variables: [
        { name: "DATABASE_URL", secret: true, source: ".env.example" },
        { name: "JWT_SECRET", secret: true, source: ".env.example" },
        { name: "VITE_API_BASE_URL", secret: false, source: ".env.example" },
      ],
      diagnostics: [],
    },
    plan: {
      id: "fb6cbe0ce86dc7ed",
      project: "ecat-energy",
      generated_at: new Date().toISOString(),
      environments: [
        {
          name: "development",
          branch: null,
          target: "本机",
          automatic: false,
          approval_required: false,
        },
        {
          name: "staging",
          branch: "test",
          target: "staging-server",
          automatic: true,
          approval_required: false,
        },
        {
          name: "production",
          branch: "main",
          target: "production-server",
          automatic: false,
          approval_required: true,
        },
      ],
      changes: [
        {
          path: "deploy.yaml",
          kind: "create",
          after: "version: 1\nproject:\n  name: ecat-energy\n",
          sensitive: false,
        },
        {
          path: ".cnb.yml",
          kind: "update",
          before: "main:\n  push: []\n",
          after: "test:\n  push: []\nmain:\n  push: []\n",
          sensitive: false,
        },
        {
          path: ".deploydesk/generated/production/docker-compose.yml",
          kind: "create",
          after: "name: ecat-energy-production\nservices:\n  api:\n    image: ${DEPLOYDESK_API_IMAGE}\n",
          sensitive: false,
        },
      ],
      steps: [
        {
          id: "write-config",
          title: "生成部署配置",
          detail: "写入 deploy.yaml、Compose、Caddy 和流水线配置",
          executor: "local",
          destructive: false,
        },
        {
          id: "verify-build",
          title: "验证并构建程序",
          detail: "在 CNB 标准 Linux 环境执行项目验证命令",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "publish-images",
          title: "制作不可变镜像",
          detail: "镜像以提交版本标识",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "deploy",
          title: "部署并验证测试候选",
          detail: "同步配置，按摘要启动容器并等待健康检查",
          executor: "server",
          destructive: false,
        },
        {
          id: "promote-release",
          title: "晋级已验证镜像",
          detail: "为通过测试的摘要创建提交唯一的验证标记",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "healthcheck",
          title: "部署生产并验证访问",
          detail: "生产复用同一摘要；失败时恢复上一个健康版本",
          executor: "server",
          destructive: false,
        },
      ],
      user_actions: [
        {
          id: "connect-cnb",
          title: "连接 CNB",
          detail: "授权后创建或选择云原生构建仓库",
          category: "authorization",
          required: true,
        },
        {
          id: "server-staging",
          title: "连接测试服务器",
          detail: "验证 SSH 登录",
          category: "server",
          required: true,
        },
        {
          id: "domain-staging",
          title: "填写测试域名",
          detail: "生成 DNS 记录并检查解析",
          category: "dns",
          required: false,
        },
        {
          id: "secrets-staging",
          title: "配置测试环境密钥文件",
          detail: "按生成模板在 CNB Web 端填写",
          category: "secret",
          required: true,
        },
        {
          id: "server-production",
          title: "连接生产服务器",
          detail: "验证 SSH 登录",
          category: "server",
          required: true,
        },
        {
          id: "domain-production",
          title: "填写生产域名",
          detail: "生成 DNS 记录并检查解析",
          category: "dns",
          required: true,
        },
        {
          id: "secrets-production",
          title: "配置生产环境密钥文件",
          detail: "按生成模板在 CNB Web 端填写",
          category: "secret",
          required: true,
        },
        {
          id: "approve-production",
          title: "确认发布生产",
          detail: "生产只拉取测试通过的同一镜像摘要",
          category: "approval",
          required: true,
        },
      ],
      warnings: [],
    },
  };
}
