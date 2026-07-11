# 安装包发布

ABCDeploy 的安装包发布分为构建与分发两层，二者可以独立替换：

1. GitHub Actions 在 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 上原生构建安装包。
2. Release 附带 `SHA256SUMS` 与 `latest.json`，用于完整性校验和下载页识别。
3. 官网从同域 `/releases/latest.json` 读取版本信息，从 `/downloads/v<version>/` 下载文件，不调用 GitHub API。
4. `scripts/publish-release-assets.sh` 把已验收的安装包平铺到服务器静态目录；TCR、CNB 和应用容器不参与文件下载。

## 预览版发布

```bash
git tag v0.2.0-preview.1
git push origin v0.2.0-preview.1
```

跨平台工作流全部成功后，下载并检查 Release 资产，再发布到国内站点：

```bash
RELEASE_HOST=<服务器地址> \
RELEASE_USER=<SSH 用户> \
scripts/publish-release-assets.sh \
  0.2.0-preview.1 \
  <安装包目录>
```

脚本只接受当前版本的 `.dmg`、`.exe`、`.msi`、`.AppImage` 和 `.deb`，使用已有 `known_hosts` 严格校验服务器身份，生成 SHA-256 后上传到：

```text
/opt/infra/releases/abcdeploy/
  latest.json
  v0.2.0-preview.1/
    SHA256SUMS
    <安装包>
```

## 放行检查

- 版本在 Cargo、Tauri、桌面端、官网和根 `package.json` 中一致。
- 三平台 CI、Rust 测试、前端测试和官网容器构建全部成功。
- 每个安装包名称包含完整版本号，`latest.json` 不引用旧版本文件。
- 下载 URL 返回安装文件而不是 HTML 错误页，SHA-256 与本地一致。
- macOS 检查 DMG、应用架构和签名状态；Windows、Linux 在对应 CI 主机完成原生打包。
- 预览版未配置商业签名或公证时，官网和 Release 必须明确提示，不能标记为稳定版。
- 官网生产容器和现有业务生产环境只在单独批准后更新。
