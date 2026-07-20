# ABCDeploy 部署产品工作流研究

> 研究日期：2026-07-18。本文只记录会影响 ABCDeploy 产品模型的结论，不做竞品功能清单。信息优先来自各产品官方文档。

## 1. 研究问题

ABCDeploy 不是要把传统 DevOps 控制台缩小，而是要回答三个问题：

1. 完全不懂部署的用户，怎样最快得到一个可以打开的测试版？
2. 项目稳定后，怎样让代码更新、测试确认、正式发布变成低频决策而不是重复搭建？
3. 自托管服务器必然存在账号、网络、反向代理和旧服务冲突，怎样隐藏复杂度但不牺牲安全？

## 2. 竞品中真正值得借鉴的模式

| 产品 | 官方工作流 | 对 ABCDeploy 的启发 |
| --- | --- | --- |
| [Vercel](https://vercel.com/docs/deployments/promoting-a-deployment) | Project 下持续产生 Deployment；同项目的 staged production deployment 可直接 promote 而不重建，历史 production 可在路由层 rollback；preview 到 production 是否产生新构建取决于目标环境与构建语义，不能统一概括为“原产物直接晋级” | “版本产生”和“正式流量指向哪个部署”应解耦；借鉴状态分离，但不把 Vercel 的所有 promotion 等同于 ABCDeploy 的同一 OCI 产物晋级 |
| [Render](https://render.com/docs/deploys) | 新实例通过健康检查后才替换旧实例；失败部署不会破坏当前正常版本；历史构建产物可以直接回滚 | 健康检查应是切换门禁；失败必须同时告诉用户“新版本失败”和“旧版本仍在线” |
| [Railway](https://docs.railway.com/deployments/deployment-actions) | 部署是独立尝试；配置修改先形成待应用变更；部署可以重启、重新部署或回滚 | 系统先汇总将发生的变化，再让用户一次确认；配置变化同样要有影响范围 |
| [Heroku](https://devcenter.heroku.com/articles/releases) | 代码、配置和附加资源变化都会产生可追溯 Release；同一构建产物从 Staging 提升到 Production | 正式发布必须使用测试过的同一不可变产物；配置快照也属于发布事实 |
| [Fly.io](https://fly.io/docs/launch/deploy/) | 扫描项目后生成部署计划；平台采用安全默认发布策略；先提供平台地址，再配置正式域名 | 先让项目可访问，再要求域名；检测结果应先由系统转成推荐方案 |
| [Coolify](https://coolify.io/docs/get-started/concepts) | Server/Destination 是可复用资源；项目与环境引用这些资源；自动配置反向代理和临时地址 | 服务器连接是一次性能力，不是每个项目的一段部署流程；自托管细节应放在低频设置中 |
| [Rainbond](https://www.rainbond.com/docs/how-to-guides/delivery/continuous/multi-env) | 以应用为中心，把组件、依赖、配置和多环境交付组合在一起；测试版本可以升级或回滚 | 前台应围绕“应用现在运行什么”组织，不围绕容器、流水线和网络组织 |
| [Sealos](https://sealos.io/docs/guides/app-deploy/first-deploy/) | 首次部署只追求第一个成功结果，命令、存储、扩缩容等进入后续独立任务；故障页按症状分流 | 首次成功和日常维护必须分开；故障恢复应从用户看到的症状进入，而不是让用户选择技术阶段 |
| [1Panel](https://1panel.cn/docs/v1/user_manual/appstore/installed/) | 已安装应用主要提供启动、停止、备份、恢复和升级等结果型操作 | 小白日常只需要少量结果型动作，底层运行参数不应成为常驻导航 |

Portainer 等容器运维产品适合参考 Compose、Registry 和凭据的资源边界，但其信息架构服务于懂 Docker 的管理员，不适合作为 ABCDeploy 的前台模型。

## 3. 跨产品一致结论

### 3.1 代码、版本、环境是三个对象

```text
代码更新 ──产生──> 不可变版本 ──部署──> 测试或正式环境
```

- 代码仓库负责产生版本。
- 版本由完整提交与每个服务的不可变产物引用/digest 集合标识，不随页面状态改变，也不能用一个“主镜像”代表多服务版本。
- 环境只表达“在哪里、使用哪套配置、当前运行哪个版本”。
- 正式环境可以选择任一已经验证的版本，不应和最新测试任务强耦合。

### 3.2 第一次成功与日常发布必须分开

第一次需要建立代码平台、版本存储、服务器和配置等能力；日常发布只应处理新版本的测试结果和正式影响。把两者放在同一套向导里，会让已经稳定运行的项目永久背负首次设置复杂度。

### 3.3 先给测试地址，再要正式域名

临时测试地址是缩短首次成功时间的关键。正式域名、DNS 和 HTTPS 属于“提供给真实用户”时才需要的生产任务，不应阻塞测试环境已经成功的事实。

### 3.4 自动化默认止于测试环境

最适合 ABCDeploy 目标用户的默认规则是：

```text
main 更新
  → 自动生成不可变版本
  → 自动部署测试环境
  → 用户确认业务结果
  → 获得可发布资格
  → 用户明确选择后进入正式环境
```

### 3.5 回滚不重新构建

恢复只是把环境切回一个已存在、已知健康的版本。重新构建会产生新的未知产物，不能被称为回滚。数据库和外部状态不随镜像自动回滚，界面必须明确这条边界。

### 3.6 基础设施是能力，不是用户工作流

代码平台、Registry、SSH、Docker、Caddy 和 DNS Provider 是系统完成目标所需的能力。用户只有在授权、提供业务值或确认生产影响时才需要看到它们；日常页面不应按这些能力的技术顺序排列。

### 3.7 连接、绑定和执行记录必须分层

- Server Connection 是跨项目、跨环境复用的身份与能力，不属于测试或正式环境；EnvironmentBinding 才表达某项目环境在哪里运行。
- 任一服务器首次绑定前必须先完成凭据、主机指纹、运行前提、共享访问能力分类和影响确认，不能为了缩短向导而先写入“已绑定”。
- Task 表达用户目标，Attempt 只表达一次真正执行。等待用户输入可以有 Task 但没有 Attempt；已有部署接管和单独地址维护都不应伪造部署记录。接管确认后可以保留 completed import 审计记录证明 Version 来源，但它不等于一次部署执行。
- 配置中心保存可复用 Profile，配置是否满足按精确 Key 判断；“仅保存”和“应用到环境”是两个动作，revision 让部署快照可追溯。

### 3.8 期望地址不能提前覆盖在线地址

成熟交付系统会区分 desired/live。ABCDeploy 对地址使用同一原则：旧 `active_address` 在新 `desired_address` 完成路由、DNS 和 HTTPS 验证前继续生效；检查失败只表示切换未完成，不能把服务或旧地址误报为离线。

### 3.9 Promotion 语义必须看目标环境

Vercel 的公开文档区分两条路径：同一项目中 staged production deployment 提升为 Current 不触发重建；preview promotion 会按 production 环境与构建语义产生 production deployment，官方当前指南明确包含 production rebuild。ABCDeploy 因此只借鉴“部署对象与流量指针分离”，不把所有 preview/production promotion 泛化为不重建，也不以此证明 ABCDeploy 的 OCI digest 晋级已经实现。

## 4. 不能直接照搬的部分

- Vercel、Render 和 Railway 控制运行基础设施，ABCDeploy 面对任意 Linux 服务器，不能假装端口、权限和旧路由不存在。Vercel staged production 的无重建提升也不能外推为任意 Preview 都复用原构建结果。
- Heroku 的线性 Pipeline 不能限制 production 只能接收“刚刚测试”的版本；历史已验证版本也必须可选。
- PR 级完整预览环境会增加单机资源和国内云成本，不作为首版默认。
- Coolify、Portainer 的 Server、Destination、Stack、Network 等对象不应直接进入小白前台。
- 服务器资源对象可以借鉴，但不能把环境名称固化进 Connection，也不能省略首次能力验证后直接建立绑定。
- Fly.io 的 CLI 与发布策略术语不适合作为主交互。
- 不接 AI 时，项目扫描必须显示系统理解并允许纠正，不能用“智能识别”掩盖不确定性。

## 5. ABCDeploy 的组合方案

ABCDeploy 应组合而不是模仿某一家：

- Vercel 的“部署与流量指针分离”，并保留 staged production 与 preview promotion 的差异；
- Heroku 的“同一不可变产物晋级”；
- Render 的“健康门禁与失败保护”；
- Railway 的“变化汇总后一次确认”；
- Coolify 的“自托管服务器作为可复用资源”；
- Sealos 的“第一次只追求可访问结果”；
- Rainbond 的“以应用和环境为中心”。

最终前台只需要让用户理解四个词：**项目、测试版、正式版、版本**。连接、流水线、镜像、服务器访问服务和证书保留为任务上下文或技术详情。
