import { FolderGit2, History, LoaderCircle, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { WorkspacePreview } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type AdoptionAction = "continue" | "reset" | null;

export function ExistingDeploymentChoice({
  action,
  onContinue,
  onReset,
  path,
  workspace,
}: {
  action: AdoptionAction;
  onContinue: () => void;
  onReset: () => void;
  path: string;
  workspace: WorkspacePreview;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const projectName =
    workspace.inspection.project_name ||
    path.split(/[\\/]/).filter(Boolean).pop() ||
    "项目";
  const busy = action !== null;

  return (
    <div className="grid h-full min-h-0 grid-rows-[58px_minmax(0,1fr)] bg-[var(--background)]">
      <header className="flex items-center border-b border-[var(--border)] bg-[var(--surface)] px-6">
        <div className="min-w-0">
          <strong className="block truncate text-sm font-semibold">
            {projectName}
          </strong>
          <span className="block max-w-[640px] truncate text-[11px] text-[var(--muted-foreground)]">
            {path}
          </span>
        </div>
      </header>

      <main className="min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-[860px] px-6 py-10">
          <div className="flex size-11 items-center justify-center rounded-lg bg-[var(--muted)] text-[var(--foreground)]">
            <FolderGit2 className="size-5" />
          </div>
          <h1 className="mt-5 text-[28px] font-semibold leading-tight">
            检测到已有上线配置
          </h1>
          <p className="mt-2 max-w-[680px] text-sm leading-6 text-[var(--muted-foreground)]">
            这个项目以前设置过自动构建或部署。请选择继续管理原来的上线，还是只在
            ABCDeploy 中重新开始。
          </p>

          <div className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="block text-xs text-[var(--muted-foreground)]">
                  代码仓库
                </span>
                <strong className="mt-1 block font-medium">
                  {workspace.adoption.repository || "已在项目中识别"}
                </strong>
              </div>
              <div>
                <span className="block text-xs text-[var(--muted-foreground)]">
                  自动构建
                </span>
                <strong className="mt-1 block font-medium">
                  {workspace.adoption.pipelineExists
                    ? "已发现配置"
                    : "尚未发现配置"}
                </strong>
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <section className="flex min-h-[220px] flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <History className="size-5 text-[var(--accent)]" />
              <h2 className="mt-4 text-base font-semibold">继续原来的上线</h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-[var(--muted-foreground)]">
                读取已有版本和部署记录，接着管理测试环境与正式环境。不会重新部署，也不会修改服务器。
              </p>
              <Button
                className="mt-5 w-full"
                disabled={busy}
                onClick={onContinue}
              >
                {action === "continue" ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                继续管理已有部署
              </Button>
            </section>

            <section className="flex min-h-[220px] flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <RotateCcw className="size-5 text-[var(--muted-foreground)]" />
              <h2 className="mt-4 text-base font-semibold">从头设置一次</h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-[var(--muted-foreground)]">
                清除这个项目在 ABCDeploy
                内的部署记录和服务器绑定，从项目设置重新开始。
              </p>
              <Button
                className="mt-5 w-full"
                disabled={busy}
                onClick={() => setConfirmReset(true)}
                variant="secondary"
              >
                {action === "reset" ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                重新设置部署
              </Button>
            </section>
          </div>

          <p className="mt-5 text-xs leading-5 text-[var(--muted-foreground)]">
            做出选择前，ABCDeploy 不会同步历史部署，也不会连接服务器。
          </p>
        </div>
      </main>

      <Dialog onOpenChange={setConfirmReset} open={confirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确定重新设置部署？</DialogTitle>
            <DialogDescription>
              将清除这个项目在 ABCDeploy
              中保存的版本记录、待办和服务器绑定，然后从项目设置重新开始。项目代码、代码仓库、远程镜像和服务器上正在运行的服务都不会被删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setConfirmReset(false)}
              variant="secondary"
            >
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmReset(false);
                onReset();
              }}
            >
              确认重新设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
