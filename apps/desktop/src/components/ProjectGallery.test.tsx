import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecentProject } from "../types";
import { ProjectGallery } from "./ProjectGallery";

function project(
  overrides: Partial<RecentProject> = {},
): RecentProject {
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
    expect(screen.getByRole("button", { name: "添加项目" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /示例商城，已经上线/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 个服务")).toBeInTheDocument();
    expect(screen.queryByText("运行记录")).not.toBeInTheDocument();
    expect(screen.queryByText(/本机环境/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /示例商城，已经上线/ }),
    );
    expect(onOpen).toHaveBeenCalledWith(current);
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

  it("隐藏项目需要二次确认且明确只移除入口", () => {
    const current = project();
    const { onForget } = renderGallery([current]);

    fireEvent.click(
      screen.getByRole("button", { name: "从列表隐藏 示例商城" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "从列表隐藏 示例商城？",
      }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("项目代码、连接、线路和上线记录都会保留");
    fireEvent.click(within(dialog).getByRole("button", { name: "从列表隐藏" }));
    expect(onForget).toHaveBeenCalledWith(current);
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
