import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecentProject } from "../types";
import { AppShell } from "./AppShell";

describe("AppShell multi-project workspace", () => {
  it("keeps projects visible and exposes independent deployment states", () => {
    const onOpenProject = vi.fn();
    const onShowProjects = vi.fn();
    render(
      <AppShell
        activePath="/projects/crm"
        loading={false}
        onAddProject={vi.fn()}
        onOpenProject={onOpenProject}
        onShowProjects={onShowProjects}
        preflight={null}
        projects={projects()}
      >
        <div>当前工作区</div>
      </AppShell>,
    );

    expect(screen.getByText("正在部署")).toBeInTheDocument();
    expect(screen.getByText("正式环境正常")).toBeInTheDocument();
    expect(screen.getByText("当前工作区")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /finagent/ }));
    expect(onOpenProject).toHaveBeenCalledWith(projects()[0]);
    fireEvent.click(screen.getByRole("button", { name: "所有项目" }));
    expect(onShowProjects).toHaveBeenCalledTimes(1);
  });
});

function projects(): RecentProject[] {
  return [
    {
      id: "finagent",
      path: "/projects/finagent",
      name: "finagent",
      currentStep: "deploying",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-11T00:00:00Z",
      pathExists: true,
      latestStatus: "running",
      latestEnvironment: "staging",
      latestMessage: "正在构建",
      activeRunCount: 1,
    },
    {
      id: "crm",
      path: "/projects/crm",
      name: "crm",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-11T00:00:00Z",
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "production",
      latestMessage: "生产正常",
      activeRunCount: 0,
    },
  ];
}
