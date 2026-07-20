# FinAgentCRM 工作流试点验收

> 验收日期：2026-07-19。本文记录当前“本地项目 → 构建服务 → 版本仓库 → 运行服务器”产品模型下的一次真实端到端上线。只记录可公开复验的标识和摘要，不记录 Token、密码、SSH 私钥或业务密钥。

## 1. 验收结论

FinAgentCRM 已通过 ABCDeploy 用户可见的“上线”线路部署到新服务器，客户端、CNB、TCR、服务器和公网结果一致。

| 证据 | 结果 |
| --- | --- |
| 用户可见线路 | `上线` · `path-ff6d76cfdc828bc2` |
| 部署任务 | `0b46ae052ddd1c03434cbef7763682bed1c2b7af71617323734e342287e49a49` · `success` |
| CNB 构建 | `cnb-4bg-1jtsn49sq` |
| 完整代码快照 | `0c9511e3390a0ce73f6449be18196cf541ca0977` |
| 公网地址 | [https://crm.finagent.cloud/](https://crm.finagent.cloud/) · HTTP 200 · TLS 校验通过 |
| 客户端恢复 | 显示“上线完成，3 个运行服务和 1 个访问地址均已验证 · 0c9511e3” |

## 2. 不可变版本

三个服务都以本次构建产生的不可变摘要进入腾讯云 TCR；服务器容器实际运行的 `Config.Image` 与下表逐项一致。

| 服务 | 不可变镜像 |
| --- | --- |
| API | `ccr.ccs.tencentyun.com/finagent/finagentcrm-api@sha256:825f70b9cc6c61de046a3ddaa1e68dceab8a7275bf974fd5380e2054f8bb2fe0` |
| Mobile | `ccr.ccs.tencentyun.com/finagent/finagentcrm-mobile@sha256:38ee0f9b45a55fc7eb51a4e6a7240741e6284cd0d088fc9b9be1453f9893fe30` |
| Web | `ccr.ccs.tencentyun.com/finagent/finagentcrm-web@sha256:f83b4360c1c32c59a07d5a712b20b1e9bb773c5212fad33cd171fb269374bc90` |

## 3. 运行与公网验证

- 服务器上的 `api`、`mobile`、`web` 三个容器均为 `running / healthy`。
- Caddy 只加载 ABCDeploy 自有片段 `finagentcrm-path-ff6d76cfdc828bc2.caddy`，将 `crm.finagent.cloud` 转发到该线路的 `web` 服务；未覆盖服务器未知主配置。
- DNS A 记录解析到目标服务器；HTTPS 首页返回 200，证书校验结果为 0。
- `GET /api/health` 返回 HTTP 200 和 `{"success":true,"data":{"status":"ok"}}`，证明前端反向代理能够到达 API，而不是只验证静态首页。
- 使用项目已配置的管理员账号执行 `POST /api/auth/login` 返回 HTTP 201，响应包含 `accessToken` 和 `user`；验收过程不记录凭据或令牌值。

## 4. 本地与自动化验证

- 项目依赖按锁文件安装，Prisma Client 重新生成成功。
- 使用项目锁定的 pnpm 9.15.0 执行全量应用构建通过。
- API、Mobile、Web 三个 Dockerfile 均在本机 Docker 环境完成真实镜像构建。
- FinAgentCRM API 单元测试 57/57 通过，包含健康接口和首次管理员初始化的幂等性测试。
- ABCDeploy 前端测试 258/258 通过。
- Rust 工作区测试和 `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 当前 macOS Apple Silicon `.app` 使用稳定 Apple Development 身份签名，`codesign --verify --deep --strict` 通过。

## 5. 通用性复核

- 客户端运行时代码不包含 FinAgentCRM 域名、管理员账号或密码特例。
- 隐藏验收命令只复用客户端中已经存在的可见线路、访问地址、节点连接和运行配置；没有可见线路或地址时明确阻塞，不创建隐藏平行线路，也不自动补业务字段。
- FinAgentCRM 的 `INITIAL_ADMIN_*` 等字段来自项目自己的 `deploy.yaml` 和安全运行配置，其他项目不会继承。
- 节点配置遵循“查看 / 选择 / 新增编辑 / 修复”单一模式；更换失败不覆盖当前在线绑定。

## 6. 已知边界

- DNS 仍由用户在域名服务商处设置，ABCDeploy 负责给出记录值、持续检查解析和完成 Caddy/HTTPS 验证。
- 首次完整容器构建会受依赖下载和镜像仓库网络速度影响；任务可关闭客户端后继续，重新打开会恢复同一真实停点。
- 本次只生成当前 macOS Apple Silicon `.app` 测试包；没有升级版本号、生成 DMG、创建标签或触发正式发布。
