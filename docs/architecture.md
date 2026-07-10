# 架构设计

## 目标

ABCDeploy 把部署拆成可检查的模型、确定性生成和受控执行三层。桌面端负责引导，不直接拼接部署脚本；CLI 和桌面端共同调用 Rust 核心，确保同一项目得到同一 Plan。

## 模块

```mermaid
flowchart TB
  UI[Tauri + React 桌面端] --> IPC[Tauri IPC]
  CLI[deployctl] --> CORE[deploy-core]
  IPC --> CORE
  CORE --> SCAN[项目扫描器]
  CORE --> SCHEMA[deploy.yaml Schema 与校验]
  CORE --> PLAN[Plan / Diff / 原子写入]
  CORE --> RENDER[Compose / Caddy / CNB / GitHub 生成器]
  CORE --> JOURNAL[发布与恢复记录]
  CORE --> PROVIDERS[Provider 边界]
  PROVIDERS --> CNB[CNB OpenAPI]
  PROVIDERS --> REG[CNB Registry / TCR]
  PROVIDERS --> SSH[SSH]
  PROVIDERS --> DOCKER[Docker Compose]
  PROVIDERS --> CADDY[Caddy]
```

### `deploy-core`

- `scanner`：只读遍历受限深度，忽略 `.git`、`node_modules`、构建产物；解析 `package.json`，只读取 `.env.example` 的键名。
- `model`：项目、服务、三环境、Provider、发布策略、Plan 和恢复记录的强类型模型。
- `manifest`：YAML 解析、JSON Schema、隔离规则和注入防护。
- `render`：确定性生成 Compose、Caddy、CNB 和 GitHub 工作流。
- `plan`：比较写入前后内容、统一脱敏、校验相对路径、原子写入和备份。
- `journal`：记录发布摘要、已完成步骤、失败原因和上一个健康版本。
- `providers`：CNB、镜像仓库、SSH、Docker Compose 和 Caddy 的外部边界。

### `deployctl`

命令行是核心能力的薄适配层。它适合 CI、自动化测试和桌面端无法启动时排障，不维护第二份部署逻辑。

### `apps/desktop`

React 只持有当前表单草稿和展示状态。项目扫描、Schema 校验、Plan、写入、密钥库和外部连接都通过 Tauri IPC 进入 Rust。最近项目、服务器资源和部署记录由 Rust 写入本机 SQLite，重新打开应用可以恢复到原步骤。

真实 Token 使用操作系统密钥库：

- macOS：Keychain
- Windows：Credential Manager
- Linux：Secret Service/兼容后端

## 数据流

1. 用户选择项目目录。
2. 扫描器生成 `InspectionReport`，不读取真实 `.env`。
3. 若不存在 `deploy.yaml`，核心根据识别结果生成默认 Manifest。
4. Schema 校验环境隔离、仓库路径、域名、镜像标签和密钥引用。
5. Render 生成候选文件；Plan 读取现有文件并产生脱敏 Diff。
6. 用户确认后，Apply 先备份已有文件，再逐个原子替换。
7. 桌面端只暂存并提交自己拥有的部署文件，通过临时认证 Header 同步到 CNB。
8. CNB 构建一次不可变镜像，先部署测试环境；生产从成功记录取得完整提交 SHA 并精确晋级。

## 三环境模型

环境、分支和服务器是三个字段，不是同一个概念：

```text
EnvironmentConfig
  target.kind       local | server
  target.server     逻辑服务器名
  target.namespace  容器/网络隔离名
  branch            默认触发分支，可修改
  domains           服务路由
  database          可选，只有检测到数据库时生成
  redis_namespace   可选，只有检测到 Redis 时生成
  secrets_ref       本地密钥库或 CNB 密钥文件
```

测试和生产即使在同一物理服务器，也必须使用不同 namespace、数据库名称、Redis 前缀、密钥文件和发布记录。

## 服务器目录

ABCDeploy 使用远程登录用户自己的目录，不默认要求 root：

```text
~/.deploydesk/
  apps/<project>/<environment>/
    docker-compose.yml
    .runtime.env
    .release.env
    Caddyfile
    .history/
  caddy/
    Caddyfile
    docker-compose.yml
    sites/
    data/
    config/
```

`.deploydesk` 是已发布部署协议的兼容路径。V2 保留它以避免破坏在线项目，产品品牌和新接口统一使用 ABCDeploy。

每个项目/环境有唯一 Docker 网络和服务别名，例如 `shop-production-api`。中央 Caddy 可以连接多个网络，而不会把不同项目都叫作 `api` 的服务解析错。

## 发布事务

远程更新采用 `.next` 和 `.previous`：

1. CNB 在本地生成 `.runtime.env` 与 `.release.env`。
2. 通过严格 host key 校验的 SCP 上传为 `.next`。
3. 服务器备份当前 Compose、运行变量、摘要记录和 Caddy 片段。
4. 原子替换，执行 `docker compose config`、`pull`、`up --wait`。
5. 成功后写入 `.history/<release>.env` 并 reload Caddy。
6. 失败且存在上一版本时，恢复 `.previous` 并重新启动。

数据库迁移不属于可无条件回滚的文件事务。Alpha 只声明迁移命令；没有经过验证的备份 Provider 时不自动执行生产迁移。

## 扩展 Provider

Provider 应满足以下约束：

- 输入使用结构化类型，不接收任意 shell 片段。
- 错误先脱敏再进入 UI/日志。
- 只读检查和写操作分开；写操作需要显式确认。
- 所有外部标识先校验或编码。
- 测试可以替换 API Base URL 或使用隔离资源，不依赖生产状态。

计划中的后续扩展包括 GitLab/Gitee 源码、其他制品库、DNS Provider 和可插拔数据库备份 Provider。
