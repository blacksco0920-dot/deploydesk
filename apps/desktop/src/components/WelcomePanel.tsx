import {
  ArrowRight,
  Check,
  CloudCog,
  FolderOpen,
  ScanSearch,
  ServerCog,
} from "lucide-react";

interface WelcomePanelProps {
  loading: boolean;
  showDemo: boolean;
  onSelect: () => void;
  onDemo: () => void;
}

export function WelcomePanel({
  loading,
  showDemo,
  onSelect,
  onDemo,
}: WelcomePanelProps) {
  return (
    <div className="welcome-panel">
      <header className="page-heading compact-heading">
        <div>
          <span className="eyebrow">新项目接入</span>
          <h1>选择一个项目目录</h1>
          <p>DeployDesk 会先只读识别项目，再让你确认所有文件变化。</p>
        </div>
      </header>

      <section className="workspace-picker" aria-label="选择项目">
        <button
          className="primary-action large-action"
          disabled={loading}
          onClick={onSelect}
          type="button"
        >
          <FolderOpen size={19} />
          {loading ? "正在识别项目" : "选择项目目录"}
        </button>
        {showDemo ? (
          <button className="text-action" onClick={onDemo} type="button">
            查看 Ecat 识别示例
            <ArrowRight size={16} />
          </button>
        ) : null}
      </section>

      <section className="onboarding-track" aria-label="接入步骤">
        <div className="track-item">
          <span className="track-icon">
            <ScanSearch size={20} />
          </span>
          <div>
            <strong>识别项目</strong>
            <span>服务、框架和环境变量名称</span>
          </div>
          <Check size={16} className="track-check" />
        </div>
        <div className="track-item">
          <span className="track-icon blue">
            <ServerCog size={20} />
          </span>
          <div>
            <strong>配置环境</strong>
            <span>开发、测试和生产相互隔离</span>
          </div>
        </div>
        <div className="track-item">
          <span className="track-icon amber">
            <CloudCog size={20} />
          </span>
          <div>
            <strong>确认计划</strong>
            <span>预览文件变化后再启用部署</span>
          </div>
        </div>
      </section>

      <footer className="safety-note">
        <Check size={16} />
        <span>不会读取环境变量值，不会修改服务器或生产数据。</span>
      </footer>
    </div>
  );
}
