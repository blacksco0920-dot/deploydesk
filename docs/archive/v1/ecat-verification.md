# Ecat 只读验证记录

## 目的

Ecat 是真实多应用 monorepo，用来验证扫描器不会依赖逐文件人工分析，也不会读取业务密钥值。验证过程只读访问原项目，没有写入 Ecat、CNB、服务器、域名或生产容器。

## 真实项目识别结果

- pnpm monorepo
- NestJS API
- Vite 管理端
- Taro 小程序/H5
- Prisma Schema
- 3 个已有 Dockerfile
- 环境变量只记录字段名与来源

## 可公开回归样本

[`fixtures/ecat-energy`](../../../fixtures/ecat-energy) 只保留匿名化目录、依赖声明、空 Dockerfile 和测试哨兵。它不包含业务代码、真实域名、账户或密钥。

`.env.example` 中故意放入 `DO_NOT_LEAK_SENTINEL`。测试断言：

- 报告包含 `DATABASE_URL`、`JWT_SECRET` 等名称。
- 序列化报告不包含哨兵值。
- 敏感变量只分配给 API，不进入 Vite/Taro 静态服务。
- 自动生成 development、staging、production 三份 Compose/Caddy。
- 默认 `test` 和 `main` 分支映射正确。
- 测试与生产 namespace、数据库、密钥引用不同。

## 复现

```bash
cargo run -p deployctl -- inspect fixtures/ecat-energy --json
cargo run -p deployctl -- init fixtures/ecat-energy
cargo test -p deploy-core --test ecat_fixture
```

`init` 不带 `--write` 时只输出 Plan。
