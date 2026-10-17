import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { decode, encodeLog, headerFrameOk, readLog, writeLog, scan, readWorkspace } from '../src/store.mjs'
import {
  isEmptySession, trashSessions, listTrash, restoreFromTrash, purgeTrash, setArchived, findLoops, cleanLoops,
  repairFrames, needsUpgrade,
} from '../src/ops.mjs'

const CWD = '/w/proj'
const PROJECT = '--w-proj--'
const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard', ...extra })
const seed = (seq) => [
  { type: 'permission/preset', seq: seq++, time: 1, data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', seq: seq++, time: 1, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: seq++, time: 1, data: {} },
  { type: 'subagent/model-selection-policy', seq: seq++, time: 1, data: {} },
]
function loopText() {
  let s = "Now I'm clear. Let me get back to work.\n"
  for (let i = 0; i < 20; i++) { s += 'Now.\nOK.\nEnough.\nLet me write.\nEmit.\nProducing.\nI emit.\n'; if (i % 3 === 0) s += 'Let me write the call.\n' }
  return s
}

/** 按 DSH 的真实写法落盘：头部一帧，之后每批事件各一帧。 */
function writeDshStyle(path, lines, batches = 3) {
  const head = `${JSON.stringify(lines[0])}\n`
  const rest = lines.slice(1).map((l) => `${JSON.stringify(l)}\n`)
  const frames = [zlib.zstdCompressSync(Buffer.from(head), opts)]
  const per = Math.max(1, Math.ceil(rest.length / batches))
  for (let i = 0; i < rest.length; i += per) frames.push(zlib.zstdCompressSync(Buffer.from(rest.slice(i, i + per).join('')), opts))
  writeFileSync(path, Buffer.concat(frames))
}

let home
function addSession(id, events, { file = 'session.v4.jsonl.zstd', title } = {}) {
  const dir = join(home, 'sessions', PROJECT, id)
  mkdirSync(dir, { recursive: true })
  writeDshStyle(join(dir, file), events)
  if (title) {
    const pc = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(pc, { recursive: true })
    writeFileSync(join(pc, `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } }))
  }
  return dir
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsm-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  addSession('session-empty', [header('session-empty'), ...seed(0)])
  addSession('session-chat', [header('session-chat'), ...seed(0),
    { type: 'user/message', seq: 4, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 5, time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
  ], { title: 'chat' })
  addSession('session-loop', [header('session-loop'), ...seed(0),
    { type: 'user/message', seq: 4, time: 2, data: { content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant/message', seq: 5, time: 3, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: loopText() }, { type: 'text', text: 'done' }], source: { replayState: { x: 1 } } } } },
  ], { title: 'loop' })
  addSession('session-old', [{ ...header('session-old'), version: 3 }, { type: 'user/message', seq: 0, time: 1, data: {} }], { file: 'session.v3.jsonl.zstd', title: 'old' })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['session-old'], pinnedSessionIds: ['session-chat'] },
    tables: { workspaces: { w1: { path: CWD, title: 'proj', sessionIds: ['session-old', 'session-chat', 'session-empty'] } } },
  }))
})

const byId = (id) => scan(home).sessions.find((s) => s.id === id)

test('多帧日志：逐帧解码完整，不只读第一帧', () => {
  const s = byId('session-chat')
  const text = readLog(s.latest.path)
  assert.equal(text.trim().split('\n').length, 7)
  // 对照：Node 自带的 zstdDecompressSync 只解第一帧
  assert.equal(zlib.zstdDecompressSync(readFileSync(s.latest.path)).toString().trim().split('\n').length, 1)
})

test('写回保持 DSH 的帧布局：第一帧恰好一行头部', () => {
  const text = `${JSON.stringify(header('x'))}\n{"type":"a"}\n{"type":"b"}\n`
  const buf = encodeLog(text, true)
  assert.equal(headerFrameOk(buf), true)
  assert.equal(decode(buf), text)
  assert.equal(headerFrameOk(zlib.zstdCompressSync(Buffer.from(text), opts)), false)
})

test('扫描：标题、归档、置顶、旧代际', () => {
  const { sessions } = scan(home)
  assert.equal(sessions.length, 4)
  assert.equal(byId('session-chat').title, 'chat')
  assert.equal(byId('session-chat').pinned, true)
  assert.equal(byId('session-old').archived, true)
  assert.deepEqual(needsUpgrade(sessions, 4).map((s) => s.id), ['session-old'])
})

test('空会话：只有种子事件才算空；未知事件按有内容处理', () => {
  const { sessions } = scan(home, { withText: true })
  assert.deepEqual(sessions.filter(isEmptySession).map((s) => s.id), ['session-empty'])
  addSession('session-odd', [header('session-odd'), { type: 'something/new', seq: 0, time: 1, data: {} }])
  assert.equal(isEmptySession(scan(home, { withText: true }).sessions.find((s) => s.id === 'session-odd')), false)
})

test('回收站：搬走目录与投影缓存、摘账目；恢复回原槽位与标记', () => {
  const pick = scan(home).sessions.filter((s) => s.id === 'session-chat' || s.id === 'session-old')
  trashSessions(home, pick)
  let ws = readWorkspace(home)
  assert.deepEqual(ws.tables.workspaces.w1.sessionIds, ['session-empty'])
  assert.deepEqual(ws.global.archivedSessionIds, [])
  assert.deepEqual(ws.global.pinnedSessionIds, [])
  assert.equal(existsSync(join(home, 'sessions', PROJECT, 'session-chat')), false)
  assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-chat.json')), false)
  const items = listTrash(home)
  assert.equal(items.length, 2)
  restoreFromTrash(home, items)
  ws = readWorkspace(home)
  assert.deepEqual(ws.tables.workspaces.w1.sessionIds, ['session-old', 'session-chat', 'session-empty'])
  assert.deepEqual(ws.global.archivedSessionIds, ['session-old'])
  assert.deepEqual(ws.global.pinnedSessionIds, ['session-chat'])
  assert.equal(byId('session-chat').title, 'chat')
  assert.equal(listTrash(home).length, 0)
})

test('恢复冲突时拒绝，绝不合并两份历史', () => {
  const s = byId('session-chat')
  trashSessions(home, [s])
  addSession('session-chat', [header('session-chat')])
  assert.throws(() => restoreFromTrash(home, listTrash(home)), /恢复冲突/)
})

test('彻底删除只清回收站条目', () => {
  trashSessions(home, [byId('session-empty')])
  assert.equal(purgeTrash(home, listTrash(home)), 1)
  assert.equal(listTrash(home).length, 0)
  assert.equal(readdirSync(join(home, '.dsm', 'trash')).length, 0)
})

test('归档 / 取消归档沿用 DSH 语义：归档时顺带取消置顶', () => {
  setArchived(home, ['session-chat'], true)
  let ws = readWorkspace(home)
  assert.deepEqual(ws.global.archivedSessionIds, ['session-old', 'session-chat'])
  assert.deepEqual(ws.global.pinnedSessionIds, [])
  setArchived(home, ['session-old'], false)
  ws = readWorkspace(home)
  assert.deepEqual(ws.global.archivedSessionIds, ['session-chat'])
  assert.ok(existsSync(join(home, '.dsm', 'backups')))
})

test('循环清洗：截断正文、去 replayState、事件数不变、帧布局合法、有备份', () => {
  const s = byId('session-loop')
  const before = readLog(s.latest.path)
  assert.equal(findLoops(before).count, 1)
  const r = cleanLoops(home, s)
  assert.equal(r.blocks, 1)
  const after = readLog(s.latest.path)
  assert.equal(findLoops(after).count, 0)
  assert.equal(after.trim().split('\n').length, before.trim().split('\n').length)
  assert.equal(headerFrameOk(readFileSync(s.latest.path)), true)
  const msg = after.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'assistant/message')
  assert.equal(msg.data.message.source.replayState, undefined)
  assert.equal(msg.data.message.content[1].text, 'done')
  assert.ok(existsSync(r.backup))
})

test('旧版本会话不清洗，要求先升级', () => {
  assert.throws(() => cleanLoops(home, byId('session-old')), /只支持 v4/)
})

test('修复被 DSH 隐藏的会话：单帧重写为头部独立成帧', () => {
  const s = byId('session-chat')
  const text = readLog(s.latest.path)
  writeFileSync(s.latest.path, zlib.zstdCompressSync(Buffer.from(text), opts))
  const bad = byId('session-chat')
  assert.equal(bad.badFrame, true)
  repairFrames(home, bad)
  assert.equal(byId('session-chat').badFrame, false)
  assert.equal(readLog(s.latest.path), text)
})
