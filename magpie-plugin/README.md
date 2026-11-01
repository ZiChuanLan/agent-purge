# magpie 网关插件

可选集成：改写经过 magpie 网关的请求提示词，读取与 CLI 相同的人设和模式。

**插件入口是本目录，不是仓库根目录。** 根 `package.json` 是 CLI；插件不在 agent-purge 的 npm 包里。

## 安装

```bash
git clone https://github.com/ZiChuanLan/agent-purge
agent-purge ls
node /path/to/agent-purge/magpie-plugin/gen-personas.mjs
magpie plugin add /path/to/agent-purge/magpie-plugin
magpie plugin list
```

先运行一次 agent-purge 以初始化人设。增删人设后重新运行 `gen-personas.mjs`；生成的 `page/personas.js` 只属于本地，不提交。

插件读取 `~/.agent-purge/`，也支持 `AGENT_PURGE_HOME`。切换 CLI 人设后，下一个经过网关的请求读取新设置。插件页设置会写入 magpie options。

## 配置

```bash
magpie plugin options magpie-plugin '{"mode":"append"}'
```

上述插件名按安装目录名 `magpie-plugin` 使用。

| 字段 | 用途 |
|---|---|
| `mode` | `off` / `strict` / `replace` / `append` |
| `persona` | 人设标识 |
| `agents` | 限定执行器，例如 `["claude","codex"]` |

`off` 不改请求；`strict` 替换可控 system 文本；`replace` 近似删除身份行后放入人设；`append` 将人设置于宿主文本**之前**，与 CLI 的后置位置不同。

## 边界与测试

- 只处理经过网关的请求，不能修改客户端已经固定的行为或未经过网关的流量。
- strict 会移除原 system 中的工具说明文本；不等于清空独立的结构化工具定义。
- 插件页不能直接读取本地文件，人设列表由生成脚本提供。
- `npm test` 包含钩子与页面逻辑回归，不依赖 magpie；这些测试不等于所有 magpie 版本的真实安装验收。

[主项目](../README.md) · [使用指南](../docs/usage.md)
