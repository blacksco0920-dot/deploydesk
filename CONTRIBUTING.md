# 贡献指南

感谢参与 ABCDeploy。项目面向第一次接触部署的用户，技术正确性和可理解性同等重要。

## 开发环境

- Node.js 22
- pnpm（版本由根 `packageManager` 固定）
- Rust 1.97+
- Tauri 2 对应平台依赖
- 可选 Docker，用于生成 Compose 的集成校验

```bash
pnpm install
cargo test --workspace
pnpm --filter @abcdeploy/desktop test
pnpm dev
```

## 提交前检查

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --filter @abcdeploy/desktop test
pnpm --filter @abcdeploy/desktop build
pnpm --filter @abcdeploy/site build
pnpm --dir examples/hello-fullstack install --frozen-lockfile
pnpm --dir examples/hello-fullstack build
bash -n scripts/server-bootstrap.sh
```

修改 Manifest 类型后，刷新 Schema：

```bash
cargo run -p deployctl -- schema --output schemas/deploy.schema.json
```

修改扫描或生成器后，刷新示例并确认没有意外差异：

```bash
cargo run -p deployctl -- plan examples/hello-fullstack
cargo test -p deploy-core --test hello_example
cargo test -p deploy-core --test ecat_fixture
```

## 设计约束

- 不读取真实 `.env`；扫描只处理示例文件的键名。
- 不把密钥值写入 Manifest、Plan、日志、测试快照或 Git。
- 外部输入进入 shell、URL、路径或 Caddy 前必须结构化校验或安全编码。
- 写操作必须有对应只读 Plan 和显式确认。
- staging/production 不共享 namespace、数据库、Redis 前缀、密钥文件和发布记录。
- 生产必须按摘要部署已验证候选，不重新构建“看起来一样”的镜像。
- 用户可见交付默认使用中文；字段名、代码、协议名等必须英文的内容除外。

## Pull Request

一个 PR 尽量只解决一个问题。描述中请包含：

- 用户场景与风险
- 实现选择和未选择方案
- 测试证据
- UI 改动截图（如有）
- 是否影响 Manifest/生成文件兼容性

新增 Provider 时，应同时提供错误脱敏、权限说明、只读检查和隔离测试。不要在测试中使用个人服务器、生产仓库或真实凭据。
