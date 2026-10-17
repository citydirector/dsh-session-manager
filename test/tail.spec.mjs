import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLog, writeLog, parseLines, scan } from '../src/store.mjs'
import { diagnose, trimTail, compactOffline, surfaceOf, seqOk, CHECKPOINT_PREAMBLE } from '../src/tail.mjs'

/** 造一个有 n 轮对话、末尾挂着 2 轮「只有报错」的会话，事件形态照 DSH v4。 */
function build(n, bigChars = 2000) {
  const evs = [{ type: 'session', version: 4, id: 'session-t', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }]
  let seq = 0; const add = (e) => evs.push({ seq: seq++, time: 1000 + seq, ...e })
  add({ type: 'session/end-seed', data: {} })
  add({ type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, surfaceOp: 'append' })
  for (let t = 1; t <= n; t++) {
    add({ type: 'turn/start', data: { turn: t } })
    add({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `需求 ${t}` }], source: { kind: 'user' }, id: `u${t}` }, surfaceOp: 'append' })
    add({ type: 'step/start', data: { turn: t, step: 1 } })
    add({ type: 'assistant/message', data: { turn: t, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'x'.repeat(bigChars) }, { type: 'tool-call', id: `c${t}`, name: 'write', input: {} }] } }, surfaceOp: 'append' })
    add({ type: 'tool/call', data: { turn: t, step: 1, callId: `c${t}`, name: 'write', arguments: JSON.stringify({ path: `f${t}.txt` }) } })
    add({ type: 'tool/result', data: { turn: t, step: 1, message: { role: 'tool', toolCallId: `c${t}`, content: [{ type: 'text', text: 'y'.repeat(bigChars) }] } }, surfaceOp: 'append' })
    add({ type: 'step/end', data: { turn: t, step: 1 } })
    add({ type: 'step/start', data: { turn: t, step: 2 } })
    add({ type: 'assistant/message', data: { turn: t, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: `完成 ${t}` }] } }, surfaceOp: 'append' })
    add({ type: 'step/end', data: { turn: t, step: 2 } })
    add({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } })
  }
  for (let t = n + 1; t <= n + 2; t++) {
    add({ type: 'turn/start', data: { turn: t } })
    add({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'retry' }], source: { kind: 'user' }, id: `r${t}` }, surfaceOp: 'append' })
    add({ type: 'compaction/start', data: { compactionId: `k${t}`, turn: t } })
    add({ type: 'compaction/end', data: { compactionId: `k${t}`, turn: t, error: 'maximum context length' } })
    add({ type: 'turn/end', data: { turn: t, reason: { kind: 'error', error: { message: 'maximum context length' } } } })
  }
  return evs
}
function setup(evs) {
  const home = mkdtempSync(join(tmpdir(), 'dsm-tail-'))
  const dir = join(home, 'sessions', '--w--', 'session-t'); mkdirSync(dir, { recursive: true })
  writeLog(join(dir, 'session.v4.jsonl.zstd'), `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`)
  const pc = join(home, 'storages', 'session_projcache', 'sessions'); mkdirSync(pc, { recursive: true })
  writeFileSync(join(pc, 'session-t.json'), '{}')
  return home
}
const get = (home) => scan(home).sessions[0]

test('diagnose: 建议截到最后一轮有回复的轮次', () => {
  const d = diagnose(build(5).map((e) => JSON.stringify(e)).join('\n'))
  assert.equal(d.turns.length, 7)
  assert.equal(d.suggestKeep, 5)
  assert.equal(d.turns[6].outcome, '出错')
})

test('trimTail: 截掉烂尾，seq 连续，投影缓存挪进备份', () => {
  const home = setup(build(5))
  const r = trimTail(home, get(home), 5)
  assert.ok(r.dropped > 0)
  const evs = parseLines(readLog(get(home).latest.path))
  assert.ok(seqOk(evs))
  assert.equal(evs.at(-1).type, 'turn/end')
  assert.equal(evs.at(-1).data.turn, 5)
  assert.ok(!existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-t.json')))
  assert.throws(() => trimTail(home, get(home), 9))
})

test('compactOffline: 写入 DSH 原生压缩事件，surface 只剩系统头 + 检查点 + 保留轮', () => {
  const home = setup(build(8))
  trimTail(home, get(home), 8)
  const r = compactOffline(home, get(home), { keepTurns: 2 })
  assert.equal(r.compactedTurns, 6)
  assert.ok(r.afterTokens < r.beforeTokens)
  const evs = parseLines(readLog(get(home).latest.path))
  assert.ok(seqOk(evs))
  const types = evs.slice(-4).map((e) => e.type)
  assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  const cp = evs.at(-2)
  assert.equal(cp.data.source.kind, 'compact-checkpoint')
  assert.ok(cp.data.content[0].text.startsWith(CHECKPOINT_PREAMBLE))
  assert.match(cp.data.content[1].text, /需求 1[\s\S]*完成 1[\s\S]*f1\.txt/)
  // 被替换的每个节点都要出现在 sourceEventSeqs 里（DSH 回放校验同一条规则）
  for (const s of evs.at(-3).data.shadowedSeqs) assert.ok(cp.sourceEventSeqs.includes(s))
  const surface = surfaceOf(evs)
  const bySeq = new Map(evs.map((e) => [e.seq, e]))
  assert.equal(bySeq.get(surface[0]).type, 'system/message')
  assert.equal(surface[1], cp.seq)
  const userTexts = surface.map((q) => bySeq.get(q)).filter((e) => e.data?.source?.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(userTexts, ['需求 7', '需求 8'])
})

test('compactOffline: 末轮未收尾时拒绝', () => {
  const evs = build(3).slice(0, -1) // 去掉最后的 turn/end
  const home = setup(evs)
  assert.throws(() => compactOffline(home, get(home)), /没有结束|截掉烂尾/)
})
