# 发布流程

构建和检查不会提交代码、推送、打标签、发布 npm 或创建 GitHub Release。`release-check` 只上传 Actions artifact。

## 发布前检查

```bash
npm ci --ignore-scripts
npm run check:repo
npm test
npm run test:package
npx playwright install chromium firefox webkit
npm run test:ui
```

同时审核[兼容性与已知限制](reference/compatibility.md)。原始测试输出放在 `out/`，不要提交截图过程稿、缓存、私人配置或测试安装目录。

## Windows 构建

构建机需要 Node.js 20+、Bun、GCC/windres 和 Inno Setup 6。当前 CI 固定 Bun 1.4.4；每次发布记录实际工具链版本。

```bash
npm run build:setup
npm run build:exe
npm run test:artifacts
npm run release:checksums
```

| 文件 | 内容 |
|---|---|
| `dist/agent-purge-<版本>.zip` | Node 薄包及图形启动器，需要外部 Node |
| `dist/agent-purge-<版本>-setup.exe` | 薄包安装器，需要外部 Node |
| `dist/agent-purge.exe` | 内含运行时的独立 Windows EXE |
| `dist/SHA256SUMS.txt` | 最终三个产物的校验值 |

ZIP 里的 `agent-purge.exe` 是薄启动器，**不是**独立 EXE。安装器构建会校验薄包的 manifest 与当前源码，不能复用旧目录或混装产品。

## macOS 构建

`npm run build:dmg`（仅可在 macOS 上执行，正式发布由 `.github/workflows/release.yml` 的 `build_mac` 在 `macos-latest` runner 自动执行）会借助 Bun 编译 `darwin-arm64` / `darwin-x64` 单文件二进制，打包 `.app` 与 `AppIcon.icns`，再用 `hdiutil` 生成并校验：

- `dist/agent-purge-<版本>-darwin-arm64.dmg`
- `dist/agent-purge-<版本>-darwin-x64.dmg`

产物未做 Apple `codesign` 签名与 `notarytool` 公证，首次打开会触发 Gatekeeper 提示（右键「打开」或 `xattr -cr` 放行）。


## Linux 构建

`npm run build:linux`（也可在任意 Linux 上本地执行，正式发布由 `.github/workflows/release.yml` 的 `build_linux` 在 `ubuntu-latest` runner 自动执行）用 Bun 交叉编译 `linux-x64` / `linux-arm64` 单文件二进制，本机架构会真实跑一次 `smoke`（`--help`、`status`、`--serve` 静态资源与版本号），再产出：

- `dist/agent-purge-<版本>-linux-<架构>`：自带运行时的单文件二进制
- `dist/agent-purge-<版本>-linux-<架构>.tar.gz`：便携包，含 `.desktop`、图标、`LICENSE`、`README` 与免 root 的 `install.sh`
- `dist/agent-purge-<版本>-linux-<架构>.deb`：`dpkg-deb` 构建并回读校验元数据与文件清单，安装到 `/opt/agent-purge` 并注册 `/usr/bin` 入口
- `dist/agent-purge-<版本>-linux-<架构>.AppImage`：仅在 runner 上能取到 `appimagetool` 时生成，不作强制要求
- `dist/linux-manifest.json`：上述产物的 SHA-256 汇总

可用 `--native-only` 只构建当前架构，`--no-deb` / `--no-appimage` 关闭对应产物。`.deb` 的维护者字段可用 `AGENT_PURGE_MAINTAINER` 覆盖。
## 安装验收

`scripts/check-installer.ps1` 默认只接受临时 Windows Actions runner。本机验收需要明确使用：

```powershell
./scripts/check-installer.ps1 -AllowLocalMachine
```

脚本会先检查是否已有安装记录、桌面快捷方式或开始菜单组，存在则拒绝改动。测试使用系统临时目录、独立 HOME 和专属数据，执行：

1. 缺少 Node 时拒绝安装且不挂起。
2. 中文/空格路径的安装、CLI 应用、同版本重装。
3. 通过实际原生启动器访问 Web 和静态资源。
4. 恢复冲突时停止卸载并保留凭据。
5. 修复后卸载，核对人设与原配置字节、注册表和快捷方式。

本机隔离测试不等于全新系统。发布前还需检查低版本 Node、GUI 提示、SmartScreen、跨版本升级、权限不足和[已知覆盖安装问题](reference/compatibility.md#已知发布限制)。

## CI

- `test.yml`：Windows / Ubuntu / macOS × Node 20 / 22 / 24，tarball 安装，三浏览器 UI 检查，以及 Ubuntu 上的 `build:linux` 产物构建与上传。
- `release-check.yml`：Windows 构建、ZIP/EXE、安装卸载、校验值和候选包 artifact。
- `release.yml`：版本 tag 或手动触发的正式发布流程；先跑完整测试与打包，再发布 npm 和 GitHub Release。
- Actions 固定到 commit SHA；构建任务只读，只有 publish job 获得 `contents: write` 和 `id-token: write`。
- 本地未提交改动不在远端历史绿色记录覆盖范围内，必须在最终提交上重新运行。

## 正式发行

`release.yml` 是唯一的自动发布入口；`release-check.yml` 仍然只产出候选 artifact，不会发布。发布前确认：

1. `package.json` 版本与 tag 一致（例如 `0.2.11` 对应 `v0.2.11`）。
2. GitHub 仓库 secret `NPM_TOKEN` 是 npm automation/granular token，具备 `agent-purge` 的 publish 权限；不要提交到 `.npmrc` 或源码。
3. 版本、变更、许可和兼容性说明已审核；工作区干净。

发布方式：

```bash
git tag v0.2.11
git push origin v0.2.11
```

tag 推送会触发 `release.yml`：

1. `verify`：Node 24 上 `npm ci`、`check:repo`、全部测试、`test:package`。
2. `build` / `build_mac` / `build_linux`：分别在 Windows 上构建 ZIP/EXE/setup 并跑安装验收、在 `macos-latest` 上构建 arm64/x64 未签名 `.dmg`、在 `ubuntu-latest` 上构建 Linux 二进制 / `.tar.gz` / `.deb`（AppImage 可选）；汇总产物、校验和与 npm tarball。
3. `publish`：校验 tag 与版本一致；`npm publish --provenance`（已存在的同版本会跳过）；创建 GitHub Release 并上传附件。

需要重跑时使用 Actions 的 `workflow_dispatch`，输入已存在的 tag；发布是幂等的，不会重复上传同版本 npm 包，Release 附件使用 `--clobber` 覆盖。

正式发行前核对 [LICENSE](https://github.com/ZiChuanLan/agent-purge/blob/main/LICENSE)、README 和[免责与合规声明](LEGAL.md)的表述。软件继续采用 MIT 许可；使用声明用于说明风险与责任，不附加相冲突的授权限制。修改声明时应同步 README 中的完整文本。
