# 暂停与卸载

## 暂停还是撤销

| 目的 | 命令 | 用户人设 |
|---|---|---|
| 临时暂停 / 恢复原范围 | `agent-purge pause` / `agent-purge resume` | 保留 |
| 仅撤销一家常驻配置 | `agent-purge uninstall dsh` | 保留，其他通道不变 |
| 撤销一家全部已选通道 | `agent-purge disarm dsh` | 保留 |
| 撤销所有登记的接管 | `agent-purge clean` | 保留 |

```bash
agent-purge pause
agent-purge resume
agent-purge disarm dsh
agent-purge clean
```

## 卸载程序

卸载 npm 程序时，先撤销接管，再移除程序：

```bash
agent-purge clean
npm uninstall -g agent-purge
```

Windows 安装器卸载也会先撤销接管并保留人设。发生恢复冲突时，保留报错指出的文件和凭据，先比较修改再处理；**不要直接删除备份**。历史会话中已经发送的内容无法撤回。

## 永久删除数据

需要永久删除数据时，先备份，再按[命令行参考的卸载章节](/reference/cli#暂停撤销和卸载)操作；`self-uninstall --yes` 与普通卸载不同。

## 隐私边界

- **本机管理**：默认数据目录为 `~/.agent-purge/`；Windows 对应 `C:\Users\<用户>\.agent-purge\`。可通过 `AGENT_PURGE_HOME` 调整，程序升级不会覆盖这份目录。
- **模型请求仍会联网**：启用后，人设会随宿主请求发送给其配置的模型服务；本地管理不等于离线运行。更新检查也会访问 GitHub。
- **不直接修改宿主权限**：项目管理提示词和配置入口，不破解宿主、不绕过授权；不保证改写后的模型行为。
- **只在有权管理的环境使用**：Web 仅监听 `127.0.0.1`，不要直接暴露到公网。完整要求见[合规声明](/LEGAL)。