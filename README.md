# dsh-session-manager

DeepSeek Harness（DSH）的**独立会话管理器**：一个离线命令行工具，不是插件，零依赖。

| 功能 | 说明 |
|---|---|
| 列出会话 | 跨所有工作区列出会话：标题、最后使用时间、目录、大小，以及「归档 / 置顶 / 子代理 / 旧代际 / 被 DSH 隐藏」标记 |
| 升级旧会话 | 把 v0 / v2 / v3 会话升到当前代际（v4），调用 **DSH 自带的迁移器**，旧文件原样保留 |
| 清理空会话 | 找出「新建后一条消息都没发」的会话，移入回收站 |
| 归档 / 取消归档 | 用 DSH 自己的归档集合（`archivedSessionIds`），日志和工作区槽位都不动 |
| 回收站 | 移入、恢复（回到原工作区槽位，归档 / 置顶标记一并恢复）、彻底删除 |
| 清洗循环 | 截掉历史里已经提交的 `Go. Emit. Let me write.` 类循环（检测规则与 [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue) 同一套） |
| 修复被隐藏的会话 | 压缩帧布局不合 DSH 要求的会话会被 DSH 当成损坏、从列表里静默隐藏；按 DSH 的格式重写即可恢复 |

## 使用

**Windows（推荐）：** 从 [Releases](https://github.com/citydirector/dsh-session-manager/releases) 下载 `dsm-win-x64.zip`，解压出 `dsm.exe`（单文件，自带 Node，不用另装任何东西）。放在任意位置（推荐放进 DSH 安装目录，例如 `D:\dsh-desktop\tools\`），**先完全退出 DSH（含托盘）**，然后双击 `dsm.exe`，按菜单序号操作：

```
 1. 列出会话          5. 取消归档          9. 清洗循环
 2. 升级旧会话        6. 移入回收站       10. 撤销循环清洗
 3. 清理空会话        7. 从回收站恢复     11. 修复被 DSH 隐藏的会话
 4. 归档会话          8. 彻底清空回收站    0. 退出
```

> `dsm.exe` 没有代码签名，第一次运行 Windows SmartScreen 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」。
> 升级旧会话要跑 DSH 自己的迁移器，`dsm.exe` 会用 DSH 自带的 node（便携版 `node\node.exe`、桌面版本体），其它功能都不依赖外部程序。

**源码方式：** 也可以克隆仓库后双击 `dsm.cmd`，它会找 Node 22.15+（`DSM_NODE` → DSH 便携版/桌面版自带的 node → PATH）。

数据目录自动查找（`DSH_HOME`、工具所在目录的上级、`C/D/E:\dsh-desktop\data`、`dsh-portable\data`、`~/.dsh`），找到多个会让你选。也可以手动指定：

```bat
dsm.exe --home D:\dsh-desktop\data
```

**命令行：**

```bat
dsm list --all                 :: 全部会话（含已归档）
dsm upgrade                    :: 升级旧代际会话
dsm empty                      :: 空会话 → 回收站
dsm archive 3 5                :: 按序号归档；也可以写会话 ID 前缀或标题关键字
dsm unarchive "qq-bot"
dsm trash 2-4                  :: 移入回收站
dsm restore                    :: 选择恢复
dsm purge --older-than 30      :: 彻底删除 30 天前进回收站的条目
dsm loops                      :: 检测并清洗循环；dsm loops --undo 撤销
dsm repair                     :: 修复被 DSH 隐藏的会话
```

通用选项：`--home <数据目录>`、`--dry-run`（只看不改）、`--yes`（不逐个确认）、`--force`（跳过「DSH 是否在运行」检测，不推荐）。

## 安全约定

- **DSH 必须完全退出。** DSH 的 JSONL 后端只允许一个写入者，账目（`workspace.json`）也由 DSH 在内存里持有。实测：DSH 运行时从外部改的归档，会在 DSH 下一次写账目时被**静默覆盖**。所以所有修改类操作都会先检测 DSH 进程，检测不到结果也按「在运行」处理（失败即关闭）。
- **日志内容只在两种操作里被改写：** 循环清洗和帧修复。两者都先把原文件备份到 `<数据目录>\.dsm\backups\<时间>\`，写后自检（事件数不变、能完整解码、帧布局合法）。
- **回收站不删任何东西：** 整个会话目录连同投影缓存搬到 `<数据目录>\.dsm\trash\<时间>\`，每次一个新批次，不覆盖旧条目。恢复时目标已存在就拒绝，绝不合并两份历史。
- **账目修改前备份：** 每次写 `workspace.json` 前在 `.dsm\backups\<时间>\` 留一份。
- 工作区目录永远从会话日志头读取，不从有损的项目目录名反推。投影缓存（`session_projcache`）是派生数据，只随会话搬动，不编辑。
- 升级用 DSH 自带的迁移器（便携版 `app\migrate-sessions-v4.mjs`，桌面版 `resources\dsh-build\migrate-sessions-v4.mjs`），以 `--jobs 1` 串行运行：并发迁移时父子会话会互相触发 `generation changed during verification`。没有迁移器时可以用 `--migrator <路径>` 指定，或者在 DSH 里逐个打开旧会话让 DSH 自己升级。

## 两个容易踩的 DSH 格式细节

1. **`session.v4.jsonl.zstd` 是多帧文件：** 头部一帧，之后每次追加一帧。Node 的 `zlib.zstdDecompressSync` **只解第一帧**，直接用它读会只拿到头部一行。本工具逐帧解码。
2. **第一帧必须恰好是一行头部：** DSH 列会话时只解第一帧并校验，不合格就把会话当损坏、**不显示、不报错**。把整个日志压成单帧写回（很多第三方工具会这么做）就会让会话「消失」——`dsm repair` 能找回来。

## 测试

```bash
npm test                         # 单元测试
node scripts/build-exe.mjs       # 打包 dist/dsm.exe（Node SEA，Linux/Windows 都能打 Windows 版）
node scripts/smoke-exe.mjs dist/dsm.exe   # 打包后冒烟测试，含「DSH 在跑就拒绝」
```

GitHub Actions 在 `windows-latest` 上跑单元测试、打包和冒烟测试，打 `v*` 标签时自动发布 `dsm-win-x64.zip`。

单元测试用合成的 DSH 布局覆盖全部操作。另外在 DSH `0.2.1-rc.2`（以及用 `0.1.2-rc.1`、`0.1.6-alpha.2`、`0.1.7-rc.2`、`0.2.0-rc.2` 生成的旧会话）上做了端到端验证：每步操作后重启 DSH，通过 DSH 自己的 `session/list` 核对会话、代际状态和空白标记，并对升级、清洗后的会话继续发消息。

## 许可

MIT
