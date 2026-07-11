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
    title,
    message: coded?.[2] ?? message,
    nextSteps: nextStepsForCode(coded?.[1]),
    technicalDetails: coded ? [] : [message],
    retryable: true,
  };
}

function nextStepsForCode(code?: string): string[] {
  if (code === "AD-CNB-101") return ["重新连接 CNB，然后回到当前任务刷新状态"];
  if (code === "AD-CNB-102") return ["检查网络能否访问 cnb.cool，然后重新尝试"];
  if (code === "AD-CNB-103")
    return ["按连接页提示补充令牌权限，或让组织管理员提升当前账号角色"];
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
  if (code === "AD-NET-201")
    return ["修正 DNS 或 HTTPS 后重新检查，无需重新构建"];
  return ["确认当前页面的检查项，处理后重新尝试"];
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
