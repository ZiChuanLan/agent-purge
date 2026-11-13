# 参与开发

感谢帮助维护 agent-purge。提交前请用最小可复现步骤说明问题，并为行为修改添加回归测试。

## 本地开发

```bash
npm ci --ignore-scripts
npm run check:repo
npm test
npm run web
```

运行要求为 Node.js 20+，生产代码不依赖第三方 npm 包。Playwright 和 axe 仅用于开发测试。

## 仓库结构

```text
bin/             CLI 入口
lib/             状态、通道、恢复、进程和验证服务
backends/        各执行器的启动适配
web/             原生 HTML / CSS / JavaScript 控制台
magpie-plugin/   可选网关插件
bench/           请求捕获和 CLI armor 使用的评测工具
test/            隔离回归、插件与浏览器测试
scripts/         构建、发行包验收和仓库检查
packaging/       Windows 安装脚本与启动器源码
docs/            用户指南、兼容性、架构和发布说明
```

`bench/` 并非无用测试产物：`agent-purge verify` 和 `armor` 依赖其中的模块，需随运行包保留。测试源码与临时测试结果是不同的东西。

## 测试命令

| 命令 | 范围 |
|---|---|
| `npm run check:repo` | Git 可提交文件、私有/生成文件排除、文档链接、发行白名单 |
| `npm test` | 核心逻辑、文件恢复、执行器适配、Web API 和插件回归 |
| `npm run test:package` | 实际 npm tarball 离线安装、CLI/Web 资源 |
| `npm run test:ui` | 三浏览器、四种宽度、键盘与自动无障碍检查 |
| `npm run test:harness` | 实际宿主请求捕获；需要本机安装相应宿主 |
| `npm run test:artifacts` | Windows ZIP 和独立 EXE 验收 |

浏览器首次测试先执行：

```bash
npx playwright install chromium firefox webkit
npm run test:ui
```

Windows 可用已有 Edge：`$env:PLAYWRIGHT_CHANNEL='msedge'; npm run test:ui -- --project=chromium`。

核心测试使用临时 HOME，不应读写真实人设、宿主配置或凭据。真实宿主测试默认使用本地测试 provider；它不是完整的操作系统网络沙箱。不要为通过测试而删除失败项或把模拟回调写成实机通过。

## 提交规范

- 保留 `package-lock.json`，开发依赖变化必须同步更新。
- 新测试放进 `test/`，浏览器测试放进 `test/browser/`；不要把一次性调试脚本散落在根目录。
- 测试输出、原始请求、开发日志归 `out/`；构建产物归 `dist/`。两者不进入 Git 或 npm。
- `.pi/`、`.opencode/`、个人 `personas/`、`state.json` 和 `.env` 均为本地数据；不要用 `git add -f` 强制提交。
- `docs/images/` 只保留当前产品截图；图标仅保留代码实际使用的版本。
- 提交前检查 `git status --short` 与 `git diff --check`，勿直接提交所有本地文件。

CI 会运行仓库检查与测试，但不会代替代码审查或自动发布。[架构约定](docs/reference/architecture.md) · [发布流程](docs/releasing.md)
