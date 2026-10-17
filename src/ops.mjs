/**
 * 各项操作。约定：
 *   - 纯判断（isEmpty / findLoops）不碰磁盘；
 *   - 改动类操作由 CLI 先过 guard（DSH 已退出 + dsm 锁），这里只管把事做对、留后路。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, rmSync, statSync, cpSync, copyFileSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  DSM_DIR, events, parseLines, projcachePaths, readLog, readWorkspace, safeDir, timestamp, writeLog, writeWorkspace,
} from './store.mjs'
import { detectInText } from './detector.js'
import { childNode } from './runtime.mjs'

// =====================================================================
// 空会话
// =====================================================================
/**
 * 会话创建时一次性写入的「种子」事件。空会话 = 头部之外只有这些。
 * 任何不认识的事件类型都按「有内容」处理：宁可漏判，不可错删。
 */
export const SEED_EVENT_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'subagent/model-selection-policy', 'agent-preset/selected', 'session/end-seed', 'model/selection',
])
/** 解码大小上限：真有对话的会话远比这大，超过就不解码直接判非空。 */
export const EMPTY_PROBE_LIMIT = 64 * 1024

export function isEmptySession(session) {
  if (session.broken || !session.latest) return false
  if (statSync(session.latest.path).size > EMPTY_PROBE_LIMIT) return false
  let evs
  try { evs = events(session) } catch { return false }
  if (evs.length === 0 || evs[0]?.type !== 'session') return false
  return evs.every((e) => SEED_EVENT_TYPES.has(e?.type))
}

// =====================================================================
// 回收站（离线）
// =====================================================================
export const trashRoot = (home) => join(home, DSM_DIR, 'trash')

/**
 * 把一组会话移入回收站：会话目录整体搬走（不删、不改内容），账目里摘掉 id，
 * 投影缓存一并搬走。每次删除是一个不覆盖旧条目的新批次。
 */
export function trashSessions(home, sessions, { stamp = timestamp(), reason = 'manual' } = {}) {
  const ws = readWorkspace(home)
  const batch = join(trashRoot(home), stamp)
  mkdirSync(batch, { recursive: true })
  const ids = new Set(sessions.map((s) => s.id))
  const done = []
  for (const s of sessions) {
    const entry = join(batch, `${s.project}__${basename(s.dir)}`)
    if (existsSync(entry)) throw new Error(`回收站条目已存在：${entry}`)
    mkdirSync(entry, { recursive: true })
    const slot = slotOf(ws, s.id)
    const manifest = {
      id: s.id, project: s.project, dirName: basename(s.dir), cwd: s.header?.cwd, title: s.title,
      archived: Boolean(ws?.global?.archivedSessionIds?.includes(s.id)),
      pinned: Boolean(ws?.global?.pinnedSessionIds?.includes(s.id)),
      workspace: slot, reason, deletedAt: new Date().toISOString(), bytes: s.bytes,
    }
    renameSync(s.dir, join(entry, 'session'))
    for (const p of projcachePaths(home, s.id)) {
      if (existsSync(p)) { mkdirSync(join(entry, 'projcache'), { recursive: true }); renameSync(p, join(entry, 'projcache', basename(p))) }
    }
    writeFileSync(join(entry, 'manifest.json'), JSON.stringify(manifest, null, 2))
    done.push(manifest)
  }
  if (ws) {
    for (const rec of Object.values(ws.tables?.workspaces ?? {})) {
      if (Array.isArray(rec.sessionIds)) rec.sessionIds = rec.sessionIds.filter((id) => !ids.has(id))
    }
    if (ws.global) {
      ws.global.archivedSessionIds = (ws.global.archivedSessionIds ?? []).filter((id) => !ids.has(id))
      ws.global.pinnedSessionIds = (ws.global.pinnedSessionIds ?? []).filter((id) => !ids.has(id))
    }
    writeWorkspace(home, ws, stamp)
  }
  return { batch, items: done }
}

function slotOf(ws, id) {
  for (const [wid, rec] of Object.entries(ws?.tables?.workspaces ?? {})) {
    const i = (rec.sessionIds ?? []).indexOf(id)
    if (i >= 0) return { id: wid, index: i, path: rec.path }
  }
  return undefined
}

/** 列出回收站条目（新的在前）。 */
export function listTrash(home) {
  const out = []
  for (const b of safeDir(trashRoot(home))) {
    for (const e of safeDir(join(trashRoot(home), b))) {
      const entry = join(trashRoot(home), b, e)
      try {
        const m = JSON.parse(readFileSync(join(entry, 'manifest.json'), 'utf8'))
        out.push({ ...m, batch: b, entry })
      } catch { /* 半成品条目跳过 */ }
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** 从回收站恢复。目标已存在（同 id 已在库里）就拒绝，绝不合并历史。 */
export function restoreFromTrash(home, items, { stamp = timestamp() } = {}) {
  const ws = readWorkspace(home)
  const restored = []
  // 按原槽位从前往后插回，多个会话一起恢复时顺序才对
  const ordered = [...items].sort((a, b) => (a.workspace?.index ?? Infinity) - (b.workspace?.index ?? Infinity))
  for (const it of ordered) {
    const target = join(home, 'sessions', it.project, it.dirName)
    if (existsSync(target)) throw new Error(`恢复冲突：${target} 已存在（同一会话不能有两份历史）。`)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(join(it.entry, 'session'), target)
    for (const f of safeDir(join(it.entry, 'projcache'))) {
      const dest = projcachePaths(home, it.id).find((p) => basename(p) === f)
      if (dest && !existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true }); renameSync(join(it.entry, 'projcache', f), dest) }
    }
    if (ws) {
      const rec = it.workspace && ws.tables?.workspaces?.[it.workspace.id]
      if (rec && !rec.sessionIds.includes(it.id)) rec.sessionIds.splice(Math.min(it.workspace.index, rec.sessionIds.length), 0, it.id)
      if (ws.global) {
        if (it.archived && !ws.global.archivedSessionIds.includes(it.id)) ws.global.archivedSessionIds.push(it.id)
        if (it.pinned && !ws.global.pinnedSessionIds.includes(it.id)) ws.global.pinnedSessionIds.unshift(it.id)
      }
    }
    rmSync(it.entry, { recursive: true, force: true })
    restored.push(it)
  }
  if (ws) writeWorkspace(home, ws, stamp)
  pruneEmptyBatches(home)
  return restored
}

/** 彻底删除回收站条目。`olderThanDays` 给定时只删超过天数的。 */
export function purgeTrash(home, items) {
  for (const it of items) rmSync(it.entry, { recursive: true, force: true })
  pruneEmptyBatches(home)
  return items.length
}
function pruneEmptyBatches(home) {
  for (const b of safeDir(trashRoot(home))) {
    const p = join(trashRoot(home), b)
    if (safeDir(p).length === 0) rmSync(p, { recursive: true, force: true })
  }
}

// =====================================================================
// 归档（复用 DSH 自己的 archivedSessionIds；日志与槽位都不动）
// =====================================================================
export function setArchived(home, ids, archived, { stamp = timestamp() } = {}) {
  const ws = readWorkspace(home)
  if (!ws?.global) throw new Error('没有 workspace.json，DSH 还没初始化过这个数据目录。')
  const set = new Set(ws.global.archivedSessionIds ?? [])
  let changed = 0
  for (const id of ids) {
    if (archived && !set.has(id)) { set.add(id); changed++ }
    if (!archived && set.delete(id)) changed++
  }
  if (changed === 0) return 0
  // 保持 DSH 的顺序语义：新归档追加到末尾；归档同时取消置顶（与 registry.archiveSession 一致）
  const order = (ws.global.archivedSessionIds ?? []).filter((id) => set.has(id))
  for (const id of ids) if (set.has(id) && !order.includes(id)) order.push(id)
  ws.global.archivedSessionIds = order
  if (archived) ws.global.pinnedSessionIds = (ws.global.pinnedSessionIds ?? []).filter((id) => !set.has(id))
  writeWorkspace(home, ws, stamp)
  return changed
}

// =====================================================================
// 修复帧布局：第一帧不是「恰好一行头部」时 DSH 会把会话当损坏、从列表里静默隐藏
// （常见于用单帧压缩重写过日志的第三方工具，包括 dsh-loop-rescue 早期的 clean-session）
// =====================================================================
export function repairFrames(home, session, { stamp = timestamp() } = {}) {
  const text = readLog(session.latest.path)
  const backup = join(home, DSM_DIR, 'backups', stamp, 'sessions', session.project, basename(session.dir), session.latest.file)
  mkdirSync(dirname(backup), { recursive: true })
  copyFileSync(session.latest.path, backup)
  writeLog(session.latest.path, text)
  if (readLog(session.latest.path) !== text) throw new Error('自检失败：重写后内容不一致。')
  return { backup }
}

// =====================================================================
// 循环清洗
// =====================================================================
/** 找出会话里命中的循环块：[{line, blocks:[{idx, cut, removed}]}]。 */
export function findLoops(text) {
  const lines = text.split('\n')
  const hits = []
  lines.forEach((line, li) => {
    if (!line.includes('"assistant/message"')) return
    let ev
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type !== 'assistant/message') return
    const blocks = []
    ;(ev.data?.message?.content ?? []).forEach((b, idx) => {
      if (b.type !== 'text' && b.type !== 'reasoning') return
      const d = detectInText(b.type, b.text ?? '')
      if (d) blocks.push({ idx, cut: d.cut, removed: (b.text ?? '').length - d.cut })
    })
    if (blocks.length) hits.push({ line: li, blocks })
  })
  return { lines, hits, count: hits.reduce((s, h) => s + h.blocks.length, 0) }
}

/** 截断一条 assistant/message：正文、data.stream、replayState 三处一致。 */
export function trimEvent(ev, blocks) {
  const content = ev.data.message.content
  const kept = new Map()
  for (const { idx, cut } of blocks) {
    content[idx].text = content[idx].text.slice(0, cut).replace(/\s+$/, '')
    kept.set(idx, content[idx].text)
  }
  if (Array.isArray(ev.data.stream)) {
    // content 下标与流里 block-start 的出现顺序一一对应
    const order = ev.data.stream.filter((r) => r.type === 'chunk' && r.chunk?.type === 'block-start').map((r) => r.chunk.index)
    const byStream = new Map()
    for (const [ci, t] of kept) if (order[ci] !== undefined) byStream.set(order[ci], t)
    const used = new Map()
    ev.data.stream = ev.data.stream.map((r) => {
      if ((r.type === 'text-chunks' || r.type === 'reasoning-chunks') && byStream.has(r.index)) {
        const want = byStream.get(r.index)
        let n = used.get(r.index) ?? 0
        const texts = []; const dt = []
        for (let i = 0; i < r.texts.length && n < want.length; i++) {
          const piece = r.texts[i].slice(0, want.length - n)
          texts.push(piece); n += piece.length
          if (i > 0) dt.push(r.dt[i - 1])
        }
        used.set(r.index, n)
        return texts.length ? { ...r, texts, dt } : null
      }
      if (r.type === 'chunk' && r.chunk?.type === 'block-end' && byStream.has(r.chunk.index)) {
        return { ...r, chunk: { ...r.chunk, block: { ...r.chunk.block, text: byStream.get(r.chunk.index) } } }
      }
      return r
    }).filter(Boolean)
  }
  const src = ev.data.message.source
  if (src && src.replayState !== undefined) {
    const { replayState, ...rest } = src
    ev.data.message.source = rest
  }
  return ev
}

/**
 * 清洗一个会话（只支持最新代际为 v4）。先把原文件备份进 .dsm/backups，
 * 再原子写回；写前自检事件数不变。返回 { removed, blocks, backup }。
 */
export function cleanLoops(home, session, { stamp = timestamp() } = {}) {
  if (session.latest.version !== 4) throw new Error(`只支持 v4 会话（这个是 v${session.latest.version}），请先升级。`)
  const text = readLog(session.latest.path)
  const { lines, hits, count } = findLoops(text)
  if (count === 0) return { removed: 0, blocks: 0 }
  const removed = hits.reduce((s, h) => s + h.blocks.reduce((t, b) => t + b.removed, 0), 0)
  const backup = join(home, DSM_DIR, 'backups', stamp, 'sessions', session.project, basename(session.dir), session.latest.file)
  mkdirSync(dirname(backup), { recursive: true })
  copyFileSync(session.latest.path, backup)
  const out = lines.slice()
  for (const h of hits) out[h.line] = JSON.stringify(trimEvent(JSON.parse(out[h.line]), h.blocks))
  const next = out.join('\n')
  if (parseLines(next).length !== parseLines(text).length) throw new Error('自检失败：事件数变化，未写入。')
  writeLog(session.latest.path, next)
  if (findLoops(readLog(session.latest.path)).count !== 0) throw new Error('自检失败：写回后仍检测到循环。')
  return { removed, blocks: count, backup }
}

/** 列出 .dsm/backups 里的会话日志备份（循环清洗用），新的在前。 */
export function listLogBackups(home) {
  const root = join(home, DSM_DIR, 'backups')
  const out = []
  for (const stamp of safeDir(root)) {
    const sroot = join(root, stamp, 'sessions')
    for (const project of safeDir(sroot)) for (const dir of safeDir(join(sroot, project))) {
      for (const f of safeDir(join(sroot, project, dir))) {
        out.push({ stamp, file: join(sroot, project, dir, f), target: join(home, 'sessions', project, dir, f) })
      }
    }
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp))
}

// =====================================================================
// 旧代际升级（交给 DSH 自己的迁移器，与 DSH-build 启动器同一调用方式）
// =====================================================================
/** 目标代际：从安装里的 @deepseek-ai/dsh-session 读 SESSION_FORMAT_VERSION。 */
export function findInstall(home, explicitMigrator) {
  const base = basename(home).toLowerCase() === 'data' ? dirname(home) : undefined
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const dshNodes = base ? [join(base, 'node', exe), join(base, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', exe)] : []
  const cands = []
  if (explicitMigrator) cands.push({ kind: 'custom', migrator: explicitMigrator, node: childNode(dshNodes), env: {} })
  if (base) {
    cands.push({ kind: 'portable', migrator: join(base, 'app', 'migrate-sessions-v4.mjs'), node: childNode([dshNodes[0]]), env: {}, modules: join(base, 'app', 'node_modules') })
    const electron = join(base, 'DeepSeek Harness.exe')
    cands.push({ kind: 'desktop', migrator: join(base, 'resources', 'dsh-build', 'migrate-sessions-v4.mjs'), node: electron, env: { ELECTRON_RUN_AS_NODE: '1' } })
  }
  return cands.find((c) => existsSync(c.migrator) && c.node && existsSync(c.node))
}

export function targetVersion(install) {
  const roots = [install?.modules, join(dirname(install?.migrator ?? '.'), 'node_modules')].filter(Boolean)
  for (const r of roots) {
    for (const f of ['lib/index.js', 'dist/index.js', 'lib/index.mjs']) {
      try {
        const m = /SESSION_FORMAT_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(r, '@deepseek-ai', 'dsh-session', f), 'utf8'))
        if (m) return Number(m[1])
      } catch { /* 下一个 */ }
    }
  }
  return 4
}

/** 需要升级的会话：没有任何 ≥ 目标代际的日志。 */
export function needsUpgrade(sessions, target) {
  return sessions.filter((s) => !s.broken && s.gens.length && !s.gens.some((g) => g.version >= target))
}

/**
 * 运行迁移器。迁移只新增一份当前代际文件，旧代际原样保留。
 * 固定 --jobs 1：实测并发迁移时父子会话会互相触发「generation changed during verification」，
 * 串行一次就能收敛。仍有进展但没迁完时再跑一轮（最多 3 轮）。
 */
export function runMigrator(home, install, { remaining } = {}) {
  const passes = []
  let before = remaining?.() ?? Infinity
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(install.node, [install.migrator, '--sessions-dir', join(home, 'sessions'), '--jobs', '1'], {
      env: { ...process.env, ...install.env, DSH_HOME: home }, encoding: 'utf8', timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 256 << 20,
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    passes.push({
      status: r.status, error: r.error ? String(r.error) : undefined,
      summary: /Summary:[^\n]*/.exec(out)?.[0],
      failures: [...out.matchAll(/^ERROR "([^"]+)": ([^\n]*)/gm)].map((m) => ({ path: m[1], message: m[2] })),
    })
    const after = remaining?.() ?? 0
    if (r.status === 0 || after === 0 || after >= before) break
    before = after
  }
  return passes
}
