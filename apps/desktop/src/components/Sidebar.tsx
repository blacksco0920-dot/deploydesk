import {
  Boxes,
  Cable,
  CheckCircle2,
  CircleAlert,
  FolderKanban,
  GitBranch,
  ListChecks,
  Server,
} from "lucide-react";
import type {
  NavigationSection,
  SystemPreflight,
} from "../types";

interface SidebarProps {
  active: NavigationSection;
  hasWorkspace: boolean;
  preflight: SystemPreflight | null;
  onChange: (section: NavigationSection) => void;
}

const navigation = [
  { id: "overview" as const, label: "项目识别", icon: FolderKanban },
  { id: "environments" as const, label: "环境配置", icon: Server },
  { id: "connections" as const, label: "服务连接", icon: Cable },
  { id: "plan" as const, label: "部署计划", icon: ListChecks },
];

export function Sidebar({
  active,
  hasWorkspace,
  preflight,
  onChange,
}: SidebarProps) {
  const ready = preflight?.ready_for_cloud_deploy ?? false;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Boxes size={20} strokeWidth={2.2} />
        </span>
        <div>
          <strong>DeployDesk</strong>
          <span>容器化部署工作台</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label="项目配置">
        <span className="nav-label">工作区</span>
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <button
              aria-label={item.label}
              className={active === item.id ? "nav-item active" : "nav-item"}
              disabled={!hasWorkspace && item.id !== "overview"}
              key={item.id}
              onClick={() => onChange(item.id)}
              title={item.label}
              type="button"
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-flow" aria-label="默认发布流程">
        <span className="nav-label">默认流程</span>
        <div className="flow-line">
          <GitBranch size={15} />
          <span>test</span>
          <span className="flow-arrow">→</span>
          <span>测试环境</span>
        </div>
        <div className="flow-line">
          <GitBranch size={15} />
          <span>main</span>
          <span className="flow-arrow">→</span>
          <span>生产环境</span>
        </div>
      </div>

      <div className={ready ? "system-summary ready" : "system-summary pending"}>
        {ready ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
        <div>
          <strong>{ready ? "云端部署就绪" : "环境待检查"}</strong>
          <span>
            {preflight
              ? `${preflight.operating_system} / ${preflight.architecture}`
              : "正在检查本机"}
          </span>
        </div>
      </div>
    </aside>
  );
}
