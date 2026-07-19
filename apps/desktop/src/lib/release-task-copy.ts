import type { DeploymentRun } from "../types";

export type ReleaseSetupBlocker =
  | "source-connection"
  | "registry-connection"
  | "test-server"
  | "test-config"
  | "test-address"
  | "automation";

export interface ReleaseTaskCopy {
  title: string;
  message: string;
  action: string;
}

const SETUP_COPY: Record<ReleaseSetupBlocker, ReleaseTaskCopy> = {
  "source-connection": {
    title: "先连接代码平台",
    message:
      "选择一个可用的 CNB 连接和代码仓库，后续更新授权不需要重新添加项目。",
    action: "连接代码平台",
  },
  "registry-connection": {
    title: "连接版本保存位置",
    message:
      "第一次生成远程版本前，需要选择服务器可以读取的镜像仓库；首版推荐腾讯云 TCR。",
    action: "连接版本存储",
  },
  "test-server": {
    title: "选择测试服务器",
    message:
      "选择测试版本实际运行的 Linux 服务器；正式服务器稍后可以单独设置。",
    action: "连接测试服务器",
  },
  "test-config": {
    title: "补全测试配置",
    message: "为测试环境绑定配置中心已有值，或直接补齐当前缺少的必填项。",
    action: "补全测试配置",
  },
  "test-address": {
    title: "设置测试地址",
    message: "确认测试版本完成后用于验收的访问地址。",
    action: "设置测试地址",
  },
  automation: {
    title: "开启测试环境自动更新",
    message: "完成后，代码合并到 main 会自动生成新版本并更新测试环境。",
    action: "开启自动部署",
  },
};

export function setupTaskCopy(
  blocker: string | null | undefined,
): ReleaseTaskCopy {
  if (blocker && blocker in SETUP_COPY) {
    return SETUP_COPY[blocker as ReleaseSetupBlocker];
  }
  return {
    title: "准备生成第一个测试版",
    message: "系统只会询问第一次远程构建和测试环境真正缺少的信息。",
    action: "开始上线设置",
  };
}

export function legacySetupStepBlocker(
  step: string | null | undefined,
): ReleaseSetupBlocker | null {
  switch (step) {
    case "repository":
      return "source-connection";
    case "registry":
      return "registry-connection";
    case "test-environment":
      return "test-server";
    case "remote":
      return "automation";
    default:
      return null;
  }
}

export function recoveryTaskCopy(
  run: DeploymentRun | null | undefined,
  environment?: "staging" | "production",
): ReleaseTaskCopy {
  const production = environment
    ? environment === "production"
    : run?.environment === "production";
  const suffix = production ? "正式发布" : "测试部署";
  const code = run?.issueCode ?? "";
  const stage = run?.currentStage ?? "";
  const action = run?.actionKind ?? "";

  // The persisted user action is more precise than the internal stage/error
  // that produced it. For example a safe Caddy route takeover can still carry
  // an AD-SRV code because it paused during prepare-server; telling the user to
  // replace the SSH connection would send them to the wrong place.
  if (action === "route-takeover") {
    return {
      title: production ? "正式地址等待确认" : "测试地址等待确认",
      message:
        "当前地址正被已有规则使用；确认后系统会先备份，再安全切换到这个版本。",
      action: "确认地址接管",
    };
  }
  if (action === "route-repair") {
    return {
      title: production ? "正式地址需要修复" : "测试地址需要修复",
      message: "服务和版本都会保留，只继续修复当前访问地址。",
      action: "继续修复地址",
    };
  }
  if (action === "route-check") {
    return {
      title: `${suffix}只差访问地址`,
      message: "服务部署结果会被保留；完成域名或 HTTPS 处理后只继续地址检查。",
      action: "检查访问地址",
    };
  }

  // A successful deployment discovered while taking over an existing project
  // is not a new failed release. The clean client simply does not have the
  // server connection needed to compare the remote image digest yet. Keep the
  // historical fact and ask for the one missing local relationship instead of
  // telling the user that production itself failed.
  if (code === "AD-REL-201" || action === "verify-existing-deployment") {
    return {
      title: "已有部署等待核对",
      message:
        "代码平台记录显示这个环境以前部署成功；连接对应服务器后核对当前运行版本，不会重新部署。",
      action: "连接服务器并核对",
    };
  }

  if (code.startsWith("AD-CNB-") || code.startsWith("AD-GIT-")) {
    return {
      title: `${suffix}暂停在代码平台`,
      message: "更新 CNB 授权后会继续同一个任务，版本、服务器和配置不会丢失。",
      action: "更新代码平台授权",
    };
  }
  if (code.startsWith("AD-REG-") || code.startsWith("AD-IMG-")) {
    return {
      title: `${suffix}暂停在版本存储`,
      message: "更新镜像仓库连接后从当前阶段继续，不会重新创建项目。",
      action: "更新版本存储授权",
    };
  }
  if (
    code.startsWith("AD-SSH-") ||
    code.startsWith("AD-SRV-") ||
    stage === "prepare-server"
  ) {
    return {
      title: `${suffix}暂停在运行服务器`,
      message: "更换或确认当前环境的服务器连接后，会继续原来的版本。",
      action: "更换服务器连接",
    };
  }
  if (code.startsWith("AD-CFG-") || stage === "write-config") {
    return {
      title: `${suffix}还缺运行配置`,
      message: `补全${production ? "正式" : "测试"}配置后继续同一个任务，不会重新构建镜像。`,
      action: `补全${production ? "正式" : "测试"}配置`,
    };
  }
  if (code.startsWith("AD-NET-") || code.startsWith("AD-WEB-")) {
    return {
      title: `${suffix}只差访问地址`,
      message: "服务部署结果会被保留；完成域名或 HTTPS 处理后只继续地址检查。",
      action: "检查并继续",
    };
  }
  return {
    title: `${suffix}还需要处理`,
    message: run?.message
      ? `${run.message}。处理后会继续同一个任务。`
      : "处理当前问题后会继续同一个任务，不会从头开始。",
    action: production ? "继续完成发布" : "继续处理",
  };
}
