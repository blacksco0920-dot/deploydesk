# ABCDeploy 底层技术能力

> 对齐日期：2026-07-19。本文只归纳可复用的技术能力和架构约束，不规定页面文案。面向用户的四节点线路以[产品实施合同](product-contract.md)为唯一权威；本文记录该产品合同背后的真实执行能力。

## 1. 文档目的

ABCDeploy 的真正技术资产是一套把本地项目安全转换为不可变版本，再放到用户指定运行服务器的交付引擎。测试服务器、正式服务器或演示服务器在底层都是彼此独立的部署线路，不构成强制晋级链。

底层链路可以概括为：

```text
识别项目与服务
    ↓
核对代码来源
    ↓
生成并保存不可变版本
    ↓
把版本部署到指定线路
    ↓
核对服务、地址和业务结果
    ↓
保留证据、支持重试与恢复
```

CNB、腾讯云 TCR、Linux、Docker Compose 和 Caddy 是首版适配器，不是领域模型本身。未来可以增加其他代码平台、OCI Registry、运行目标和 DNS Provider，而不重做 DeploymentPath、Version、Task、Attempt 等核心模型。

## 2. 状态口径

本文使用三种状态，避免把设计稿当成运行时事实：

| 状态 | 含义 |
| --- | --- |
| 运行时代码 | 当前仓库已有对应命令、数据结构或 Provider 实现；仍需按版本执行集成和实机验收，不能直接等同于正式可用 |
| 架构契约 | 已在文档和静态原型中验证，应作为后续实现约束；当前桌面运行时可能只实现了一部分 |
| 明确缺口 | 已知尚未形成端到端闭环，不得在页面上表示为已完成能力 |

## 3. 当前能力清单

| 能力域 | 已保留的底层能力 | 当前状态 | 主要代码位置 |
| --- | --- | --- | --- |
| 项目识别 | 扫描项目、识别框架和服务、规范化项目路径、保存最近项目、迁移移动后的项目身份 | 运行时代码 | `crates/deploy-core/src/scanner.rs`、`apps/desktop/src-tauri/src/workspace.rs` |
| 本机运行 | 生成本机运行计划；整体或逐服务启动、停止；管理 PostgreSQL/Redis；检测端口；支持稳定运行和开发调试准备 | 运行时代码 | `apps/desktop/src-tauri/src/lib.rs`、`crates/deploy-core/src/plan.rs` |
| 配置识别 | 读取项目配置样例和注释，识别必要 Key，按环境推荐配置，生成本机或远程运行配置 | 运行时代码 | `apps/desktop/src-tauri/src/lib.rs`、`crates/deploy-core/src/model.rs` |
| 配置中心 | 运行时已能保存 ConfigProfile、项目/环境绑定和密钥库中的敏感值；Profile revision、applied revision 以及“保存”和“应用”的任务隔离仍只是架构契约 | 运行时代码基础 + 架构契约 | `apps/desktop/src-tauri/src/workspace.rs`、`apps/desktop/src/api.ts` |
| 代码平台 | 保存账号级连接、检查 CNB 仓库可读性、创建仓库、同步代码、启用自动触发并读取构建状态 | 运行时代码 | `crates/deploy-core/src/providers/cnb.rs`、`apps/desktop/src-tauri/src/lib.rs` |
| 项目代码来源 | 账号授权可复用；每条线路独立绑定精确仓库，部署快照从已验证远端历史延续，不在用户项目内创建嵌套仓库 | 运行时代码 + 实机验收 | `apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src-tauri/src/workspace.rs` |
| 版本保存 | 支持 CNB Registry 与腾讯云 TCR 凭据、登录、推送和拉取规划；产物使用 OCI repository 与 digest 标识 | 运行时代码 | `crates/deploy-core/src/providers/registry.rs`、`crates/deploy-core/src/render.rs` |
| 不可变版本 | 每次上线保存精确 commit、完整服务集合及逐服务 OCI repository/digest；服务器部署和历史重部署直接使用冻结摘要，不重新解析可变标签 | 运行时代码 + 实机验收 | `apps/desktop/src-tauri/src/workspace.rs`、`apps/desktop/src-tauri/src/lib.rs` |
| 远程部署 | 通过严格 SSH、Docker Compose 和线路配置启动服务；长静默命令使用 SSH keepalive；完整服务健康后才进入地址检查 | 运行时代码 + 实机验收 | `crates/deploy-core/src/providers/ssh.rs`、`crates/deploy-core/src/render.rs`、`apps/desktop/src-tauri/src/lib.rs` |
| 任务恢复 | `DeploymentRun` 保存持久目标，`deployment_attempts` 追加每次真实执行及冻结输入；关闭后可从原阶段继续，连接/路由修复复用原版本，坏镜像更新生成新版本 | 运行时代码 + 实机验收 | `apps/desktop/src-tauri/src/workspace.rs`、`apps/desktop/src-tauri/src/lib.rs` |
| 历史版本 | 线路内保留完整不可变版本，可选择历史成功版本重新部署；日常更新不要求先进入版本页 | 运行时代码 | `apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/components/` |
| 服务器能力 | 保存服务器、SSH 身份和主机信息；检查 Docker/Compose；服务器与环境绑定分离 | 运行时代码 | `apps/desktop/src-tauri/src/lib.rs`、`crates/deploy-core/src/providers/ssh.rs` |
| 统一访问服务 | 一台服务器复用一套共享 Docker Caddy；每条线路只拥有独立路由片段；应用部署与路由激活是两个事务，路由事务强制校验 Caddy 网络成员、加锁、备份、validate、reload 和回滚 | 运行时代码 + 实机验收 | `scripts/server-bootstrap.sh`、`crates/deploy-core/src/providers/caddy.rs`、`crates/deploy-core/src/render.rs` |
| 地址检查 | 分别检查路由、DNS、端口、TLS/HTTPS 和公开响应；公网 200 还必须匹配目标项目响应，不能命中旧站点兜底页；地址失败不抹掉已成功运行的服务 | 运行时代码 + 实机验收 | `crates/deploy-core/src/health.rs`、`apps/desktop/src-tauri/src/lib.rs` |
| 已有部署接入 | 运行时已能检测部署文件、选择继续管理或重新设置，并限制重新设置的本地清理范围；远程事实核对和 DiscoverySnapshot 仍是架构契约 | 运行时代码基础 + 架构契约 | `apps/desktop/src/components/ExistingDeploymentChoice.tsx`、`apps/desktop/src-tauri/src/workspace.rs` |
| 敏感信息 | Token、Registry 密码、SSH 私钥和敏感配置不进入普通状态、日志或截图；使用操作系统密钥库和专用 SSH 文件 | 运行时代码 | `apps/desktop/src-tauri/src/lib.rs`、`crates/deploy-core/src/redact.rs` |
| Provider 扩展 | Source、Build、Registry、Runtime、Secret、Approval、DNS 和 ReverseProxy 分层建模 | 运行时代码基础 | `crates/deploy-core/src/model.rs`、`crates/deploy-core/src/providers/` |

## 4. 核心领域对象

这些是目标领域模型中的内部对象，不应直接变成用户导航或要求小白理解的名词。当前桌面运行时仍有部分对象合并在 `DeploymentRun` 或普通绑定表中，下表表达需要保留的职责边界，不表示每个对象都已经拥有独立数据表。

| 对象 | 唯一职责 |
| --- | --- |
| Project | 一个项目的稳定身份和服务集合 |
| CodeConnection | 账号级代码平台授权，不代表某个项目仓库已经验证 |
| SourceBinding | 当前项目与精确仓库范围的已验证关系 |
| DeploymentPath | 从当前本地项目到一个明确运行服务器的独立上线线路；地址、运行配置和执行记录按线路隔离 |
| ConfigProfile | 可复用配置项及其 revision；敏感值只保存引用 |
| PathBinding | 线路正在使用的构建连接、版本仓库连接、服务器、配置和地址关系 |
| ArtifactRef | 一个服务的 OCI repository、digest 和产生它的 Registry connection revision |
| Version | 完整 commit 与项目全部 ArtifactRef 的不可变集合 |
| DeploymentTask / DeploymentRun | 生成 Version 或把某个 Version 放入某条 DeploymentPath 的持久目标 |
| DeploymentAttempt | Task 的一次真实外部执行，冻结本次输入并保存真实输出 |
| AutomationRule | main 更新后的自动构建规则及其期望、实际与同步状态 |
| ServerCapability | 某台服务器已验证的运行能力和统一访问服务能力 |
| RouteActivation | 应用健康后单独完成 Caddy 网络接入、路由写入、校验、reload 与回滚的事务 |

## 5. 单一事实源

后续页面可以完全重做，但同一事实不能在多个对象中互相覆盖：

- 项目身份归 Project；账号授权归 CodeConnection；项目仓库归 SourceBinding。
- 版本身份归 Version；完整服务产物只以 ArtifactRef + digest 为准。
- 当前在线版本归 DeploymentPath；最近一次失败归 Attempt，失败不能抹掉在线版本。
- 配置内容归 ConfigProfile；使用关系归 PathBinding；项目专属运行配置按线路隔离。
- 自动更新开关、Provider 实际状态和同步错误归 AutomationRule，不冒充部署结果。
- 工作负载是否已运行、地址是否已可访问是两个事实；DNS 或证书失败不能冒充容器部署失败。
- Connection 当前默认值不能改写历史 Version 或 Attempt 已冻结的 connection revision。

## 6. 关键执行约束

本节是后续运行时必须满足的架构契约。现有代码只实现了其中一部分，具体差距以第 8 节为准。

### 6.1 任务与执行

1. 项目仓库只读核对成功后、任何远程副作用前创建 Task。
2. 用户仍在补信息时允许有 Task，但不能伪造 Attempt。
3. 只有真正调用外部系统时创建 Attempt，并冻结 commit/Version、服务产物、连接、服务器、配置和地址快照。
4. 重试复用同一 Task，只增加 Attempt；不得重新猜测当前页面里的可变设置。
5. 一个项目同时只允许一个远程变更任务；重载后从所有开放 Task 恢复，而不是只相信一个缓存 ID。

### 6.2 版本与环境

1. Version 必须覆盖当前 Project 的完整服务集合，不能少服务、多服务或重复服务。
2. 每条线路独立选择 Version；把同一 Version 放到另一条线路时复用同一组 digest，不重新构建。
3. 新版本完整服务集合健康后才更新线路在线事实；失败时旧版本继续在线或自动恢复。
4. 日常更新、历史版本重部署和恢复使用同一部署模型，只是选择的 Version 和意图不同。

### 6.3 配置

1. 编辑配置默认只保存，不改变任何运行环境。
2. 显式应用时才创建独立 ConfigurationTask。
3. 应用前必须确认目标线路已有在线 Version、服务器证据、有效地址和完整配置。
4. Attempt 冻结完整配置 ID/revision 集合；执行中改绑或改值时，旧 Attempt 不能推进 applied revision。
5. 自动生成的密码和秘密必须归当前项目所有，不能因为 Key 同名跨项目静默复用。

### 6.4 服务器与 Caddy

1. 服务器 Connection 本身不带测试或正式语义，用途只存在于 DeploymentPath 绑定。
2. 首次使用前依次验证 SSH、主机指纹、Docker/Compose、80/443 和 Caddy 接入方式。
3. 空闲且受支持的服务器初始化共享 Caddy；兼容实例只追加独立路由片段；未知代理或路由归属直接阻断。
4. 路由修改必须加锁、确认 Caddy 已加入当前项目网络、备份、validate、reload；失败恢复原配置。
5. 只删除当前项目明确拥有的路由，不触碰未知服务、其他项目、数据卷或第三方代理。

## 7. Provider 边界

| 抽象能力 | 首版实现 | 对外提供的统一事实 |
| --- | --- | --- |
| Source / Pipeline | CNB | 仓库身份、提交、构建任务、外部编号、结果和日志入口 |
| Registry | 腾讯云 TCR；兼容 CNB OCI Registry | repository、tag、digest、读写验证和历史 revision |
| Runtime | Linux + SSH + Docker Compose | 服务启动、停止、健康、日志和回滚结果 |
| Reverse Proxy | Caddy | 路由归属、配置验证、reload 和证书状态 |
| DNS | 公网解析检查 + 控制台入口 | 记录类型、期望值、实际值和生效状态 |
| Secret | macOS Keychain 等系统密钥库 | 是否已配置和可用，不向页面返回明文 |

Provider 的原始状态和错误先映射为统一领域结果，再交给产品层。页面不应直接以 CNB 阶段、Docker 命令或 Caddy 配置作为主流程。

## 8. 明确未闭环的能力

以下内容不得在新的产品设计中显示为“系统已经可以自动完成”：

1. ConfigProfile 仍缺少完整 revision / applied revision 模型；编辑共享配置时的使用方影响确认尚未形成独立 ConfigurationTask。
2. 应用级“待处理”入口尚未完成跨项目任务的完整冲突处理和批量恢复。
3. 真正裸服务器上的 Docker Engine 与 Compose 自动安装仍需更多发行版实机覆盖。
4. 宿主机 systemd Caddy、Nginx、Traefik 或其他进程占用 80/443 时，当前以安全阻断为主，尚未覆盖所有兼容接入方式。
5. 已有部署接入仍缺少完整不可变 DiscoverySnapshot 和每项远程事实的来源证明。
6. 数据库尚未用唯一约束彻底阻断同一项目的并发远程变更；目前主要依赖应用层和服务器部署锁。
7. DNS 仍以公开解析检查和控制台引导为主，尚未接入可写 DNS Provider。
8. 首版之外的代码平台、Registry 和云服务器 Provider 只有扩展边界，尚未完成真实适配。
9. Windows、macOS Intel、Linux 桌面端实机，以及更多真实故障注入证据仍不足。
10. **跨服务可用性检查尚未闭环。** 当前可能出现“网页服务首页健康、API 服务单独健康，但网页服务无法通过内部代理访问 API”仍被判定上线成功的假阳性。后续必须补齐：
    - 部署前核对项目内反向代理的服务名和端口是否与声明的 `container_port` 一致；无法静态识别时不伪造通过结论。
    - 部署后除逐服务健康检查外，从真实公开入口执行至少一条无副作用的跨服务探测，例如通过网页域名访问 `/api/health`。
    - 跨服务探测失败时保留已经健康的服务事实，但整条线路不得显示“上线成功”；页面只给出一个明确修复入口，并在技术详情中展示失败链路、期望目标和实际目标。
    - 首次业务使用前核对生产初始化要求。开发环境专用的 Demo 账号、seed 数据或降级逻辑不能被页面误写为生产可用能力。

    2026-07-19 的 FinAgent 实机复现为：H5 首页和 API 健康接口分别返回 200，但 H5 Nginx 将 `/api` 转发到 `api:3000`，而 API 容器实际监听 `3202`，导致登录入口返回 502。该问题同时证明“服务逐项健康”不能替代“用户真实访问链路可用”。

## 9. 2026-07-18 实机封板证据

本轮使用 `~/Documents` 下 8 个非 ECAT 项目完成真实 CNB 构建、腾讯云 TCR 摘要入库、Linux Compose 启动、共享 Caddy 路由和公网首页标识验收。覆盖单服务静态站、API + Web、多服务、Prisma 迁移、托管 PostgreSQL、pnpm workspace、Vite/Taro 静态构建等结构。

实机过程中关闭了 SSH 长静默误断线、Caddy 未加入项目网络导致 502、旧运行配置无法吸收安全默认值、数据库 URL 类型误判、workspace 依赖未构建、运行资源漏入镜像、坏镜像被重复部署、静态构建变量被当作服务器配置等问题。完整项目、构建号、提交、摘要和公网证据见[真实项目上线验收](pilot-validation-2026-07-18.md)。

## 10. 对下一轮产品设计的约束

后续交互迭代必须继续遵守四条技术边界：

1. 用户界面只表达目标、结果、风险和下一步，内部对象默认隐藏。
2. 页面简化不能靠合并事实实现，例如不能再次把在线版本、最近失败和地址状态合成一个“部署状态”。
3. 系统能从项目、连接和证据中确定的内容自动完成；只有授权、业务值、服务器选择、域名和生产影响需要用户参与。
4. 页面上的“成功、可发布、已应用、已在线”必须能够追溯到真实运行时证据，不能由前端流程位置推断。

本文记录技术资产；产品形态只以[产品实施合同](product-contract.md)为准。
