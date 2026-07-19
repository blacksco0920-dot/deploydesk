# ABCDeploy 架构决策

> 本文记录当前模型中不能由页面临时逻辑替代的领域和安全边界。

模型交叉参考成熟交付工具的公开设计：GitLab 把 Environment 作为持久目标、Deployment 作为版本进入环境的记录；Octopus 把 Release 定义为可重复部署到多个环境的快照；Harness 分离 Service、Environment、Infrastructure 与执行；Argo CD 分离 desired/live、sync/health 状态。ABCDeploy 不复制它们的企业复杂度，只保留这些已经被验证的领域边界：

- [GitLab Environments](https://docs.gitlab.com/ci/environments/) 与 [Deployments](https://docs.gitlab.com/ci/environments/deployments/)
- [Octopus Releases](https://octopus.com/docs/releases) 与 [Environments](https://octopus.com/docs/infrastructure/environments)
- [Harness Continuous Delivery overview](https://developer.harness.io/docs/continuous-delivery/overview/)
- [Argo CD Getting Started](https://argo-cd.readthedocs.io/en/latest/getting_started/) 与 [Automated Sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)

## 1. 领域对象

| 对象 | 身份与职责 |
| --- | --- |
| Project | 稳定项目 ID、规范化目录、期望仓库范围和项目级工作区；Task、Attempt、Environment、Version 与页面上下文不能跨项目串线 |
| CodeConnection / SourceBinding | `CodeConnection` 表示账号级代码平台授权；`SourceBinding` 把一个 Project 精确绑定到仓库范围，并保存验证状态、连接修订、验证时间和证据 ID。账号可共享，仓库绑定不可跨项目串用 |
| Environment | 固定语义的 `development`、`staging`、`production` 目标 |
| Artifact / Version | 完整源提交与每个已识别服务的不可变 Registry 引用/digest 组成的完整产物集合；缺少任一服务产物时不是完整 Version |
| DeploymentTask | 生成版本或把已有版本放入环境的持久目标；测试任务固定完整提交，production 任务只固定目标 Version ID、环境、意图和期望结果 |
| DeploymentAttempt | 同一任务的一次远程执行，保留冻结输入、真实输出快照、Provider 实际返回的外部编号、结果和错误；导入等无外部执行的记录不伪造编号 |
| ConfigurationTask | 把某个 ConfigProfile revision 显式应用到精确项目 + 环境的持久目标；与部署版本的 DeploymentTask 分离 |
| Connection | 可复用、可验证、可替换的代码平台、Registry 或服务器连接 |
| ServerCapability | 一台服务器上可复用的运行与统一访问能力，记录 Docker、Compose、边缘 Caddy 接入方式、归属、配置入口和最近验证结果 |
| EnvironmentBinding | 项目 + 环境对服务器 Connection、配置和地址的明确使用关系；环境语义不写入 Connection 本身 |
| ConfigProfile | 应用级“说明、Key、Value、revision”配置资源；不反向缓存项目或环境引用 |
| VersionValidation | 测试环境对不可变版本的业务结论与证据；不复制 Version 的提交、产物或来源任务 |
| AutomationRule | 触发源、目标环境、期望状态、实际状态和 Provider 规则引用 |

核心关系：

```text
Project ──has──> Environment
Project ──SourceBinding──> repository scope ──uses──> CodeConnection
Project ──produces──> Version
DeploymentTask = Goal(generate commit or deploy Version ID) + Environment
DeploymentTask ──resolves/binds──> Version
DeploymentTask ──has──> DeploymentAttempt (frozen execution inputs)
ConfigurationTask ──applies──> ConfigProfile revision ──on success──> applied revision
AutomationRule ──syncs──> Provider rule (never creates DeploymentTask)
Project/Environment ──EnvironmentBinding──> Connection + ConfigProfile IDs
Server Connection ──has one──> ServerCapability ──serves many──> Project/Environment routes
```

版本与环境必须解耦。不得继续把“最新一条部署记录”同时当成当前版本、环境状态、候选资格和导航状态。

## 2. ADR-001：稳定导航与任务上下文分离

项目持久化导航只允许 `overview`、`local`、`versions`、`settings`。历史的 `test`、`production` 路由迁移为 `overview`。

每个 Project 保存独立工作区快照。添加、打开或切换项目只加载目标项目的 Task、Attempt、Environment、Version 与 AutomationRule；应用级 Connection、ServerCapability 和 ConfigProfile 才允许共享。

普通项目入口和普通重载始终打开 `overview`。只有项目 ID 与 `overview/local/versions/settings` 页面都合法的显式 deep-link 才恢复指定项目页面；非法或不完整链接回退到当前项目 `overview`。任务入口可以携带一次性的 `deployment_id`、`environment` 和 `version_id`，在 `overview` 上打开对应任务 `Sheet`；该上下文随面板销毁，不进入新的环境页面，也不写回项目默认入口。

理由：部署任务是临时状态，不能决定产品信息架构，也不能让失败任务劫持用户每次进入项目。

## 3. ADR-002：环境聚合同时保留两个事实

每个远程环境的聚合状态至少包含：

- `deployed_version`：最近一次成功且仍可信的在线版本；
- `latest_attempt`：该环境最新的一次部署尝试；
- `access_state`：服务、DNS 和 HTTPS 的独立结果。
- `active_address`：当前仍对用户生效且已验证的地址；
- `desired_address`：用户希望切换到、但尚未完成路由/DNS/HTTPS 验证的地址。

聚合规则：

1. 新的失败、排队或取消不覆盖 `deployed_version`。
2. 历史失败不抢占较新的成功结果。
3. production 容器成功而地址失败时，部署结果仍为成功，访问状态单独待处理。
4. staging 业务确认属于版本资格，不等同于容器健康检查。
5. 环境对象不自行决定页面主动作；发布中心根据全部环境、版本资格和待处理任务计算唯一主动作。
6. 修改地址先写入 `desired_address`；全部访问检查通过后才原子更新 `active_address` 并清空期望值。检查失败或断网不得让旧地址离线，也不得反向抹掉工作负载成功事实。

## 4. ADR-003：不可变版本与环境晋级

- `main` 合并触发一次构建，版本由完整提交和完整服务产物集合唯一标识；每个服务都保存不可变 `ArtifactRef = service + repository + digest + registry_connection_id@revision`。ArtifactRef 的 service ID 集合必须与 Project 的 service ID 集合精确相等，缺少、多出或重复都不能成为有效 Version。
- staging 和 production 拉取同一 Version 中完全相同的服务产物集合；production 流水线不得重新构建、替换或遗漏某个服务产物。
- “测试通过”是版本资格，可以被多个后续 production 部署选择。
- 可变标签只用于检索，发布门禁以不可变摘要为准。
- production 的发布与恢复使用同一部署模型，不创建业务代码分支。

## 5. ADR-004：连接是可替换资源

CNB 账号、Registry 和服务器以稳定 Connection ID 保存验证状态和非敏感元数据；项目与环境只保存引用。

- 同一端点的凭据更新不改变 Connection ID，只推进 revision，也不删除项目历史；更换 Registry 端点建立新的活动 Connection，旧 Connection 在仍被历史 ArtifactRef 引用时保留必要的只读解析能力。
- Code Connection 只固定账号级 provider、capabilities、验证状态与 revision；项目仓库范围由独立 `SourceBinding(project_id, code_connection_id, repository_scope, verified, verified_connection_revision, verified_at, evidence_id)` 表达。恢复、切换或添加项目只能读取并校验已有证据，不能创建、纠正或升级证据；缺证据、仓库不匹配或账号 revision 变化时降级为未验证。首次生成、已有部署接入或自动化写操作才触发明确的本地 remote + Provider 仓库读取核对，成功结果才能建立新证据。
- 账号可用与当前项目仓库可读是两个事实。仓库核对失败不清除共享账号、不创建 Task/Attempt，也不改变 AutomationRule；只有账号失效或用户明确选择更换账号时才更新 CodeConnection 与 Token。
- Attempt 不保存“ready”布尔值，而保存当时使用的 Code Connection revision、SourceBinding ID 和精确 repository scope。
- 一个项目可以为 staging 与 production 绑定不同服务器。
- 同一服务器用于两个环境时也保存两条明确环境绑定。
- 服务器 Connection 本身不带 `staging` 或 `production` 所有权；同一已验证 Connection 可以被多个项目和环境引用，环境用途只存在于 `EnvironmentBinding`。
- 仅凭系统密钥库存在值不能视为已验证；必须由目标端点成功接受。
- 错误页和项目设置都必须提供更换连接入口。

## 6. ADR-005：配置中心采用持续环境绑定

配置引用的唯一事实源是 `EnvironmentBinding.config_profile_ids`；`ConfigProfile` 不保存反向 `bindings` 字符串，也不再以“一种类型只能绑定一项”限制同环境多项配置。配置中心的影响项目数和引用列表都必须从各项目环境绑定派生。

- SQLite 只保存 Profile ID 和绑定关系；敏感 Value 保存到系统密钥库。
- 绑定 Profile 被删除时，关系安全清理；项目已有运行配置不能被静默清空。
- 环境配置生成时，以项目字段定义为骨架，再解析该环境绑定。
- 配置完整性按项目声明的精确必填 Key 集合判断；相似名称、任意 Profile 或条目数量不得满足缺失 Key。
- ConfigProfile 一旦被绑定，Key 身份只读；更名通过新建正确 Key 并精确解除目标项目 + 环境的旧绑定实现，不影响其他项目或环境的引用。
- ConfigProfile 保存自身 revision，EnvironmentBinding 保存最近一次成功执行实际应用的 revision。“仅保存”不改变环境运行值，只有用户明确选择应用到目标环境才创建执行目标。
- 显式应用创建 `ConfigurationTask`；Attempt 在开始时冻结完整 `config_profile_ids + config_profile_revisions`。只有该 Attempt 成功且目标环境的绑定集合仍与冻结集合一致时，才用整份冻结修订替换 `applied_revisions`；执行中改绑必须阻断并重新确认。Profile revision 与目标环境 applied revision 一致时不创建任务。
- 同名冲突要求用户明确选择或按已记录优先级解决，不跨环境自动套用。
- 主流程中可以原地创建 Profile 并绑定当前环境；保存或绑定失败时保留手填内容和原绑定。

## 7. ADR-006：任务先持久化，尝试可追加

创建部署任务和保存目标必须早于服务器修改、项目文件写入、Git push、CNB 触发或生产切换。测试任务在创建时固定完整 40 位源提交；production 任务只固定 Version ID、环境、意图和期望结果。当前 HEAD 后续变化不得改写测试 Task 或其 Attempt。

- 等待授权、连接、服务器确认、配置或生产确认时 Task 可以存在，但 Attempt 数必须为零；只有一次外部执行真正开始时才创建 Attempt。
- Version 是提交、来源 Task/Attempt 与完整 ArtifactRef 集合的唯一权威对象；VersionValidation 只保存环境验证证据。资格判断必须确认 Version 服务集合与 Project 精确相等，并把 Validation 六项环境事实逐项匹配来源成功 Attempt 的输出快照及冻结输入。production Attempt 每次开始或恢复前重新判断资格，再按 Task 固定的 Version ID 解析 Version 并复制完整 ArtifactRef；不得从页面当前选择、标签、Validation 或当前 Registry 重新拼装产物。
- Attempt 输入快照包含代码/版本目标、完整服务产物引用和 digest、代码与 Registry Connection ID/revision、SourceBinding、服务器绑定与 ServerCapability revision、完整 ConfigProfile ID/revision 集合、服务与部署定义 revision、`active_address` 和 `desired_address`；成功测试 Attempt 的输出快照另外固定实际配置/服务/部署 revision、服务器、地址与健康结果，供 Validation 交叉验证。
- 同一目标的重试保持 Task ID 不变，只追加带当次输入快照的 Attempt。
- 授权、production 启动、配置缺失、服务器断连和路由冲突均回到原 Task；配置修复复用配置中心，连接修复复用连接维护。修复完成后才追加新的完整输入 Attempt，旧正式版本和 `active_address` 在健康切换完成前保持不变。
- 每个外部副作用前保存当前阶段，返回后再保存外部编号和结果。
- 恢复使用任务中的版本、服务器连接、配置和地址快照，不重新猜测当前可变设置。
- 只有目标工作负载健康、项目级路由已经安全切换后，才能原子更新环境的 `deployed_version`；公网 DNS、证书签发和 HTTPS 检查只更新 `access_state`，不阻止已在服务器运行的版本成为在线事实。
- 新任务失败或暂停时，旧在线版本指针不变。
- 已有部署接管、只读连接验证和已完成发布后的地址维护不属于部署执行，不得为了展示进度伪造 DeploymentTask 或 DeploymentAttempt。

## 8. ADR-007：自动化规则采用期望状态与实际状态

自动化规则不等同于一次部署，也不以一个布尔开关代替真实状态。

- `desired_state` 表示用户希望开启或暂停，并保存分支、行为、目标环境和 revision；
- `observed_state` 表示 Provider 上实际状态与最近观察结果；
- `provider_ref` 保存规则及 Connection revision，`sync_state` 独立保存待同步、已同步、失败、最近时间和错误；
- 暂停、恢复、失败与修复都更新同一个 AutomationRule。规则同步绝不创建 DeploymentTask、DeploymentAttempt 或 Version，也不修改环境在线事实；同步失败只产生规则自己的待处理事项。

## 9. ADR-008：状态与秘密分层保存

| 数据 | 保存位置 |
| --- | --- |
| 项目、环境、版本、部署、连接元数据、绑定和任务停点 | SQLite |
| Token、Registry 密码、SSH 私钥、敏感配置值 | 操作系统密钥库 |
| 可重新生成的 Dockerfile、Compose、Caddy 和流水线定义 | 项目工作区或运行时生成区 |
| 原始日志 | Provider/服务器；客户端只按需读取并脱敏 |

禁止把 Token、私钥、完整环境文件、带凭据 URL 或第三方原始错误写入普通日志、通知、截图或持久化任务描述。

## 10. ADR-009：Provider 边界

首版组合与职责：

| Provider | 首版实现 | 职责 |
| --- | --- | --- |
| Source / Pipeline | CNB | 仓库、事件、构建、部署记录和日志 |
| Registry | 腾讯云 TCR | 查询和保存 OCI 镜像、标签、digest |
| Runtime | Linux + SSH + Docker Compose | 启停版本、健康检查、回滚和运行日志 |
| Proxy | Caddy | 服务器边缘路由、TLS 和项目级配置片段 |
| DNS | 公共 DNS 检查 + 控制台链接 | 解析检查，不持有云账号权限 |

产品领域不出现厂商专用状态枚举。Provider 响应先映射为统一 Version、Deployment、Connection 和 AccessState。GitHub 不属于首版默认链路。

## 11. ADR-010：流水线是后台执行器

CNB 阶段不会直接成为客户端页签。客户端只展示用户阶段：准备项目、生成/确认版本、启动服务、确认可用。

状态查询按事实来源分工：

- 构建与远程任务：CNB API；
- 版本和 digest：Registry API/OCI 协议；
- 容器、Compose、Caddy 和服务器日志：绑定服务器的 SSH 连接；
- DNS、HTTPS 与公开响应：客户端从公网检查。

不得用 CNB 构建状态推断服务器一定在线，也不得只用公网 HTTPS 失败断言容器部署失败。

## 12. ADR-011：服务器和 Caddy

- 服务器 Connection 与环境无关。任何服务器首次绑定到任一环境时，严格按“验证凭据 → 确认并固定主机指纹 → 检查运行前提 → 分类共享访问服务 → 展示并确认影响 → 标记 Connection/ServerCapability 已验证 → 创建 EnvironmentBinding”执行；任一步未完成都不得提前绑定。
- Docker Compose 项目、目录、网络、卷和配置按项目 + 环境隔离。
- `ServerCapability` 属于服务器，不属于项目；一台服务器只接入一个占用 80/443 的服务器级共享 Docker Caddy 容器。多个项目和环境通过各自拥有的 `sites` 片段复用它，不为每个项目安装代理。项目容器内部用于提供静态文件的 Caddy 不属于这套边缘能力。
- 干净且受支持的服务器指 Docker Engine/Compose 已可用且 80/443 无占用，可以在单独确认后准备运行目录和共享 Caddy 容器；缺少 Docker/Compose 或用户权限时先记录为前提缺失，不误判为空服务器。裸机自动安装尚未闭环。
- 已有兼容 Docker Caddy 只有在能够确认容器、配置入口、可写 `sites` 挂载和 reload 方式时才自动复用；普通新增或更新只写当前项目 + 环境拥有的片段，不重写主 Caddyfile。
- systemd Caddy、其他反向代理、多个代理、未知配置来源或无法确认 reload 方式时记为冲突能力，停止自动初始化；只保留诊断并要求更换服务器或由维护人员先整理，不通过覆盖主配置“尝试修复”。
- Caddy 变更使用服务器级锁；修改前备份，修改后在目标容器执行 `caddy validate`，再 reload；任一步失败都 rollback 原片段和原配置并再次验证。
- production 选择全新服务器时必须执行与 staging 相同的完整初始化检查。该要求当前仍是待实现运行时门禁，不能因为原型能选择服务器就标记为已经完成。
- 地址归属分三类处理：当前项目拥有的路由可幂等修复；其他 ABCDeploy 项目拥有的路由只能通过明确的“转移地址”流程处理；旧服务、第三方或未知归属路由直接阻断，不提供一次确认式接管。
- 当前桌面运行时尚有一条旧兼容路径，会把主 Caddyfile 中的同地址块视为可确认接管；它没有项目归属证据，因此不满足本 ADR，必须在正式实现验收前删除或改成只读诊断。初始化脚本也需补宿主机进程级 80/443 识别，不能只检查 Docker 容器。
- 移除项目或环境只删除其拥有且可证明归属的路由片段，不卸载共享 Caddy，也不触碰其他项目路由。
- 不自动删除未知容器、目录、数据卷或第三方代理配置。

## 13. ADR-012：项目识别和迁移

项目身份优先使用稳定存储 ID 与规范化路径；Git Remote 和项目指纹用于移动恢复，不单独作为主键。

当前模型迁移要求：

- 历史 `test` / `production` 场景映射到 `overview`；
- 历史部署记录原样保留，并通过聚合模型推导环境状态；
- 原有单配置绑定无损迁移为多 Profile 环境绑定；
- 旧的单一服务器绑定不得自动声明为两个环境均已验证，缺失环境在首次使用时确认。

已有部署接入使用独立、持久化的采用状态：

- `pending`：只表示检测到已有部署定义；禁止远程同步和旧连接恢复；
- `managed`：用户明确选择继续管理，允许只读导入已有版本；
- `fresh`：用户选择重新设置，只清除本机项目级部署事实并使用内存中的全新草稿，不覆盖项目目录里的旧文件。

进入 `managed` 前依次验证代码 Connection、Registry Connection、服务器完整身份和 ServerCapability。只有服务器身份与本机线索匹配时，系统才保存不可变 `DiscoverySnapshot`：主机指纹、服务器 Connection、观察时间，以及各环境检测到的 Version/ArtifactRef、ConfigRef、地址和健康结果。最终确认只能从该快照映射已证明事实；快照没有证明值存在的配置仍然缺失。采用过程不创建 deployment-kind Task/Attempt、不执行部署，也不允许用本机保存的凭据或历史 `ready` 布尔值直接推断线上健康。最终确认后允许创建 completed `kind=import` 审计 Task/Attempt，作为导入 Version 的来源证据；它们不得带远程副作用或冒充一次部署。

进入 `fresh` 时记录远程历史截断时间。后续即使重新开启同步，也只能导入该时间之后产生的构建，避免旧任务在重启或异步回调后复活。全局连接、系统密钥库、项目文件以及 CNB、Registry、服务器上的资源都不属于重新设置的清理范围。

## 14. 风险等级

| 等级 | 示例 | 默认行为 |
| --- | --- | --- |
| 只读 | 扫描、查询版本、检查 DNS | 自动执行 |
| 本地写入 | 生成项目文件、保存非敏感绑定 | 说明影响后执行 |
| 远程初始化 | 创建仓库、准备受支持服务器、初始化共享 Caddy 或复用已经符合契约的 Caddy | 展示影响后单独确认并记录；无法证明兼容时阻断 |
| 生产变更 | 发布、恢复、路由切换 | 强确认与审计 |
| 破坏性操作 | 删除数据、未知资源、DNS | P0 不自动执行 |

## 15. 架构验收不变量

1. 版本可独立列出，不依赖某个环境页面存在。
2. 任一测试通过版本可以部署 production，且完整服务产物集合逐项不变。
3. staging 和 production 的服务器、配置、任务与状态不会相互覆盖。
4. 更新凭据后可以继续原任务，项目和版本历史不变。
5. 最近失败不会抹掉在线版本，地址失败不会抹掉容器成功。
6. 普通进入项目不携带任务上下文。
7. 任一外部副作用发生前已经存在可恢复的 DeploymentTask。
8. Version 是提交、来源任务和完整 ArtifactRef 的唯一权威；VersionValidation 只保存验证证据，AutomationRule 保存独立规则事实。
9. 同一服务器的项目共享一个 ServerCapability；任一项目的路由变更都不会重写或删除其他项目和未知服务配置。
10. Version 的每个服务产物在 staging 与 production 完全一致；不能只校验一个代表性 digest。
11. 等待用户输入的 Task 没有 Attempt，Attempt 只对应真实执行并保留完整输入快照。
12. 服务器 Connection 不带环境语义，首次环境绑定前已经完成身份、前提、访问能力与影响确认。
13. `active_address` 在 `desired_address` 全部验证通过前保持不变；地址维护不制造部署记录。
14. CodeConnection 可以跨项目共享，但 SourceBinding 必须精确匹配当前 Project、repository scope、Connection revision 并持有真实验证证据；恢复和切换不能生成证据，错误、缺证据或过期绑定不能进入 Attempt。
15. 配置引用只存在于 EnvironmentBinding；ConfigProfile 不缓存反向 bindings，applied revision 只由成功且输入仍一致的 Attempt 推进。
16. Version 的服务集合必须与 Project 精确相等；Validation 六项环境事实必须与来源 Attempt 输出及冻结输入一致，production 每次执行前重新验证资格。
