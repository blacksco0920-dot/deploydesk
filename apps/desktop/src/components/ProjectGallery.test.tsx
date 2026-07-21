import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecentProject } from "../types";
import { ProjectGallery } from "./ProjectGallery";

function project(overrides: Partial<RecentProject> = {}): RecentProject {
  return {
    activeRunCount: 0,
    currentStep: "workspace",
    id: "sample",
    lastOpenedAt: new Date().toISOString(),
    latestEnvironment: "deployment",
    latestMessage: "上线完成",
    latestStatus: "success",
    manifestExists: true,
    name: "示例商城",
    path: "/projects/sample",
    pathExists: true,
    serviceCount: 3,
    ...overrides,
  };
}

function renderGallery(projects: RecentProject[] = [project()]) {
  const onForget = vi.fn();
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  render(
    <ProjectGallery
      loading={false}
      onForget={onForget}
      onOpen={onOpen}
      onSelect={onSelect}
      projects={projects}
      taskRuns={[]}
    />,
  );
  return { onForget, onOpen, onSelect };
}

describe("ProjectGallery", () => {
  it("首页只呈现项目入口，不重复展示项目级运行记录和本机提示", () => {
    const current = project();
    const { onOpen } = renderGallery([current]);

    expect(
      screen.getByRole("heading", { name: "所有项目" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加项目" }),
    ).toBeInTheDocument();
    const pageHeader = screen.getByRole("banner");
    expect(pageHeader).toContainElement(
      screen.getByRole("heading", { name: "所有项目" }),
    );
    expect(pageHeader).toContainElement(
      screen.getByRole("textbox", { name: "搜索项目" }),
    );
    expect(
      screen.getByRole("button", { name: /示例商城，已经上线/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 个服务")).toBeInTheDocument();
    expect(screen.getByText("打开工作流 ›")).toBeInTheDocument();
    expect(screen.queryByText("运行记录")).not.toBeInTheDocument();
    expect(screen.queryByText(/本机环境/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /示例商城，已经上线/ }));
    expect(onOpen).toHaveBeenCalledWith(current);
  });

  it("项目卡片直接给出与当前状态一致的下一步", () => {
    renderGallery([
      project(),
      project({
        id: "attention",
        latestStatus: "failed",
        name: "需要处理的项目",
        path: "/projects/attention",
      }),
      project({
        id: "setup",
        latestEnvironment: null,
        latestStatus: null,
        name: "待设置项目",
        path: "/projects/setup",
      }),
    ]);

    expect(screen.getByText("打开工作流 ›")).toBeInTheDocument();
    expect(screen.getByText("继续处理 ›")).toBeInTheDocument();
    expect(screen.getByText("继续设置 ›")).toBeInTheDocument();
  });

  it("只有真实上线成功的项目使用绿色成功状态，未开始项目保持中性", () => {
    renderGallery([
      project(),
      project({
        id: "not-started",
        latestEnvironment: null,
        latestStatus: null,
        name: "尚未开始项目",
        path: "/projects/not-started",
      }),
    ]);

    const onlineCard = screen
      .getByRole("button", { name: /示例商城，已经上线/ })
      .closest("article");
    const notStartedCard = screen
      .getByRole("button", { name: /尚未开始项目，尚未开始上线/ })
      .closest("article");

    expect(onlineCard?.querySelector("[data-project-status-tone]")).toHaveAttribute(
      "data-project-status-tone",
      "success",
    );
    expect(
      notStartedCard?.querySelector("[data-project-status-tone]"),
    ).toHaveAttribute("data-project-status-tone", "neutral");
    expect(notStartedCard?.querySelector(".lucide-check-circle-2")).toBeNull();
    expect(notStartedCard?.querySelector(".lucide-circle")).not.toBeNull();
  });

  it("搜索和状态筛选只改变项目卡片，不引入额外一级页面", () => {
    renderGallery([
      project(),
      project({
        id: "attention",
        latestEnvironment: "deployment",
        latestStatus: "failed",
        name: "客户门户",
        path: "/projects/customer",
      }),
    ]);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目" }), {
      target: { value: "客户" },
    });
    expect(
      screen.getByRole("button", { name: /客户门户，上次上线没有完成/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /示例商城，已经上线/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "需要处理" }));
    expect(
      screen.getByRole("button", { name: /客户门户，上次上线没有完成/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /示例商城，已经上线/ }),
    ).not.toBeInTheDocument();
  });

  it("隐藏项目需要通过真实菜单二次确认且明确只移除入口", async () => {
    const current = project();
    const { onForget } = renderGallery([current]);

    fireEvent.click(screen.getByRole("button", { name: "项目操作：示例商城" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "从列表隐藏" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "从列表隐藏 示例商城？",
      }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("项目代码、连接、线路和上线记录都会保留");
    fireEvent.click(within(dialog).getByRole("button", { name: "从列表隐藏" }));
    expect(onForget).toHaveBeenCalledWith(current);
    // Semi Dropdown defers its final position cleanup to a short timer.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  });

  it("没有项目时给出唯一的添加动作", () => {
    const { onSelect } = renderGallery([]);
    expect(
      screen.getByRole("heading", { name: "添加第一个项目" }),
    ).toBeInTheDocument();
    const addButtons = screen.getAllByRole("button", { name: "添加项目" });
    expect(addButtons).toHaveLength(2);
    fireEvent.click(addButtons[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
