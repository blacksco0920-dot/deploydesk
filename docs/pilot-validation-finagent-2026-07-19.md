# 2026-07-19 FinAgent 工作流试点验收

> 本文只记录可公开复核的执行标识、不可变产物与验收结论。账号、密码、Token、SSH 私钥、Authorization Header 和完整运行配置均未写入本文。

## 1. 验收目标

本次使用 FinAgent 验证当前 ABCDeploy 的同一签名应用二进制能通过内置 QA 验证入口，复用客户端可见的固定四节点线路与正式部署引擎完成真实上线，并重点覆盖此前 H5 与 API 各自健康、但 H5 同源 `/api` 因固定服务名或错误端口返回 502 的问题。本次不是用户从工作流界面逐项点击的完整 UI E2E。

验收范围包括：

- FlowGram 工作流中的真实 DeploymentPath；
- CNB 构建与腾讯云 TCR 不可变镜像；
- API、H5、OCR 三服务部署；
- 线路唯一服务别名与实际容器端口；
- 服务级环境变量隔离；
- 客户端托管的内部认证密钥与 OCR 内网地址；
- H5 同源 API 健康、认证和 OCR 业务链路。

## 2. 客户端与执行标识

| 证据 | 值 |
| --- | --- |
| 签名应用 | `target/release/bundle/macos/ABCDeploy.app` |
| Bundle Identifier | `cloud.finagent.abcdeploy` |
| Team Identifier | `7377UWC7Q8` |
| DeploymentPath | `path-9f08987a82c4caf5` |
| Deployment Task | `f809b8135542c907a981ce6348c16337a8ea18ad440e5a196b2a327efeedf562` |
| CNB Build | `cnb-95o-1jtt93se1` |
| Commit | `3111dcaa1abfb421e5da7ffcb24c6e46ba6bd131` |

该执行由同一签名应用二进制内置的 QA 验证入口发起，复用了客户端可见线路、已验证 Connection、DeploymentTask 和正式部署引擎，没有通过第二套脚本绕开 ABCDeploy 的路径、任务和证据模型。它证明的是正式运行时与数据模型的端到端能力；用户从工作流界面逐项点击完成整条首次上线，仍属于独立的 UI 验收范围。

## 3. 不可变镜像

三个项目服务均以精确 OCI digest 进入目标线路，服务器部署不依赖可变标签：

| 服务 | 不可变摘要 |
| --- | --- |
| API | `sha256:3ea44c55703f841386dcbb0d4cc1097f867049ea266d455780637d41654f8c18` |
| H5 | `sha256:d301e162eb4d152e32957d287b12f65c6dfd210cdf480897498a89affe5d072d` |
| OCR | `sha256:604aa1b7a04c77763daf47b6bc26f2c5ee801932cc5bd1a08b311e217234c1b8` |

## 4. 运行时边界验证

- API 实际监听项目声明的容器端口，H5 通过当前线路注入的 `API_HOST` 与 `API_PORT` 访问 API，没有使用固定 `api:3000`。
- API、H5、OCR 使用当前 DeploymentPath 的唯一服务别名，避免同一服务器上不同项目或不同线路通过裸服务名串线。
- 线路受保护配置在部署时按各服务声明过滤；API 专属业务密钥没有注入 H5 或 OCR，OCR 的 `runtime_env` 为空时不挂载运行配置文件。
- `AUTH_TOKEN_SECRET` 属于项目内部认证密钥，由客户端按项目与线路安全生成并复用；本文不记录其值。
- `PP_OCRV6_TINY_URL` 由客户端按当前线路的 OCR 唯一别名和实际端口生成，不要求用户手工填写；本文不记录线路完整运行配置。
- H5 同源 API 门禁没有触发 `AD-CTR-102`，并由后续公网同源健康、认证与 OCR 请求进一步证明代理目标有效。

## 5. 公网验收结果

| 链路 | 结果 | 语义证据 |
| --- | --- | --- |
| API `/api/health` | HTTP 200 | 数据库为 `connected`，Redis 为 `ok` |
| H5 `/` | HTTP 200 | 页面入口可访问 |
| H5 同源 `/api/health` | HTTP 200 | 数据库和 Redis 依赖健康，证明 H5 → API 代理可用 |
| OCR `/health` | HTTP 200 | OCR 进程健康 |
| OCR `/ready` | HTTP 200 | 响应体 `status` 为 `ok` |
| H5 同源注册 | HTTP 201 | 使用随机、无真实个人信息的临时验收账号 |
| H5 同源登录 | HTTP 201 | 认证成功，未记录凭据或返回 Token |
| H5 同源当前用户 | HTTP 200 | Bearer 认证链路有效，未记录 Header 或用户值 |
| H5 同源 OCR 识别 | HTTP 201 | 状态为 `recognized`，识别文本非空（长度 10），`blocks=3` |

以上结果证明“API、H5、OCR 分别健康”之外，用户实际经过 H5 入口访问 API、认证与 OCR 的跨服务路径也已打通。

### 5.1 最终公网复核

2026-07-19 23:30–23:35（Asia/Shanghai）再次以只读方式复核当前在线版本：

- H5 `/`、H5 同源 `/api/health`、独立 API `/api/health`、OCR `/health` 和 OCR `/ready` 各连续请求 20 次，共 100 次，全部返回 HTTP 200；
- H5 同源与独立 API 健康响应均证明数据库为 `connected`、Redis 为 `ok`；
- 代理链路实际为 Caddy → H5/Nginx `80` → API `3202`，OCR 使用容器端口 `8000`；
- 三个域名的 HTTP 均跳转 HTTPS，TLS 证书校验通过；
- H5 同源登录接口对不存在账号返回结构化 HTTP 401，证明认证路由和代理可达。本次只读复核没有创建账号，因此没有重复生成登录成功证据；登录、当前用户与 OCR 识别成功证据仍以上述首次试点结果为准。

## 6. 本地项目保护

上线过程中没有切换或推进 FinAgent 的用户分支，也没有改动用户暂存区。ABCDeploy 通过 `git commit-tree` 创建了一个不挂到用户分支的独立部署快照提交（即上文的 Commit），用于让构建产物可追溯；`apply_plan` 仍会按设计刷新 `.cnb.yml` 与 `.deploydesk/generated/*` 等部署生成物，因此上线前后的工作树状态哈希会变化。本次不把“工作树完全不变”作为验收结论，也不在本文记录容易造成误解的状态哈希。

## 7. 结论与保留边界

本次试点通过，证据覆盖：同一签名应用二进制正式运行时中的真实任务、可追溯提交与构建、三服务不可变摘要、服务器运行、依赖健康、H5 同源 API、认证及 OCR 业务链路，以及最终公网只读检查 100/100 HTTP 200。该结论不替代完整 UI E2E 验收。

`AD-CTR-102` 当前覆盖使用自带 Dockerfile且没有显式自定义健康命令的 Static/Web 同源 API 代理。生成式前端 Dockerfile或项目自定义健康命令仍需提供等价的跨服务探测；该限制不影响本次 FinAgent 验收结果。
