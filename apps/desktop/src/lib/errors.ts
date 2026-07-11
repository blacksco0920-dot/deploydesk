import type { ProviderCheck, UserFacingIssue } from "../types";

const CODE_PATTERN = /^(AD-[A-Z]+-\d{3})[：:]\s*(.+)$/;

export function issueFromProvider(
  check: ProviderCheck,
  title = "无法准备目标服务器",
): UserFacingIssue {
  return {
    code: check.code ?? "AD-SRV-299",
    title,
    message: check.summary,
    nextSteps: check.nextSteps?.length
      ? check.nextSteps
      : ["展开技术详情确认原因，处理后点击重新检查并继续"],
    technicalDetails: check.details,
    retryable: check.retryable ?? true,
  };
}

export function issueFromUnknown(
  error: unknown,
  title = "操作没有完成",
): UserFacingIssue {
  if (isUserFacingIssue(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const coded = message.match(CODE_PATTERN);
  return {
    code: coded?.[1] ?? "AD-APP-001",
    title: titleForCode(coded?.[1]) ?? title,
    message: coded?.[2] ?? message,
    nextSteps: nextStepsForCode(coded?.[1]),
    technicalDetails: coded ? [] : [message],
    retryable: true,
  };
}

function nextStepsForCode(code?: string): string[] {
  if (code === "AD-GIT-101")
    return ["回到编程工具提交这些改动，或明确选择部署上次已提交版本"];
  if (code === "AD-GIT-102")
    return ["让编程工具安全同步 main 与当前分支；不要强制覆盖远端"];
  if (code === "AD-SYS-101") return ["重新点击复制；仍失败时重新启动客户端"];
  if (code === "AD-SYS-102")
    return ["配置已经复制，请在浏览器中手动打开 cnb.cool"];
  if (code === "AD-CNB-101") return ["重新连接 CNB，然后回到当前任务刷新状态"];
  if (code === "AD-CNB-102") return ["检查网络能否访问 cnb.cool，然后重新尝试"];
  if (code === "AD-CNB-103")
    return [
      "客户端已先尝试复用代码推送产生的自动构建；仍失败时，按连接页提示补充对应令牌权限",
    ];
  if (code === "AD-CNB-104")
    return ["返回 CNB 连接步骤刷新组织；没有组织时先在 CNB 创建组织"];
  if (code === "AD-CNB-105")
    return ["选择已有 CNB 组织，并使用字母、数字、点、横线或下划线命名"];
  if (code === "AD-CNB-106")
    return ["在 CNB 网页确认同名仓库权限，或选择另一个仓库名"];
  if (code === "AD-CNB-107") return ["等待一分钟，再重新点击自动准备"];
  if (code === "AD-CNB-199")
    return ["重新连接 CNB 后再试；仍失败时查看技术详情"];
  if (code === "AD-REL-201")
    return ["重新验证目标服务器连接，然后刷新部署状态"];
  if (code === "AD-REL-301") return ["重新部署测试环境，再发布新的已验证候选"];
  if (code === "AD-CTR-201")
    return [
      "查看提示的服务启动日志；修复端口、依赖或健康检查后重新部署测试",
    ];
  if (code === "AD-CFG-201")
    return ["按提示在 CNB 密钥仓库补齐字段，保存后从当前步骤重试"];
  if (code === "AD-SSH-201")
    return ["返回资源页重新验证服务器，并更新测试环境的 SSH 凭据"];
  if (code === "AD-SRV-208")
    return ["清理目标服务器磁盘空间，确认 Docker 可用后从当前步骤重试"];
  if (code === "AD-IMG-201")
    return ["重新检查镜像仓库账号和拉取权限，然后从当前步骤重试"];
  if (code === "AD-NET-201")
    return ["修正 DNS 或 HTTPS 后重新检查，无需重新构建"];
  return ["确认当前页面的检查项，处理后重新尝试"];
}

function titleForCode(code?: string): string | undefined {
  if (code === "AD-GIT-101") return "项目改动还没有提交";
  if (code === "AD-GIT-102") return "部署分支需要先同步";
  if (code === "AD-SYS-101") return "配置没有复制成功";
  if (code === "AD-SYS-102") return "系统浏览器没有打开";
  if (code === "AD-CNB-103") return "CNB 权限还差一步";
  if (code === "AD-CTR-201") return "服务没有正常启动";
  if (code === "AD-CFG-201") return "测试环境配置还缺内容";
  if (code === "AD-SSH-201") return "服务器登录凭据已失效";
  if (code === "AD-SRV-208") return "服务器磁盘空间不足";
  if (code === "AD-IMG-201") return "容器镜像无法读取";
  return undefined;
}

function isUserFacingIssue(value: unknown): value is UserFacingIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Partial<UserFacingIssue>;
  return (
    typeof issue.code === "string" &&
    typeof issue.title === "string" &&
    typeof issue.message === "string" &&
    Array.isArray(issue.nextSteps) &&
    Array.isArray(issue.technicalDetails) &&
    typeof issue.retryable === "boolean"
  );
}
