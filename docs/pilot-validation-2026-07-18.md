# ABCDeploy 真实项目上线验收

> 验收日期：2026-07-18。范围为 `~/Documents` 下所有包含 `deploy.yaml` 的项目，明确排除 ECAT。本文只记录可公开或不可逆的证据，不包含 Token、密码、SSH 私钥和业务配置值。

## 验收口径

每个项目必须同时满足：

1. CNB 构建完成，并能关联到精确提交；
2. 项目完整服务集合已保存到腾讯云 TCR，每个服务固定为 `sha256` 摘要；
3. 服务器容器健康，共享 Caddy 已加入该项目的独立 Docker 网络，线路路由片段存在；
4. 公网地址返回 HTTP 200，且首页包含该项目唯一的 `ABCDeploy 上线验收` 标识。

仅触发任务、仅生成标签、仅容器启动或仅公网返回 200，均不单独算上线成功。

## 验收结果

| 项目 | CNB 构建 | 提交 | 公网证据 | 首页唯一标识 |
| --- | --- | --- | --- | --- |
| ABCDeployFreshAudit | `cnb-8f8-1jtqg2o4q` | `e7d16213878fd3944655b9fcdebceb75d3942eda` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-abcdeployfreshaudit/) · HTTP 200 | `FRESH AUDIT` |
| ABCDeployNoobTest | `cnb-73o-1jtqe9ln5` | `97e34a16c38c68d24ff6a9da5fc14c8e86ab0da3` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-abcdeploynoobtest/) · HTTP 200 | `NOOB TEST` |
| ABCDeploy / deploydesk | `cnb-ono-1jtqgvkds` | `49cda00d7c560606586015cc971d8aba4354b984` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-abcdeploy/) · HTTP 200 | `DEPLOYDESK` |
| FinAgent | `cnb-jag-1jtqh2u0q` | `e38a47275f887fde4e42e6d061d846ce7456160f` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-finagent/) · HTTP 200 | `FINAGENT` |
| FinAgentCrm | `cnb-3u8-1jtqimagu` | `de6758ce87ae836ed03436a91b9fc2ab89cb5e23` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-finagentcrm/) · HTTP 200 | `FINAGENT CRM` |
| swiftEng | `cnb-qrg-1jtqk4rrt` | `8f4bd7f0a172de127bb2eb6c6a7a2e07cba341bc` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-swifteng/) · HTTP 200 | `SWIFTENG` |
| wx | `cnb-u7g-1jtqm402r` | `645dda4f17e3b43fa4aadba993338deefc7c0a16` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-wx/) · HTTP 200 | `WX` |
| wxseo | `cnb-svo-1jtqmaain` | `66322ccc9153d04d017adaa89d87ec7112f1de8a` | [打开](https://h5.finagent.cloud/abcdeploy-pilot-wxseo/) · HTTP 200 | `WXSEO` |

## 不可变镜像证据

### ABCDeployFreshAudit

- `api`：`ccr.ccs.tencentyun.com/finagent/abcdeployfreshaudit-api@sha256:ed92351e36fcf594253d36807b6fa6dcc94160606ffd2bcbf15797bbb558264d`
- `web`：`ccr.ccs.tencentyun.com/finagent/abcdeployfreshaudit-web@sha256:b6f9aa34182700eb9026d5a38bcf05689c5a4f461caebeb1b4615b9e197473f4`

### ABCDeployNoobTest

- `api`：`ccr.ccs.tencentyun.com/finagent/abcdeploynoobtest-api@sha256:68671478d138faa4050909bf74986e43333b58d0c110f80aa00b30292a944016`
- `web`：`ccr.ccs.tencentyun.com/finagent/abcdeploynoobtest-web@sha256:ff8b44a6c07c06439dbb8194662957499876bcf774ead04f7654f06e97173b19`

### ABCDeploy / deploydesk

- `site`：`ccr.ccs.tencentyun.com/finagent/abcdeploy-site@sha256:c24339e578db15513fba95a4f98b368a8a6e6304e0838c7bc3289097eae9b913`

### FinAgent

- `api`：`ccr.ccs.tencentyun.com/finagent/finagent-api@sha256:819b2030e2a87cf02c933b57b2ec5327491655c724858a390464f733285303eb`
- `h5`：`ccr.ccs.tencentyun.com/finagent/finagent-h5@sha256:3fca9efa4c31b03033fc4aff6f603970ffda5f7f583bb127a7b13495cab1d659`
- `ocr`：`ccr.ccs.tencentyun.com/finagent/finagent-ocr@sha256:ef85e3f81b21fc18dd0b688343d0efcff0dc777602b2460996ce0ead0f7ebfbb`

### FinAgentCrm

- `api`：`ccr.ccs.tencentyun.com/finagent/finagentcrm-api@sha256:ae94422d4fb87d9331e187f77218156634a960986cad82ac4985c85af4c11f8a`
- `mobile`：`ccr.ccs.tencentyun.com/finagent/finagentcrm-mobile@sha256:8ba8c9e83259feea96de17dba2f11e9dcd50b12ab21495d6811ad17216956970`
- `web`：`ccr.ccs.tencentyun.com/finagent/finagentcrm-web@sha256:63ff7aa44576fd07dd18c220c7437c643112d84e041aed4af94c141c050184dd`

### swiftEng

- `backend`：`ccr.ccs.tencentyun.com/finagent/swifteng-backend@sha256:395693a7c2d1d76b909e5fabc0699654e8ee5c1ef8c3719378f1b681528cce72`
- `frontend`：`ccr.ccs.tencentyun.com/finagent/swifteng-frontend@sha256:1a4e6c7685b9375c8712b0ce0d0649aab3a77ad4bc3f5e07b425e3fbe93af6b7`

### wx

- `api`：`ccr.ccs.tencentyun.com/finagent/wx-api@sha256:cded92f3258cabe71f157ede0c775e643a90e1b5ea90232fb9f85ab11f04d55a`
- `miniapp-resume-assistant`：`ccr.ccs.tencentyun.com/finagent/wx-miniapp-resume-assistant@sha256:6c9d4ab8ab8e0f7c0befd358d2051082fae6bc977d3dcf419347b2769f1b501b`
- `miniapp-toolbox`：`ccr.ccs.tencentyun.com/finagent/wx-miniapp-toolbox@sha256:9f0e70edb228f3a2ca6e6e974c2004afc38f3f2cadf6024761b7f8710db1aaed`

### wxseo

- `api`：`ccr.ccs.tencentyun.com/finagent/wxseo-api@sha256:bd2a4f2b0fdfb6a9f267f53775d4741b822572905560bdfa848eaf83716b7f44`
- `web`：`ccr.ccs.tencentyun.com/finagent/wxseo-web@sha256:4fee65fbb3ac76f87043aad7379fb79aac517a7d857786618770e073e71b74a4`

## 本轮实机发现并关闭的问题

- 长时间无输出的 Docker 拉取或推送不再被 15 秒 SSH 静默超时误判为断线；改用 SSH keepalive。
- 非根路径路由从应用部署中拆成独立 Caddy 事务，并在校验、reload 前强制证明 Caddy 已加入项目网络。
- 公网返回 200 不再自动视为成功；必须匹配当前项目首页标识，避免命中旧站点兜底页。
- 已保存线路会吸收项目新增的安全非敏感默认值；托管 PostgreSQL 同时回填 URL、库名、用户和密码。
- PostgreSQL 项目会校验 `DATABASE_URL` 协议，不能再把有值但类型错误的 MySQL 地址当作有效配置。
- pnpm 工作区镜像按依赖拓扑构建目标服务，运行镜像包含可选 `configs/` 资源，并避免裁剪阶段临时下载工具。
- 不健康镜像要求生成新版本；服务器、配置和路由修复仍继续同一任务，避免反复部署同一坏镜像。
- 静态网页的 Vite/Taro/UniApp 变量归构建期，不再作为服务器运行时必填项重复询问。

## 桌面端本地验收

- 严格检查：`pnpm lint` 通过，Rust Clippy 零告警；
- Rust：桌面后端 106 项、部署核心 82 项、集成夹具 3 项通过；
- 前端：16 个测试文件、247 项测试通过；发布清单 2 项测试通过；
- 本地包：使用 `pnpm tauri:build:app` 生成 Apple Silicon `ABCDeploy.app`，未升级版本、未生成 DMG、未触发远端发布；
- 签名：Apple Development 身份、Hardened Runtime 和仅供本地开发验收的 `get-task-allow` 权限均已核对，`codesign --verify --deep --strict` 通过；
- 启动：最终 `.app` 已由 macOS LaunchServices 实际启动并保持运行，不只是完成编译或静态验签。

## 复核结论

2026-07-18 最终复核时，8 个项目的公网地址均返回 HTTP 200 并匹配各自唯一标识；服务器侧 8 个项目网络均包含共享 `infra-caddy`，8 份线路路由片段均存在。此结果满足[产品实施合同](product-contract.md)第 11 节的真实试点验收要求。
