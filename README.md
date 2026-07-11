# ABCDeploy 小白部署

[![CI](https://github.com/blacksco0920-dot/abcdeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/blacksco0920-dot/abcdeploy/actions/workflows/ci.yml)
[![Release](https://github.com/blacksco0920-dot/abcdeploy/actions/workflows/release.yml/badge.svg)](https://github.com/blacksco0920-dot/abcdeploy/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563a6.svg)](LICENSE)

面向 vibe coding 用户的引导式容器化部署桌面客户端。选择代码目录后，ABCDeploy 会识别项目、推荐三环境方案，并引导完成 CNB 构建、服务器部署、Caddy HTTPS、生产晋级和版本回滚。

**[访问官网与国内下载](https://abcdeploy.finagent.cloud)** · **[开源仓库与备用下载](https://github.com/blacksco0920-dot/abcdeploy/releases)**

![ABCDeploy 项目工作台](apps/site/public/abcdeploy-workspace.png)

> 当前为 `0.2.0-preview.1`。适合试点和测试环境；正式业务上线前仍应确认数据库备份、域名归属和平台代码签名状态。

## 为什么做这个项目

传统部署工具往往先要求用户理解镜像、流水线、SSH、反向代理和环境隔离。ABCDeploy 把这些知识变成推荐默认值和可恢复步骤：系统能判断的自动完成，必须由用户授权的操作明确展示。

- 重新打开应用会自动恢复项目与部署进度。
- 持久侧边栏同时展示多个项目；切换项目不会中断其他构建任务。
- 只填写服务器地址，自动发现或生成本机 SSH 身份。
- 内部安全值自动生成，第三方配置按测试/生产分别保存。
- 代码只构建一次，测试通过后将同一提交和镜像摘要晋级生产。
- DNS、HTTPS 或应用路由异常会给出对应处理方式，不重复构建镜像。
- 回滚只切换上一健康镜像，不修改数据库、域名和运行配置。

## 默认发布模型

`main` 是稳定代码和发布候选来源，不等于“直接部署生产服务器”。默认流程只有一次构建：

```mermaid
flowchart LR
  A[main 稳定提交] --> B[CNB 验证与构建]
  B --> C[不可变镜像与完整提交 SHA]
  C --> D[自动部署测试环境]
  D --> E[容器与公网健康检查]
  E --> F[创建候选版本 Tag]
  F --> G{CNB 或客户端确认发布}
  G --> H[同一提交晋级生产]
  H --> I[同一镜像摘要]
```

测试和生产只共享已验证的程序镜像。两套环境的域名、变量、数据库、容器网络和发布记录始终独立。

| 环境 | 默认位置 | 用途 | 更新方式 |
| --- | --- | --- | --- |
| `development` | 本机 | 编码、调试、本地依赖 | 用户自己的开发工具 |
| `staging` | 服务器 | 验证真实镜像、依赖和路由 | `main` 稳定提交自动部署 |
| `production` | 服务器 | 正式用户访问 | 测试健康后人工确认晋级 |

## 支持能力

- 识别 NestJS、Next.js、Vite、UniApp、Taro、Prisma 和 pnpm workspace。
- 生成 `deploy.yaml`、Docker Compose、Caddy 和 CNB 流水线；导入 GitHub 项目时可保留兼容同步工作流。
- 使用通用 OCI 镜像仓库契约，国内默认推荐腾讯云 TCR，也可使用 CNB Docker 制品库。
- 使用内置纯 Rust SSH，支持 RSA/Ed25519 私钥和固定服务器指纹。
- 为每个项目生成独立流水线身份，用户登录私钥不会上传到 CNB。
- 使用操作系统钥匙串保存 Token 与测试、生产两份完整运行配置文件。
- 保留部署记录、完整提交 SHA、CNB 构建编号和回滚结果。
- 失败时展示稳定错误码、处理步骤和可折叠技术详情。
- 提供 Rust CLI `deployctl`，用于自动化、Schema 生成和排障。

## 安装

优先从 [ABCDeploy 官网](https://abcdeploy.finagent.cloud) 下载；无法访问时可使用 [GitHub Releases](https://github.com/blacksco0920-dot/abcdeploy/releases) 备用入口：

- macOS Apple Silicon / Intel：`.dmg`
- Windows x64：预览版提供 NSIS `.exe`；稳定版再同时提供 `.msi`
- Linux x64：`.AppImage` 或 `.deb`

Alpha 安装包尚未配置商业代码签名证书时，系统可能显示来源提示。请只从本仓库 Release 下载，并核对发布页面资产。

### 从源码运行

需要 Node.js 22、pnpm 11、Rust 1.97 和对应平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/blacksco0920-dot/abcdeploy.git
cd abcdeploy
pnpm install
pnpm dev
```

仅使用命令行：

```bash
cargo run -p deployctl -- preflight
cargo run -p deployctl -- inspect /你的项目目录
cargo run -p deployctl -- init /你的项目目录
```

`init` 默认只预览。写入部署文件必须显式追加 `--write`。

## 首次部署

### 1. 准备三项资源

| 资源 | 最低要求 | 用途 |
| --- | --- | --- |
| CNB 访问令牌 | 仓库管理、构建触发、创建仓库权限 | 创建普通代码仓库并触发构建 |
| Linux 服务器 | 已安装 Docker Engine 与 Compose 插件，可通过 SSH 登录 | 运行测试/生产容器和统一 Caddy |
| 域名 | 可选，A/AAAA 记录指向服务器 | Caddy 自动申请 HTTPS |

本机云端部署只强制需要 Git。Docker Desktop 和 Node.js 只用于本地完整预览。

### 2. 跟随五步引导

1. **选择项目**：只读识别依赖、脚本、Dockerfile、Prisma Schema 和 `.env.example` 模板。
2. **连接服务**：粘贴一次 CNB Token；填写服务器地址并确认 SSH 指纹。
3. **确认推荐方案**：默认使用一个发布分支、测试自动部署、生产人工晋级。
4. **补充必要信息**：填写可选域名；直接编辑测试、生产两份完整 `.env`，注释和自定义字段原样保留。
5. **查看部署计划**：预览将写入的每个文件，确认后才初始化 Caddy 和启动部署。

### 3. 完成一次 CNB 保护配置

ABCDeploy 可以通过 API 创建普通私有代码仓库，但 CNB 密钥仓库当前仍需在 Web 页面创建和编辑：

1. 应用打开 CNB 创建页，用户选择“密钥仓库”。
2. 应用在内存中生成 `env.staging.yml` 与 `env.production.yml`。
3. 用户分别点击“复制安全配置”，粘贴到对应文件并保存。
4. 回到应用确认完成，部署会从原检查点继续，不重复准备服务器。

安全配置包含 ABCDeploy 为该项目创建的流水线私钥、已确认的服务器公钥和对应环境的完整运行配置文件。内容只在用户点击复制时交给前端，不写入 SQLite、项目目录或日志。

CNB 密钥仓库说明见 [官方文档](https://docs.cnb.cool/zh/repo/secret.html)。

## 生成文件

```text
deploy.yaml                                      项目部署协议
.cnb.yml                                        构建、测试、生产晋级与部署
.github/workflows/sync-cnb.yml                  GitHub 到 CNB 的安全同步
.deploydesk/generated/<environment>/
  docker-compose.yml                            环境独立 Compose
  Caddyfile                                     项目路由片段
  .env.example                                  变量名与非敏感默认值
  secret.example.yml                            CNB 密钥字段示例
```

`.deploydesk` 是 V1 延续下来的内部兼容协议目录。V2 继续使用它，避免升级时破坏已部署项目；这不代表产品仍使用旧品牌。

## 安全设计

- Token、流水线私钥和分环境运行配置文件通过操作系统钥匙串保存。
- 服务器首次连接必须人工确认 SHA-256 指纹，后续指纹变化立即停止。
- 流水线使用项目专属 Ed25519 身份，只把公钥幂等写入服务器。
- GitHub 同步使用临时 HTTP Header，Token 不进入 URL、命令参数或 Git 配置。
- 只允许自动提交 ABCDeploy 拥有的部署文件；发现业务代码未提交时停止同步。
- 生产发布必须引用测试成功记录中的完整提交 SHA，不接受 `latest`。
- 回滚保留 `.runtime.env`、数据库与 Caddy，只切换 `.release.env` 中的镜像摘要。
- 外部错误在进入 UI 和持久化层前统一脱敏。

更完整的边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。
面向用户的故障编号见 [错误码说明](docs/error-codes.md)。

## 本地开发

```bash
pnpm install
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --filter @abcdeploy/desktop test
pnpm --filter @abcdeploy/desktop build
pnpm --filter @abcdeploy/site build
```

构建桌面安装包：

```bash
pnpm tauri:build
```

可运行示例位于 [`examples/hello-fullstack`](examples/hello-fullstack)，Ecat 匿名化扫描回归样本位于 [`fixtures/ecat-energy`](fixtures/ecat-energy)。

## 文档

- [架构设计](docs/architecture.md)
- [分支、环境与镜像晋级](docs/deployment-model.md)
- [安装包发布与国内分发](docs/release.md)
- [V2 产品定义](docs/v2/README.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 当前边界

- CNB Token 仍需要用户在 CNB Web 创建并粘贴一次，等待适合桌面公共客户端的 OAuth/Device Flow 能力。
- CNB 密钥仓库创建与文件保存仍需用户在 Web 页面完成，应用不会模拟浏览器点击或读取登录 Cookie。
- 数据库迁移会被识别，但 Alpha 不会在缺少可验证备份 Provider 时自动执行生产迁移。
- 服务器已有其他进程或容器占用 80/443 时，Caddy 初始化会停止，不替换现有代理。
- macOS、Windows 安装包签名取决于维护者是否配置平台证书。

## 许可证

[Apache License 2.0](LICENSE)
