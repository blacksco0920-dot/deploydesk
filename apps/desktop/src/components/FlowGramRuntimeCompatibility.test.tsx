import "@flowgram.ai/free-layout-editor/index.css";
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
} from "@flowgram.ai/free-layout-editor";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentWorkflowCanvas } from "./DeploymentWorkflowCanvas";

class FlowGramResizeObserver implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

vi.stubGlobal("ResizeObserver", FlowGramResizeObserver);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FlowGram runtime compatibility", () => {
  it("initializes one renderer registry and mounts FlowGram's real EditorRenderer", async () => {
    render(
      <FreeLayoutEditorProvider
        initialData={{ edges: [], nodes: [] }}
        nodeEngine={{ enable: false }}
      >
        <div aria-label="real FlowGram renderer">
          <EditorRenderer />
        </div>
      </FreeLayoutEditorProvider>,
    );

    expect(screen.getByLabelText("real FlowGram renderer")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.querySelector(".gedit-playground-container"),
      ).toBeInTheDocument(),
    );
  });

  it("mounts the production deployment canvas without mocking FlowGram's provider", async () => {
    const boundingRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 640,
        height: 640,
        left: 0,
        right: 1024,
        top: 0,
        width: 1024,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

    render(
      <div style={{ height: 640, width: 1024 }}>
        <DeploymentWorkflowCanvas
          activeNode={null}
          fitViewRevision="runtime-compatibility"
          nodes={[
            {
              description: "确定本次上线使用的代码",
              id: "local",
              provider: "本地项目",
              statusLabel: "项目可用",
              summary: "已识别 1 个项目服务",
              title: "代码来源",
              tone: "ready",
            },
            {
              description: "把代码生成可运行版本",
              id: "build",
              provider: "CNB",
              statusLabel: "构建服务可用",
              summary: "连接正常",
              title: "版本构建",
              tone: "ready",
            },
            {
              description: "保存不可变的上线版本",
              id: "registry",
              provider: "TCR",
              statusLabel: "版本仓库可用",
              summary: "登录信息可用",
              title: "版本存储",
              tone: "ready",
            },
            {
              description: "运行项目并提供访问地址",
              id: "server",
              provider: "Linux 服务器",
              statusLabel: "运行服务器可用",
              summary: "1 个访问地址",
              title: "部署运行",
              tone: "ready",
            },
          ]}
          onSelectNode={vi.fn()}
        />
      </div>,
    );

    expect(
      screen.getByRole("region", { name: "部署工作流画布" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /代码来源/ }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /版本构建/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本存储/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /部署运行/ }),
    ).toBeInTheDocument();
    expect(boundingRect).toHaveBeenCalled();
  });
});
