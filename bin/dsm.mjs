#!/usr/bin/env node
/**
 * dsm —— DeepSeek Harness 独立会话管理器（离线，不是插件）。
 *
 *   dsm                       交互菜单（双击 dsm.cmd 也是这个）
 *   dsm list [--all]          列出会话（默认不含已归档）
 *   dsm upgrade               把旧代际会话升级到当前代际（调用 DSH 自带迁移器）
 *   dsm empty                 找出空会话并移入回收站
 *   dsm archive <会话...>     归档 / dsm unarchive <会话...> 取消归档 / dsm archived 列出已归档
 *   dsm trash <会话...>       移入回收站 / dsm restore [条目...] / dsm purge [--older-than 天]
 *   dsm loops [<会话>]        检测并截掉历史里已提交的循环 / dsm loops --undo 撤销
 *   dsm repair                修复因压缩帧布局不对而被 DSH 隐藏的会话
 *
 * <会话> 可以是列表序号、会话 ID（前缀即可）或标题关键字。
 * 通用选项：--home <数据目录>  --dry-run  --yes  --force（跳过 DSH 运行检测，不推荐）
 */
import { createInterface } from 'node:readline/promises'
import { copyFileSync } from 'node:fs'
import { scan, timestamp } from '../src/store.mjs'
import { findHomes, normalizeHome, rememberHome } from '../src/discover.mjs'
import { assertQuiescent, withLock } from '../src/guard.mjs'
import { IS_SEA } from '../src/runtime.mjs'
import {
  isEmptySession, trashSessions, listTrash, restoreFromTrash, purgeTrash, setArchived,
  findLoops, cleanLoops, repairFrames, listLogBackups, findInstall, targetVersion, needsUpgrade, runMigrator,
} from '../src/ops.mjs'

// ---------------- 环境 ----------------
{
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj < 22 || (maj === 22 && min < 15)) {
    console.error(`需要 Node 22.15+（内置 zstd），当前 ${process.versions.node}。可设置 DSM_NODE 指向更新的 node.exe。`)
    process.exit(1)
  }
}

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
const HELP = `dsm —— DeepSeek Harness 独立会话管理器（离线，不是插件）。

  dsm                       交互菜单（双击 dsm.cmd 也是这个）
  dsm list [--all]          列出会话（默认不含已归档）
  dsm upgrade               把旧代际会话升级到当前代际（调用 DSH 自带迁移器）
  dsm empty                 找出空会话并移入回收站
  dsm archive <会话...>     归档 / dsm unarchive <会话...> 取消归档 / dsm archived 列出已归档
  dsm trash <会话...>       移入回收站 / dsm restore [条目...] / dsm purge [--older-than 天]
  dsm loops [<会话>]        检测并截掉历史里已提交的循环 / dsm loops --undo 撤销
  dsm repair                修复因压缩帧布局不对而被 DSH 隐藏的会话

<会话> 可以是列表序号、会话 ID（前缀即可）或标题关键字。
通用选项：--home <数据目录>  --dry-run  --yes  --force（跳过 DSH 运行检测，不推荐）
 `

const VALUE_FLAGS = new Set(['--home', '--older-than', '--migrator'])
const flags = {}; const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUE_FLAGS.has(a)) flags[a.slice(2)] = argv[++i]
  else if (a.startsWith('--')) flags[a.slice(2)] = true
  else pos.push(a)
}
const DRY = Boolean(flags['dry-run']); const YES = Boolean(flags.yes); const FORCE = Boolean(flags.force)

let rl
let stdinClosed = false
const ask = async (q) => {
  if (stdinClosed) return ''
  if (!rl) { rl = createInterface({ input: process.stdin, output: process.stdout }); rl.on('close', () => { stdinClosed = true }) }
  return new Promise((res) => {
    const onClose = () => res('')
    rl.once('close', onClose)
    rl.question(q).then((a) => { rl.off('close', onClose); res(a.trim()) }, () => res(''))
  })
}
const confirm = async (q) => YES || (await ask(`${q} [y/N] `)).toLowerCase() === 'y'
// 双击 dsm.exe 打开的窗口，结束时停一下，不然报错一闪就没了（dsm.cmd 自己会 pause）
const PAUSE_AT_EXIT = IS_SEA && argv.length === 0 && process.stdin.isTTY
const done = async (code = 0) => {
  if (PAUSE_AT_EXIT) await ask('\n按回车键关闭…')
  rl?.close(); process.exit(code)
}

// ---------------- 展示 ----------------
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '?')
const fmtSize = (b) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : b >= 1024 ? `${(b / 1024).toFixed(0)}KB` : `${b}B`)
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
function tags(s, extra = []) {
  const t = []
  if (s.broken) t.push('损坏')
  if (s.badFrame) t.push('被DSH隐藏')
  if (s.archived) t.push('归档')
  if (s.pinned) t.push('置顶')
  if (s.header?.origin === 'subagent') t.push('子')
  if (s.latest && s.latest.version < 4) t.push(`v${s.latest.version}`)
  return [...t, ...extra].join(',')
}
function printRows(list, extra = () => []) {
  list.forEach((s, i) => {
    const tg = tags(s, extra(s))
    console.log(`${String(i + 1).padStart(3)}. ${fmtTime(s.mtime)}  ${tg ? `[${tg}] ` : ''}${cut(s.title ?? '(无标题)', 40)}  —  ${cut(s.header?.cwd ?? s.project, 40)}  ${fmtSize(s.bytes ?? 0)}`)
  })
}

// ---------------- 选择 ----------------
function resolveSel(list, sels) {
  const out = []
  for (const sel of sels) {
    if (/^\d+$/.test(sel) && Number(sel) >= 1 && Number(sel) <= list.length) { out.push(list[Number(sel) - 1]); continue }
    if (/^\d+-\d+$/.test(sel)) {
      const [a, b] = sel.split('-').map(Number)
      for (let i = a; i <= b && i <= list.length; i++) out.push(list[i - 1])
      continue
    }
    const byId = list.filter((s) => s.id.startsWith(sel) || s.id.startsWith(`session-${sel}`))
    const hit = byId.length ? byId : list.filter((s) => (s.title ?? '').includes(sel))
    if (hit.length !== 1) throw new Error(hit.length ? `「${sel}」匹配到 ${hit.length} 个会话，请写得更具体。` : `找不到会话「${sel}」。`)
    out.push(hit[0])
  }
  return [...new Set(out)]
}
async function pickMany(list, prompt) {
  const a = await ask(`${prompt}（序号，可写 1 3 5 或 2-6，a=全部，回车=取消）：`)
  if (!a) return []
  if (a.toLowerCase() === 'a') return list
  return resolveSel(list, a.split(/[\s,，]+/).filter(Boolean))
}

// ---------------- 数据目录 ----------------
async function askHomeByHand() {
  for (;;) {
    const a = await ask('\n把 DSH 的安装目录或 data 目录拖进这个窗口（或粘贴路径），回车确认；直接回车=退出：')
    if (!a) return undefined
    const h = normalizeHome(a)
    if (h) return h
    console.log(`「${a}」里没找到 DSH 数据（应有 sessions 文件夹或 storages\\workspace.json），再试一次。`)
  }
}

async function chooseHome({ forcePick = false, current } = {}) {
  if (flags.home && !forcePick) {
    const h = normalizeHome(flags.home)
    if (!h) throw new Error(`「${flags.home}」不像 DSH 数据目录（应有 sessions 文件夹或 storages\\workspace.json）。安装目录或 data 目录都可以。`)
    rememberHome(h); return h
  }
  const interactive = process.stdin.isTTY && !YES
  let deep = forcePick
  for (;;) {
    if (deep) console.log('正在查找快捷方式、注册表并扫描各盘（最多几秒）…')
    const homes = findHomes(undefined, { deep })
    if (!homes.length) {
      if (!deep) { deep = true; continue }
      if (!interactive) throw new Error('没找到 DSH 数据目录。用 --home 指定安装目录或 data 目录，例如：--home "D:\\Apps\\DSH"')
      console.log('没自动找到 DSH 数据目录。')
      const h = await askHomeByHand()
      if (!h) return current ?? done()
      rememberHome(h); return h
    }
    if (homes.length === 1 && (!interactive || pos.length || !forcePick)) { rememberHome(homes[0].path); return homes[0].path }
    if (!interactive) throw new Error(`找到多个 DSH 数据目录，请用 --home 指定：\n  ${homes.map((h) => h.path).join('\n  ')}`)
    console.log(homes.length === 1 ? '找到 DSH 数据目录：' : '找到多个 DSH 数据目录：')
    homes.forEach((h, i) => console.log(`${String(i + 1).padStart(3)}. ${h.path}  （${h.via}）`))
    console.log(`${deep ? '' : '  s. 不在这里，搜索其它位置\n'}  m. 手动指定（拖入目录）`)
    const a = (await ask('用哪个？（回车=第 1 个）')).toLowerCase()
    if (a === 's' && !deep) { deep = true; continue }
    if (a === 'm') { const h = await askHomeByHand(); if (!h) continue; rememberHome(h); return h }
    const pick = homes[(Number(a) || 1) - 1] ?? homes[0]
    rememberHome(pick.path); return pick.path
  }
}

/** 改动类操作统一入口：先确认 DSH 已退出，再拿锁。 */
async function mutate(home, fn) {
  if (DRY) { console.log('（--dry-run：不做任何修改）'); return }
  assertQuiescent(home, { force: FORCE })
  return withLock(home, fn)
}

// ================= 命令 =================
async function cmdList(home) {
  const { sessions } = scan(home)
  const list = flags.all ? sessions : sessions.filter((s) => !s.archived)
  if (!list.length) return console.log('没有会话。')
  printRows(list)
  const arch = sessions.filter((s) => s.archived).length
  console.log(`\n共 ${list.length} 个${!flags.all && arch ? `（另有 ${arch} 个已归档，加 --all 查看）` : ''}。`)
}

async function cmdUpgrade(home) {
  const install = findInstall(home, flags.migrator)
  const target = targetVersion(install)
  const { sessions } = scan(home)
  const todo = needsUpgrade(sessions, target)
  if (!todo.length) return console.log(`所有会话都已是 v${target} 或更新，无需升级。`)
  console.log(`${todo.length} 个会话还停在旧代际（目标 v${target}）：`)
  printRows(todo)
  if (!install) {
    throw new Error('没找到 DSH 自带的迁移器（便携版 app\\migrate-sessions-v4.mjs，桌面版 resources\\dsh-build\\migrate-sessions-v4.mjs）。'
      + '\n可用 --migrator <路径> 指定；官方原版也可以逐个在 DSH 里打开（resume）旧会话，DSH 会自动升级。')
  }
  console.log(`\n迁移器：${install.migrator}（${install.kind}）\n迁移只会在旁边新增一份 v${target} 日志，旧文件原样保留，可回滚。`)
  if (!(await confirm('开始升级？'))) return
  await mutate(home, () => {
    const passes = runMigrator(home, install, { remaining: () => needsUpgrade(scan(home).sessions, target).length })
    passes.forEach((p, i) => console.log(`第 ${i + 1} 轮：${p.summary ?? `退出码 ${p.status}${p.error ? `（${p.error}）` : ''}`}`))
    const left = needsUpgrade(scan(home).sessions, target)
    if (!left.length) return console.log('全部升级完成。')
    console.log(`\n仍有 ${left.length} 个没能升级（旧文件原样保留，不影响其它会话）：`)
    const fails = passes[passes.length - 1].failures
    left.forEach((s, i) => {
      const f = fails.find((x) => x.path.startsWith(s.dir))
      console.log(`${String(i + 1).padStart(3)}. ${cut(s.title ?? s.id, 40)}  —  ${f ? cut(f.message.replace(/\s*\(raw log:.*$/, ''), 160) : '原因见迁移器输出'}`)
    })
  })
}

async function cmdEmpty(home) {
  const { sessions } = scan(home, { withText: true })
  const empties = sessions.filter(isEmptySession)
  if (!empties.length) return console.log('没有空会话。')
  console.log(`找到 ${empties.length} 个空会话（新建后没发过消息）：`)
  printRows(empties)
  const pick = pos.length ? resolveSel(empties, pos) : YES ? empties : await pickMany(empties, '\n移入回收站哪些')
  if (!pick.length) return
  if (!(await confirm(`把 ${pick.length} 个空会话移入回收站？`))) return
  await mutate(home, () => {
    const r = trashSessions(home, pick, { reason: 'empty' })
    console.log(`已移入回收站：${r.items.length} 个。恢复：dsm restore`)
  })
}

async function cmdArchive(home, archived) {
  const { sessions } = scan(home)
  const pool = sessions.filter((s) => s.archived !== archived)
  let pick
  if (pos.length) pick = resolveSel(pool, pos)
  else {
    if (!pool.length) return console.log(archived ? '没有可归档的会话。' : '没有已归档的会话。')
    printRows(pool)
    pick = await pickMany(pool, archived ? '\n归档哪些' : '\n取消归档哪些')
  }
  if (!pick.length) return
  await mutate(home, () => {
    const n = setArchived(home, pick.map((s) => s.id), archived)
    console.log(`${archived ? '已归档' : '已取消归档'} ${n} 个。下次启动 DSH 生效。`)
  })
}

async function cmdArchived(home) {
  const list = scan(home).sessions.filter((s) => s.archived)
  if (!list.length) return console.log('没有已归档的会话。')
  printRows(list)
}

async function cmdTrash(home) {
  const { sessions } = scan(home)
  let pick
  if (pos.length) pick = resolveSel(sessions, pos)
  else { printRows(sessions); pick = await pickMany(sessions, '\n移入回收站哪些') }
  if (!pick.length) return
  console.log(pick.map((s) => `  - ${s.title ?? s.id}`).join('\n'))
  if (!(await confirm(`把这 ${pick.length} 个会话移入回收站？（可恢复）`))) return
  await mutate(home, () => {
    const r = trashSessions(home, pick)
    console.log(`已移入回收站：${r.items.length} 个。恢复：dsm restore`)
  })
}

function printTrash(items) {
  items.forEach((t, i) => console.log(`${String(i + 1).padStart(3)}. ${fmtTime(Date.parse(t.deletedAt))}  ${t.reason === 'empty' ? '[空] ' : ''}${cut(t.title ?? t.id, 40)}  —  ${cut(t.cwd, 40)}  ${fmtSize(t.bytes ?? 0)}`))
}

async function cmdRestore(home) {
  const items = listTrash(home)
  if (!items.length) return console.log('回收站是空的。')
  let pick
  if (pos.length) pick = pos.map((p) => items[Number(p) - 1]).filter(Boolean)
  else { printTrash(items); pick = await pickMany(items, '\n恢复哪些') }
  if (!pick.length) return
  await mutate(home, () => {
    const r = restoreFromTrash(home, pick)
    console.log(`已恢复 ${r.length} 个。`)
  })
}

async function cmdPurge(home) {
  let items = listTrash(home)
  if (flags['older-than']) {
    const ms = Number(flags['older-than']) * 86400000
    items = items.filter((t) => Date.now() - Date.parse(t.deletedAt) > ms)
  }
  if (!items.length) return console.log('没有要彻底删除的条目。')
  printTrash(items)
  const pick = pos.length ? pos.map((p) => items[Number(p) - 1]).filter(Boolean)
    : flags['older-than'] || YES ? items : await pickMany(items, '\n彻底删除哪些')
  if (!pick.length) return
  if (!(await confirm(`彻底删除 ${pick.length} 个条目？此操作不可恢复。`))) return
  await mutate(home, () => console.log(`已彻底删除 ${purgeTrash(home, pick)} 个。`))
}

async function cmdLoops(home) {
  if (flags.undo) {
    const backups = listLogBackups(home)
    if (!backups.length) return console.log('没有循环清洗的备份。')
    backups.forEach((b, i) => console.log(`${String(i + 1).padStart(3)}. ${b.stamp}  ${b.target}`))
    const a = YES ? '1' : await ask('恢复哪个？（回车=最新）')
    const b = backups[(Number(a) || 1) - 1]
    if (!b || !(await confirm(`用备份覆盖 ${b.target}？`))) return
    return mutate(home, () => { copyFileSync(b.file, b.target); console.log('已恢复。') })
  }
  const { sessions } = scan(home, { withText: true })
  const withLoops = []
  for (const s of sessions) {
    if (s.broken || !s.text) continue
    const n = findLoops(s.text).count
    if (n) withLoops.push({ ...s, loops: n })
    delete s.text
  }
  if (!withLoops.length) return console.log('没有检测到循环。')
  printRows(withLoops, (s) => [`循环${s.loops}`])
  let pick
  if (pos.length) pick = resolveSel(withLoops, pos)
  else pick = YES ? withLoops : await pickMany(withLoops, '\n清洗哪些')
  if (!pick.length) return
  const old = pick.filter((s) => s.latest.version !== 4)
  if (old.length) throw new Error(`有 ${old.length} 个会话不是 v4，请先运行「升级旧会话」。`)
  if (!(await confirm(`截掉这 ${pick.length} 个会话里的循环？（自动备份，可 dsm loops --undo）`))) return
  await mutate(home, () => {
    const stamp = timestamp()
    for (const s of pick) {
      const r = cleanLoops(home, s, { stamp })
      console.log(`  ✓ ${cut(s.title ?? s.id, 40)}：截掉 ${r.blocks} 段，约 ${r.removed} 字`)
    }
  })
}

async function cmdRepair(home) {
  const bad = scan(home).sessions.filter((s) => s.badFrame)
  if (!bad.length) return console.log('没有需要修复的会话。')
  console.log(`${bad.length} 个会话的压缩帧布局不合 DSH 要求，DSH 会把它们当损坏、不在列表里显示：`)
  printRows(bad)
  if (!(await confirm('按 DSH 的格式重写（内容不变，自动备份）？'))) return
  await mutate(home, () => {
    const stamp = timestamp()
    for (const s of bad) { repairFrames(home, s, { stamp }); console.log(`  ✓ ${cut(s.title ?? s.id, 50)}`) }
  })
}

// ---------------- 交互菜单 ----------------
async function menu(home) {
  for (;;) {
    console.log(`\nDSH 会话管理器 —— 数据目录：${home}`)
    console.log('\n 1. 列出会话\n 2. 升级旧会话\n 3. 清理空会话\n 4. 归档会话\n 5. 取消归档\n 6. 移入回收站\n 7. 从回收站恢复\n 8. 彻底清空回收站\n 9. 清洗循环\n10. 撤销循环清洗\n11. 修复被 DSH 隐藏的会话\n12. 换一个数据目录（搜索 / 手动指定）\n 0. 退出')
    const a = await ask('选：')
    try {
      pos.length = 0; delete flags.undo
      switch (a) {
        case '1': flags.all = true; await cmdList(home); break
        case '2': await cmdUpgrade(home); break
        case '3': await cmdEmpty(home); break
        case '4': await cmdArchive(home, true); break
        case '5': await cmdArchive(home, false); break
        case '6': await cmdTrash(home); break
        case '7': await cmdRestore(home); break
        case '8': await cmdPurge(home); break
        case '9': await cmdLoops(home); break
        case '10': flags.undo = true; await cmdLoops(home); break
        case '11': await cmdRepair(home); break
        case '12': home = await chooseHome({ forcePick: true, current: home }); break
        case '0': case '': return
        default: console.log('没有这个选项。')
      }
    } catch (e) { console.error(`\n✗ ${e.message}`) }
  }
}

// ---------------- 入口 ----------------
const COMMANDS = {
  list: cmdList, upgrade: cmdUpgrade, empty: cmdEmpty, archived: cmdArchived,
  archive: (h) => cmdArchive(h, true), unarchive: (h) => cmdArchive(h, false),
  trash: cmdTrash, restore: cmdRestore, purge: cmdPurge, loops: cmdLoops, repair: cmdRepair,
}
async function main() {
  try {
    if (flags.help || pos[0] === 'help') {
      console.log(HELP)
      return done()
    }
    const home = await chooseHome()
    const name = pos.shift()
    if (!name) await menu(home)
    else if (COMMANDS[name]) await COMMANDS[name](home)
    else throw new Error(`未知命令：${name}。dsm --help 查看用法。`)
    await done()
  } catch (e) {
    console.error(`✗ ${e.message}`)
    await done(1)
  }
}
main()
