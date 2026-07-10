# Hello Fullstack

一个可运行的 NestJS + Vite/React pnpm monorepo，用于体验 DeployDesk 首次接入。

```bash
pnpm install
pnpm build
cargo run -p deployctl -- inspect examples/hello-fullstack
cargo run -p deployctl -- init examples/hello-fullstack
```

最后一条命令默认只生成 Plan；确认变化后再加 `--write`。
