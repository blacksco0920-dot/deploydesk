# 安全策略

## 支持范围

当前维护 `0.1.x Alpha`。安全修复会优先进入最新 Alpha；在首个稳定版前不承诺旧 Alpha 的长期补丁。

## 报告漏洞

请不要在公开 Issue 中提交 Token、私钥、服务器地址、日志原文或可利用细节。使用 GitHub Security Advisory 的私密报告功能，并提供：

- 受影响版本和平台
- 最小复现步骤
- 预期影响
- 已做的脱敏说明

维护者会在 72 小时内确认收到报告。公开时间由修复可用性和报告者共同决定。

## 密钥边界

- 桌面端 Token 只传给本机 Rust 进程；选择“记住”时写入操作系统密钥库。
- `deploy.yaml` 只声明变量名、引用和非敏感默认值。
- CNB 真实值只存于密钥仓库，通过 `imports` 注入。
- 生成的 `.runtime.env` 位于 CNB 临时工作区和远程 `~/.deploydesk`，权限为 `0600`，不进入 Git。
- 日志和错误在跨越核心边界前经过脱敏。
- CLI 的 CNB Token 只从 `CNB_TOKEN` 环境变量读取，不接受命令行参数。

## 写操作边界

- 项目文件先 Plan/Diff，Apply 需要明确确认。
- 文件使用同目录临时文件原子替换，旧文件先备份。
- Caddy 初始化需要 SSH 验证、界面勾选和 Rust 侧 `confirmed` 二次检查。
- 服务器初始化发现其他 Docker 容器占用 80/443 时停止，不替换现有代理。
- 生产部署只接受已验证镜像摘要，不使用 `latest`。

## SSH

本地连通性检查首次使用 `accept-new`，便于用户建立本机 known_hosts。CNB 部署不调用 `ssh-keyscan`，必须从环境专属密钥文件注入 `*_SERVER_KNOWN_HOSTS`，并使用 `StrictHostKeyChecking=yes`。

`ssh-keyscan` 输出本身不能证明服务器身份。请把指纹与云厂商控制台、服务器串行控制台或管理员提供的可信指纹比较后再填写。

## 受信代码

能修改 `.cnb.yml`、Dockerfile 或构建脚本的人，理论上可以读取流水线已导入的环境变量。生产建议：

- 保护 `main` 分支并要求评审。
- CNB 密钥文件设置 `allow_slugs`、`allow_events`、`allow_branches` 最小范围。
- 测试与生产使用不同文件和前缀。
- Fork/不可信 PR 不允许引用生产密钥。
- 定期轮换 Token、镜像仓库凭据和 SSH Key。

## 不纳入报告的内容

- 用户主动把真实密钥提交到 Git。
- 未签名 Alpha 安装包的操作系统来源提示。
- 没有可信指纹来源时，`ssh-keyscan` 无法验证身份这一协议限制。
- 已明确记录且没有越过边界的 Alpha 功能缺失。
