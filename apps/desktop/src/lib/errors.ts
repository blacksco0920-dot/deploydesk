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
  if (code === "AD-CNB-103") return ["按连接页提示补充最小权限后重试"];
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
