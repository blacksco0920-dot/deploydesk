# ABCDeploy 当前文档

> 对齐日期：2026-07-19。新的工作流产品模型已完成文档与可点击原型对齐；底层部署能力已有真实项目试点，正式 FlowGram/Coze 工作区尚未进入客户端实现。产品实现只以[产品实施合同](product-contract.md)为准。

ABCDeploy 帮助不懂部署的用户把电脑里的项目可靠地放到服务器。面向用户的唯一主线是：

```text
代码来源 ──> 版本构建 ──> 版本存储 ──> 部署运行
```

四个名称是可复用的 `NodeType`；本地项目、CNB、腾讯云 TCR 和 Linux 服务器是 `Provider`；Token、仓库登录和 SSH 服务器身份是配置中心维护的 `Connection`；画布中的卡片是当前线路的 `NodeInstance`。授权不是第五个节点。

## 当前有效文档

| 文档 | 权威范围 |
| --- | --- |
| [产品实施合同](product-contract.md) | 用户目标、部署线路、节点交互、配置复用、状态和验收口径；产品冲突时优先级最高 |
| [底层技术能力](technical-capabilities.md) | 已有交付引擎、Provider、安全约束和明确实现缺口 |
| [实施验收](implementation-acceptance.md) | 当前工作流模型的功能、状态、复用、恢复和视觉一致性验收口径 |
| [FinAgentCRM 工作流试点验收](pilot-validation-finagentcrm-2026-07-19.md) | 当前画布模型的代码快照、CNB、TCR、服务器、Caddy、公网健康和登录证据 |
| [真实项目上线验收](pilot-validation-2026-07-18.md) | 8 个非 ECAT 项目的构建、不可变镜像、服务器、Caddy 和公网首页证据 |
| [前端设计规范](frontend-design-guidelines.md) | 通用组件、视觉令牌、可访问性和文案规范；不得改变产品合同 |
| [本机运行](local-running.md) | 本地服务启停和配置检核的独立能力边界 |

## 历史材料

根目录中仍存在的旧产品模型文稿正处于迁移期，其中涉及“发布中心、测试版、正式版、版本管理”的规则全部失效，只能作为实现迁移和底层约束的背景材料。被替代的稳定副本统一放在[历史归档](archive/README.md)。

`docs/product-prototype/workflow-node-config.html` 是当前 Coze 式三栏工作区、四类节点、连接复用和授权单一模式的低成本交互原型；目录内其他旧发布中心原型不代表本轮实施结果。正式验收仍以桌面客户端、产品合同和真实项目验收记录为准。

## 文档维护规则

- `docs/` 根目录只允许当前规范；旧产品规则完成迁移后移入 `docs/archive/`。
- 页面简化不能破坏底层安全约束，也不能用流程位置冒充真实部署证据。
- CNB、腾讯云 TCR、Linux 和 Caddy 是首版适配器，不是面向用户的产品导航。
- GitHub 不属于首版默认部署链路。
- 未经用户明确要求正式发布，不升级版本号、不生成 DMG、不触发远端发布。
