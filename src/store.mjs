/**
 * 会话库的只读视图：找数据目录、扫描会话、读写工作区账目。
 *
 * 布局（DSH 0.2.x）：
 *   <home>/sessions/<项目键>/<会话目录>/session[.N][.vM].jsonl[.zstd]   会话日志（权威）
 *   <home>/storages/workspace.json                                        工作区账目（归档 / 置顶 / 槽位）
 *   <home>/storages/session_projcache/sessions/<id>.json                  投影缓存（派生，可自愈）
 * 项目键是有损编码，永远从日志头读 cwd，不反解目录名。
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

/** 与 DSH-build 启动器同一口径：session[.N][.vM].jsonl[.zstd]，无 vM 视为 0。 */
export const GENERATION = /^session(\.[0-9]+)?(?:\.v([0-9]+))?\.jsonl(\.zstd)?$/i
export const DSM_DIR = '.dsm'

// ---------- 读写日志 ----------
export function decode(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('需要 Node 22.15+（内置 zstd）')
    // 注意：zlib.zstdDecompressSync 只解第一帧，DSH 的日志是「头部一帧 + 每次追加一帧」，必须逐帧解
    const parts = []
    let o = 0
    while (o < buf.length) {
      const magic = buf.readUInt32LE(o)
      if ((magic & 0xfffffff0) === 0x184d2a50) { o += 8 + buf.readUInt32LE(o + 4); continue } // skippable frame
      const end = frameEnd(buf, o)
      if (end === undefined) throw new Error(`zstd 帧不完整（偏移 ${o}）`)
      parts.push(zlib.zstdDecompressSync(buf.subarray(o, end)))
      o = end
    }
    return Buffer.concat(parts).toString('utf8')
  }
  return buf.toString('utf8')
}
export function readLog(path) { return decode(readFileSync(path)) }
/**
 * 按 DSH 的物理格式压缩：第一帧必须「恰好一行头部」（DSH 读列表时只解第一帧并校验，
 * 不合格会把整个会话当损坏静默隐藏），其余事件放后续帧；每帧带 checksum。
 */
export function encodeLog(text, compressed) {
  if (!compressed) return Buffer.from(text, 'utf8')
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  const nl = text.indexOf('\n')
  const head = nl < 0 ? `${text}\n` : text.slice(0, nl + 1)
  const rest = nl < 0 ? '' : text.slice(nl + 1)
  const frames = [zlib.zstdCompressSync(Buffer.from(head, 'utf8'), opts)]
  if (rest.length) frames.push(zlib.zstdCompressSync(Buffer.from(rest, 'utf8'), opts))
  return Buffer.concat(frames)
}
/** 第一帧是否恰好一行头部（DSH 的 assertZstdHeaderFrame 同一口径）。 */
export function headerFrameOk(buf) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0xfd2fb528) return true
  const first = firstFrame(buf)
  if (!first) return false
  const plain = zlib.zstdDecompressSync(first)
  return plain.length > 0 && plain.indexOf(10) === plain.length - 1
}
/** 按 zstd 帧格式（RFC 8878）切出第一帧，不解压后续内容。 */
export function frameEnd(buf, start = 0) {
  if (buf.readUInt32LE(start) !== 0xfd2fb528) return undefined
  const fhd = buf[start + 4]
  const fcsFlag = fhd >> 6; const single = (fhd >> 5) & 1; const checksum = (fhd >> 2) & 1; const dictFlag = fhd & 3
  let o = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag]
  for (;;) {
    if (o + 3 > buf.length) return undefined
    const h = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
    const last = h & 1; const type = (h >> 1) & 3; const size = h >>> 3
    o += 3 + (type === 1 ? 1 : size)
    if (last) break
  }
  o += checksum ? 4 : 0
  return o <= buf.length ? o : undefined
}
function firstFrame(buf) {
  const end = frameEnd(buf, 0)
  return end === undefined ? undefined : buf.subarray(0, end)
}
export function writeLog(path, text) {
  const body = encodeLog(text, /\.zstd$/i.test(path))
  const tmp = `${path}.dsm-tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}
export function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 截断的尾行忽略 */ }
  }
  return out
}

// ---------- 找数据目录 ----------
export function looksLikeHome(dir) {
  return existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'storages', 'workspace.json'))
}

/** 返回所有可能的 DSH 数据目录（去重、按出现顺序）。 */
export function findHomes(explicit) {
  if (explicit) return [resolve(explicit)]
  const found = []
  const add = (d) => { const r = resolve(d); if (looksLikeHome(r) && !found.includes(r)) found.push(r) }
  if (process.env.DSH_HOME) add(process.env.DSH_HOME)
  // 工具放在安装目录或数据目录里时，向上找
  for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) {
    add(d); add(join(d, 'data'))
    if (dirname(d) === d) break
  }
  if (process.platform === 'win32') {
    for (const drive of 'CDEFGH') for (const n of ['dsh-desktop', 'dsh-portable', 'dsh']) add(`${drive}:\\${n}\\data`)
  }
  add(join(homedir(), '.dsh'))
  return found
}

// ---------- 账目 ----------
export function workspacePath(home) { return join(home, 'storages', 'workspace.json') }
export function readWorkspace(home) {
  const p = workspacePath(home)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8'))
}
/** 原子写回账目；写前在 .dsm/backups/<时间>/ 留一份。 */
export function writeWorkspace(home, ws, stamp = timestamp()) {
  const p = workspacePath(home)
  if (existsSync(p)) {
    const bdir = join(home, DSM_DIR, 'backups', stamp)
    mkdirSync(bdir, { recursive: true })
    if (!existsSync(join(bdir, 'workspace.json'))) copyFileSync(p, join(bdir, 'workspace.json'))
  }
  const tmp = `${p}.dsm-tmp`
  writeFileSync(tmp, JSON.stringify(ws))
  renameSync(tmp, p)
}
export function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}
export function projcachePaths(home, id) {
  return [join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)]
}

// ---------- 扫描 ----------
/** 会话目录里的全部代际，按版本号升序。 */
export function generations(dir) {
  const out = []
  for (const f of safeDir(dir)) {
    const m = GENERATION.exec(f)
    if (!m) continue
    out.push({ file: f, path: join(dir, f), version: m[2] ? Number(m[2]) : 0, compressed: Boolean(m[3]) })
  }
  return out.sort((a, b) => a.version - b.version)
}
export function safeDir(d) { try { return readdirSync(d) } catch { return [] } }

function readHeader(path) {
  // 头部一定在第一帧/第一行；小文件整读，大文件也只是解压一次
  const text = readLog(path)
  const nl = text.indexOf('\n')
  return { header: JSON.parse(nl < 0 ? text : text.slice(0, nl)), text }
}

function projcacheTitle(home, id) {
  for (const p of projcachePaths(home, id)) {
    try { return JSON.parse(readFileSync(p, 'utf8'))?.record?.rows?.title?.val } catch { /* 缺失或损坏都无所谓 */ }
  }
  return undefined
}

/**
 * 扫描数据目录下全部会话。每条：
 *   { id, dir, project, gens, latest, header, title, mtime, bytes, archived, pinned, workspace, text? }
 * `withText` 为真时保留解码文本（空会话 / 循环判定要用）。
 */
export function scan(home, { withText = false } = {}) {
  const ws = readWorkspace(home)
  const archived = new Set(ws?.global?.archivedSessionIds ?? [])
  const pinned = new Set(ws?.global?.pinnedSessionIds ?? [])
  const owner = new Map()
  for (const [wid, rec] of Object.entries(ws?.tables?.workspaces ?? {})) {
    for (const sid of rec.sessionIds ?? []) owner.set(sid, { id: wid, title: rec.title, path: rec.path })
  }
  const sessions = []
  const root = join(home, 'sessions')
  for (const project of safeDir(root)) {
    const pdir = join(root, project)
    if (!isDir(pdir)) continue
    for (const name of safeDir(pdir)) {
      const dir = join(pdir, name)
      if (!isDir(dir)) continue
      const gens = generations(dir)
      if (gens.length === 0) { sessions.push({ id: name, dir, project, gens, broken: '没有日志文件' }); continue }
      const latest = gens[gens.length - 1]
      const st = statSync(latest.path)
      let header, text, broken
      try { ({ header, text } = readHeader(latest.path)) } catch (e) { broken = `读不出来：${e.message}` }
      let badFrame = false
      if (!broken && latest.compressed) { try { badFrame = !headerFrameOk(readFileSync(latest.path)) } catch { badFrame = true } }
      const id = header?.id ?? name
      sessions.push({
        id, dir, project, gens, latest, header, broken, badFrame,
        bytes: gens.reduce((s, g) => s + statSync(g.path).size, 0),
        mtime: st.mtimeMs,
        title: projcacheTitle(home, id) ?? (text ? lastTitle(text) : undefined),
        archived: archived.has(id), pinned: pinned.has(id), workspace: owner.get(id),
        ...(withText ? { text } : {}),
      })
    }
  }
  return { ws, sessions: sessions.sort((a, b) => b.mtime - a.mtime) }
}
function isDir(p) { try { return statSync(p).isDirectory() } catch { return false } }
function lastTitle(text) {
  let t
  for (const m of text.matchAll(/"type":"session\/title"[^\n]*?"title":("(?:[^"\\]|\\.)*")/g)) {
    try { t = JSON.parse(m[1]) } catch { /* 忽略 */ }
  }
  return t
}

/** 解码一个会话最新代际的事件列表。 */
export function events(session) {
  if (session.text !== undefined) return parseLines(session.text)
  return parseLines(readLog(session.latest.path))
}
