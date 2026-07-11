import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import type { OnboardingStep } from "../../types";
import { Brand } from "../Brand";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const orderedSteps: OnboardingStep[] = [
  "inspection",
  "connections",
  "recommendation",
  "requirements",
  "review",
];

interface OnboardingLayoutProps {
  children: ReactNode;
  footer: ReactNode;
  projectName: string;
  step: OnboardingStep;
  onBack?: () => void;
  onClose: () => void;
}

export function OnboardingLayout({
  children,
  footer,
  projectName,
  step,
  onBack,
  onClose,
}: OnboardingLayoutProps) {
  const index = Math.max(0, orderedSteps.indexOf(step));
  const deploying = step === "deploying";
  const progress = deploying
    ? 100
    : Math.round(((index + 1) / orderedSteps.length) * 100);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="grid h-full min-h-0 grid-rows-[56px_1fr_auto] bg-[var(--background)]">
        <header
          className="relative flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4"
          data-tauri-drag-region
        >
          <div className="flex min-w-0 items-center gap-4">
            <Brand />
            <span className="hidden h-5 w-px bg-[var(--border)] sm:block" />
            <span className="hidden max-w-60 truncate text-xs text-[var(--muted-foreground)] sm:block">
              {projectName}
            </span>
          </div>
          <div className="absolute bottom-[-1px] left-0 right-0">
            <Progress
              className="h-0.5 rounded-none bg-transparent"
              value={progress}
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="返回项目首页"
                onClick={onClose}
                size="icon"
                variant="ghost"
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>保存进度并返回</TooltipContent>
          </Tooltip>
        </header>

        <main className="min-h-0 overflow-auto" key={step}>
          <div className="mx-auto w-full max-w-[760px] px-6 py-10 sm:py-12">
            <div className="mb-7 flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
              <span>
                {deploying
                  ? "配置已确认"
                  : `第 ${index + 1} 步，共 ${orderedSteps.length} 步`}
              </span>
              <span className="h-px flex-1 bg-[var(--border)]" />
              <span>{stepName(step)}</span>
            </div>
            {children}
          </div>
        </main>

        <footer className="border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
          <div className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-3">
            <div>
              {onBack ? (
                <Button onClick={onBack} variant="ghost">
                  <ArrowLeft />
                  上一步
                </Button>
              ) : null}
            </div>
            {footer}
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}

function stepName(step: OnboardingStep) {
  return {
    inspection: "确认识别结果",
    connections: "连接所需服务",
    recommendation: "确认推荐方案",
    requirements: "补充必要信息",
    review: "部署前确认",
    deploying: "正在部署",
    workspace: "项目工作台",
  }[step];
}
