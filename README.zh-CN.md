# dsh-session-manager

[English](README.md) · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/tag/citydirector/dsh-session-manager?sort=semver&label=release)](https://github.com/citydirector/dsh-session-manager/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH tool](https://img.shields.io/badge/DSH%20tool-%E2%89%A50.1.2-blue)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）的**独立会话管理器**：离线命令行工具，不是插件，零依赖。DSH 便携版、桌面版、标准安装版（`~/.dsh`）和 npm 版都能用。

| 功能 | 说明 |
|---|---|
| 列出会话 | 跨所有工作区列出会话：标题、最后使用时间、目录、大小，以及「归档 / 置顶 / 子代理 / 旧代际 / 被 DSH 隐藏」标记 |
| 升级旧会话 | 把 v0 / v2 / v3 会话升到当前代际（v4），调用 **DSH 自带的迁移器**，旧文件原样保留 |
| 清理空会话 | 找出「新建后一条消息都没发」的会话，移入回收站 |
| 归档 / 取消归档 | 用 DSH 自己的归档集合（`archivedSessionIds`），日志和工作区槽位都不动；已归档会话可单独列出，挑着删或全删 |
| 回收站 | 移入、恢复（回到原工作区槽位，归档 / 置顶标记一并恢复）、彻底删除 |
| 清洗循环 | 截掉历史里已经提交的 `Go. Emit. Let me write.` 类循环（检测规则与 [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue) 同一套） |
| 修复烂尾会话 | 截掉末尾只有报错 / 重试的轮次，上下文仍过大时离线压缩，让「怎么重试都超长」的会话能接着用 |
| 修复被隐藏的会话 | 压缩帧布局不合 DSH 要求的会话会被 DSH 当成损坏、从列表里静默隐藏；按 DSH 的格式重写即可恢复 |

需要 Windows（`dsm.exe`）或 Node 22.15+（源码）。支持 DSH 0.1.2 起生成的 v0–v4 会话，已在 DSH 0.2.1 上端到端验证。

## 快速开始

**Windows（推荐）：** 从 [Releases](https://github.com/citydirector/dsh-session-manager/releases) 下载 `dsm-win-x64.zip`，解压出 `dsm.exe`（单文件，自带 Node，不用另装任何东西）。

1. 把 `dsm.exe` 放在任意位置（推荐放进 DSH 安装目录，例如 `D:\dsh-desktop\tools\`）。
2. **先完全退出 DSH（含托盘）。**
3. 双击 `dsm.exe`，按菜单序号操作：

```
 1. 列出会话                 8. 从回收站恢复
 2. 升级旧会话               9. 彻底清空回收站
 3. 清理空会话              10. 清洗循环
 4. 归档会话                11. 修复烂尾会话（截尾 + 压缩上下文）
 5. 取消归档                12. 撤销上次日志修改
 6. 已归档会话（查看/删除）  13. 修复被 DSH 隐藏的会话
 7. 移入回收站              14. 换一个数据目录
```

> `dsm.exe` 没有代码签名，第一次运行 Windows SmartScreen 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」。
> 升级旧会话要跑 DSH 自己的迁移器，`dsm.exe` 会用 DSH 自带的 node（便携版 `node\node.exe`、桌面版本体），其它功能都不依赖外部程序。

**源码方式：** 也可以克隆仓库后双击 `dsm.cmd`，它会找 Node 22.15+（`DSM_NODE` → DSH 便携版/桌面版自带的 node → PATH）。

## 命令行

```bat
dsm list --all                 :: 全部会话（含已归档）
dsm upgrade                    :: 升级旧代际会话
dsm empty                      :: 空会话 → 回收站
dsm archive 3 5                :: 按序号归档；也可以写会话 ID 前缀或标题关键字
dsm unarchive "qq-bot"
dsm trash 2-4                  :: 移入回收站
dsm restore                    :: 选择恢复
dsm purge --older-than 30      :: 彻底删除 30 天前进回收站的条目
dsm archived                   :: 只列已归档会话，可挑着删或全删
dsm archived rm all --purge    :: 已归档的全部彻底删除（不加 --purge 则进回收站）
dsm loops                      :: 检测并清洗循环
dsm tail "qq-bot"              :: 修复烂尾会话：截掉末尾只有报错/重试的轮次，上下文过大时离线压缩
dsm undo                       :: 撤销上一次日志修改（循环清洗 / 烂尾修复）
dsm repair                     :: 修复被 DSH 隐藏的会话
```

通用选项：`--home <数据目录>`、`--dry-run`（只看不改）、`--yes`（不逐个确认）、`--force`（跳过「DSH 是否在运行」检测，不推荐）。

## 数据目录怎么找

DSH 装在哪、叫什么名字都行。按下面顺序找，前几步找到就直接用：

1. `--home`（安装目录或 data 目录都可以，也会被记住）
2. 环境变量 `DSH_HOME`
3. `dsm.exe` 所在目录往上逐层：放进安装目录里任意一层都能找到
4. 上次用过的目录（记在 `%APPDATA%\dsm\config.json`）
5. `~/.dsh`（DSH 官方默认位置，标准安装版和 npm 版都在这里）
6. 以上都没有时：开始菜单 / 桌面 / 任务栏里指向 DSH 的快捷方式、卸载注册表里的安装位置、用户和系统级的 `DSH_HOME`
7. 再没有：扫描每个盘往下 3 层（跳过 Windows、AppData 等系统目录，最多几秒）
8. 还没有：让你把安装目录拖进窗口

扫描时只认真正的 DSH 数据（`storages\workspace.json`，或 `sessions\<项目>\session-xxx\` 里有日志），别的程序的 `data` 文件夹不会被误认。菜单「14. 换一个数据目录」可以随时重新搜索或手动指定。

```bat
dsm.exe --home D:\dsh-desktop\data
```

## 修复烂尾会话（`dsm tail`）

典型症状：会话越聊越长，某次换了模型或上下文插件失效后，每次「重试」都报
`maximum context length` / `prompt is too large`，连 `/compact` 也失败（压缩请求本身就要带上全部历史）。

`dsm tail` 会列出最后十几轮的结局（完成 / 中止 / 出错）、回复条数和体量，并给出建议截断点（最后一轮模型确实产出过回复的轮次），然后：

1. **截尾：** 把建议点之后只有报错、重试、空中止的轮次整段截掉（日志尾部截断，seq 仍连续）。截掉的轮次里新开的子代理会话一并进回收站。
2. **离线压缩：** 截完后估算上下文仍超过约 25 万 token 时，不调用任何模型，用 DSH 自己的压缩事件（`compaction/start → compaction/summary → 检查点 user/message（surface replace）→ compaction/end`）把较早的轮次换成一条「摘录式」检查点：每轮的用户原话、助手最终回复、写过的文件。最近几轮（约 12 万 token）保留原文。完整日志一个字都不删，DSH 里照样能往上翻看历史。

两步都先备份原日志和投影缓存，`dsm undo` 可恢复。已在真实 DSH 0.2.1 上验证：修复后的会话能正常恢复，新一轮请求只带系统提示 + 检查点 + 保留轮次。

> 修完打开会话后，先在模型菜单确认选的是现在可用的模型（截尾会回到截断点时的模型选择）。

## 安全

- **DSH 必须完全退出。** DSH 的 JSONL 后端只允许一个写入者，账目（`workspace.json`）也由 DSH 在内存里持有。实测：DSH 运行时从外部改的归档，会在 DSH 下一次写账目时被**静默覆盖**。所以所有修改类操作都会先检测 DSH 进程，检测不到结果也按「在运行」处理（失败即关闭）。
- **日志内容只在三种操作里被改写：** 循环清洗、帧修复、烂尾修复（截尾只删末尾事件，压缩只追加事件）。三者都先把原文件备份到 `<数据目录>\.dsm\backups\<时间>\`，写后自检（事件数不变、能完整解码、帧布局合法）。
- **回收站不删任何东西：** 整个会话目录连同投影缓存搬到 `<数据目录>\.dsm\trash\<时间>\`，每次一个新批次，不覆盖旧条目。恢复时目标已存在就拒绝，绝不合并两份历史。
- **账目修改前备份：** 每次写 `workspace.json` 前在 `.dsm\backups\<时间>\` 留一份。
- 工作区目录永远从会话日志头读取，不从有损的项目目录名反推。投影缓存（`session_projcache`）是派生数据，只随会话搬动，不编辑。
- 升级用 DSH 自带的迁移器（便携版 `app\migrate-sessions-v4.mjs`，桌面版 `resources\dsh-build\migrate-sessions-v4.mjs`），以 `--jobs 1` 串行运行：并发迁移时父子会话会互相触发 `generation changed during verification`。没有迁移器时（标准安装版通常没有单独的迁移器）可以用 `--migrator <路径>` 指定，或者在 DSH 里逐个打开旧会话让 DSH 自己升级。

## DSH 格式细节

1. **`session.v4.jsonl.zstd` 是多帧文件：** 头部一帧，之后每次追加一帧。Node 的 `zlib.zstdDecompressSync` **只解第一帧**，直接用它读会只拿到头部一行。本工具逐帧解码。
2. **第一帧必须恰好是一行头部：** DSH 列会话时只解第一帧并校验，不合格就把会话当损坏、**不显示、不报错**。把整个日志压成单帧写回（很多第三方工具会这么做）就会让会话「消失」——`dsm repair` 能找回来。

## 开发与测试

```bash
npm test                         # 单元测试
node scripts/build-exe.mjs       # 打包 dist/dsm.exe（Node SEA，Linux/Windows 都能打 Windows 版）
node scripts/smoke-exe.mjs dist/dsm.exe   # 打包后冒烟测试，含「DSH 在跑就拒绝」
```

GitHub Actions 在 `windows-latest` 上跑单元测试、打包和冒烟测试，打 `v*` 标签时自动发布 `dsm-win-x64.zip`。

单元测试用合成的 DSH 布局覆盖全部操作。另外在 DSH `0.2.1-rc.2`（以及用 `0.1.2-rc.1`、`0.1.6-alpha.2`、`0.1.7-rc.2`、`0.2.0-rc.2` 生成的旧会话）上做了端到端验证：每步操作后重启 DSH，通过 DSH 自己的 `session/list` 核对会话、代际状态和空白标记，并对升级、清洗后的会话继续发消息。

## 相关项目

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy)：在手机、平板或另一台电脑上使用 DSH
- [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy)：DeepInfra Standard / Flex 按会话切换与自动回退
- [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue)：模型复读时从流内切断、剪掉循环并自动续跑

## 许可证

[MIT](LICENSE)
