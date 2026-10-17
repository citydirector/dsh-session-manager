/**
 * 烂尾会话的离线修理：
 *   - turns()        把日志按轮次切开，标出每轮结局（完成 / 用户中止 / 出错）和体量；
 *   - trimTail()     从某一轮之后整段截掉（日志尾部截断，seq 仍连续，结构天然合法）；
 *   - compactOffline() 不调用任何模型，用 DSH 自己的压缩事件把较早的轮次替换成一条
 *                    「摘录式」检查点（每轮的用户原话 + 助手最终回复 + 改过的文件），
 *                    只留最近几轮原文，让上下文重新塞得进模型窗口。
 * 所有改动都先备份原日志，并把该会话的投影缓存挪进备份（派生数据，DSH 会自己重建）。
 */
import { existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DSM_DIR, parseLines, projcachePaths, readLog, timestamp, writeLog } from './store.mjs'

/** 与 DSH dsh-compaction-basic 完全相同的检查点外框，模型看到的形态和原生压缩一致。 */
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const OPEN = '<compacted-summary>'; const CLOSE = '</compacted-summary>'

const textOf = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…（后略 ${s.length - n} 字）` : s)
/** 粗估 token：中英混排 + 代码，约 3.5 字符一个。只用于挑选保留多少轮。 */
export const estTokens = (chars) => Math.ceil(chars / 3.5)

/** 模型实际看到的那部分（不含流式原始分片 stream）。 */
function modelChars(e) {
  if (e.type === 'assistant/message' || e.type === 'tool/result' || e.type === 'system/message' || e.type === 'developer/message') return JSON.stringify(e.data?.message ?? '').length
  if (e.type === 'user/message') return JSON.stringify(e.data?.content ?? '').length
  return 0
}

/** 第 0 行是会话头（没有 seq），其后事件 seq 从 0 连续递增。 */
export function seqOk(evs) {
  let n = 0
  for (const e of evs) { if (e.type === 'session' && e.seq === undefined) continue; if (e.seq !== n++) return false }
  return true
}

/** 当前 surface（模型上下文节点序列），按 DSH 的 append / replace 规则折叠。 */
export function surfaceOf(evs) {
  const nodes = []
  for (const e of evs) {
    const op = e.surfaceOp
    if (op === undefined) continue
    if (op === 'append') { nodes.push(e.seq); continue }
    const a = nodes.indexOf(op.startSeq); const b = nodes.indexOf(op.endSeq)
    if (a < 0 || b < 0 || a > b) throw new Error(`surface 折叠失败（seq ${e.seq}）`)
    nodes.splice(a, b - a + 1, e.seq)
  }
  return nodes
}

export function turns(evs) {
  const out = []; let cur
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]
    if (e.type === 'turn/start') { cur = { turn: e.data?.turn, start: i, startSeq: e.seq, time: e.time, steps: 0, msgs: 0, chars: 0, user: [], errors: 0 }; out.push(cur); continue }
    if (!cur) continue
    cur.chars += modelChars(e)
    if (e.type === 'step/start') cur.steps++
    if (e.type === 'assistant/message') cur.msgs++
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') cur.user.push(textOf(e.data.content))
    if (e.type === 'compaction/end' && e.data?.error) cur.errors++
    if (e.type === 'turn/end') {
      cur.end = i; cur.endSeq = e.seq
      const r = e.data?.reason ?? {}
      cur.outcome = r.kind === 'completed' ? '完成' : r.kind === 'aborted' ? '中止' : r.kind === 'error' ? '出错' : (r.kind ?? '?')
      cur.error = r.error?.message
      cur = undefined
    }
  }
  return out
}

/** 体检：看看尾部烂在哪。返回每轮概况和一个建议的截断点（最后一轮「干过活」的轮次）。 */
export function diagnose(text) {
  const evs = parseLines(text)
  const ts = turns(evs)
  const surface = surfaceOf(evs)
  const bySeq = new Map(evs.map((e) => [e.seq, e]))
  const contextChars = surface.reduce((s, q) => s + modelChars(bySeq.get(q)), 0)
  // 从末尾往前，跳过「模型一句话都没产出」或没收尾的轮次（只有报错、重试、空中止）
  let keep = ts.length - 1
  while (keep >= 0 && (ts[keep].msgs === 0 || ts[keep].end === undefined)) keep--
  const lastCompaction = [...evs].reverse().find((e) => e.type === 'compaction/end')
  return { evs, turns: ts, contextTokens: estTokens(contextChars), suggestKeep: keep >= 0 ? ts[keep].turn : undefined, lastCompactionError: lastCompaction?.data?.error }
}

function backupLog(home, session, stamp, tag) {
  const dir = join(home, DSM_DIR, 'backups', stamp, 'sessions', session.project, basename(session.dir))
  mkdirSync(dir, { recursive: true })
  copyFileSync(session.latest.path, join(dir, session.latest.file))
  // 投影缓存是派生数据；挪进备份，DSH 下次打开会按新日志重建
  for (const p of projcachePaths(home, session.id)) {
    if (existsSync(p)) { mkdirSync(join(dir, 'projcache'), { recursive: true }); renameSync(p, join(dir, 'projcache', basename(p))) }
  }
  return join(dir, session.latest.file)
}

/** 保留到第 keepTurn 轮（含）为止，之后的事件全部截掉。 */
export function trimTail(home, session, keepTurn, { stamp = timestamp() } = {}) {
  const text = readLog(session.latest.path)
  const evs = parseLines(text)
  const t = turns(evs).find((x) => x.turn === keepTurn)
  if (!t || t.end === undefined) throw new Error(`第 ${keepTurn} 轮不存在或没有正常结束，不能作为截断点。`)
  const kept = evs.slice(0, t.end + 1)
  const dropped = evs.length - kept.length
  if (!dropped) return { dropped: 0 }
  if (!seqOk(kept)) throw new Error('自检失败：seq 不连续，未写入。')
  const backup = backupLog(home, session, stamp, 'trim')
  writeLog(session.latest.path, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`)
  if (parseLines(readLog(session.latest.path)).length !== kept.length) throw new Error('自检失败：写回后事件数不对。')
  return { dropped, backup, cutTime: evs[t.end].time }
}

/** 每轮一段摘录：用户原话、助手最后的可见回复、写过的文件。 */
function digestTurn(evs, t) {
  const files = new Set(); const texts = []
  for (let i = t.start; i <= (t.end ?? evs.length - 1); i++) {
    const e = evs[i]
    if (e.type === 'assistant/message') {
      const s = textOf(e.data?.message?.content); if (s) texts.push(s)
    }
    if (e.type === 'tool/call' && /^(write|edit|multi_?edit|apply_?patch|str_replace|create_file)$/i.test(e.data?.name ?? '')) {
      try { const a = JSON.parse(e.data.arguments ?? '{}'); const p = a.path ?? a.file_path ?? a.filePath ?? a.file; if (p) files.add(String(p)) } catch { /* 参数不是 JSON 就算了 */ }
    }
  }
  const lines = [`### 第 ${t.turn} 轮（${new Date(t.time).toISOString().slice(0, 16).replace('T', ' ')} UTC，${t.outcome ?? '未结束'}，${t.steps} 步）`]
  for (const u of t.user) if (u) lines.push(`用户：${clip(u, 3000)}`)
  const last = texts.slice(-2).join('\n\n')
  if (last) lines.push(`助手（本轮最后的回复）：${clip(last, 2500)}`)
  if (files.size) lines.push(`本轮写过的文件：${[...files].slice(0, 40).join('、')}${files.size > 40 ? ` 等 ${files.size} 个` : ''}`)
  return lines.join('\n')
}

/**
 * 离线压缩：保留最近若干轮原文（按 keepTokens 预算挑，至少 1 轮），其余换成检查点。
 * 写入的事件与 DSH 原生压缩一致：compaction/start → compaction/summary →
 * user/message(surfaceOp replace, source=compact-checkpoint) → compaction/end。
 */
export function compactOffline(home, session, { keepTokens = 120000, keepTurns, stamp = timestamp() } = {}) {
  const text = readLog(session.latest.path)
  const evs = parseLines(text)
  const ts = turns(evs).filter((t) => t.end !== undefined)
  if (ts.length < 2) throw new Error('轮次太少，没什么可压缩的。')
  if (!seqOk(evs)) throw new Error('日志 seq 不连续，先别动它。')
  const tail = evs.length && turns(evs).at(-1)
  if (tail && tail.end === undefined) throw new Error('最后一轮没有结束（DSH 可能还开着或异常退出），请先截掉烂尾。')
  const lastStart = [...evs].reverse().find((e) => e.type === 'compaction/start')
  const lastEnd = [...evs].reverse().find((e) => e.type === 'compaction/end')
  if (lastStart && (!lastEnd || lastEnd.seq < lastStart.seq)) throw new Error('日志里有未收尾的压缩，先截掉烂尾。')

  // 挑保留的轮次
  let k
  if (keepTurns) k = Math.min(keepTurns, ts.length - 1)
  else { k = 0; let sum = 0; for (let i = ts.length - 1; i > 0; i--) { sum += estTokens(ts[i].chars); if (k >= 1 && sum > keepTokens) break; k++ } }
  const firstKept = ts[ts.length - k]
  const surface = surfaceOf(evs)
  const bySeq = new Map(evs.map((e) => [e.seq, e]))
  const startIdx = bySeq.get(surface[0])?.type === 'system/message' ? 1 : 0
  let endIdx = -1
  for (let i = surface.length - 1; i >= 0; i--) if (surface[i] < firstKept.startSeq) { endIdx = i; break }
  if (endIdx < startIdx) throw new Error('可压缩的范围是空的。')
  const shadowed = surface.slice(startIdx, endIdx + 1)
  const shadowedChars = shadowed.reduce((s, q) => s + modelChars(bySeq.get(q)), 0)

  const compacted = ts.filter((t) => t.startSeq < firstKept.startSeq)
  const body = [
    `（由 dsm 离线生成的摘录式检查点：第 ${compacted[0].turn}–${compacted.at(-1).turn} 轮的用户要求、助手最终回复和改动过的文件。中间的思考、工具调用和输出已省略；如需细节，请重新读取相关文件。）`,
    ...compacted.map((t) => digestTurn(evs, t)),
  ].join('\n\n')
  const summary = [{ type: 'text', text: body }]
  const compactionId = randomUUID()
  let seq = evs.at(-1).seq + 1; const now = Date.now()
  const add = (e) => { const ev = { type: e.type, seq: seq++, time: now, ...e }; evs.push(ev); return ev }
  const start = add({ type: 'compaction/start', data: { compactionId, turn: null } })
  const sum = add({ type: 'compaction/summary', data: { compactionId, summary, shadowedRange: { start: shadowed[0], end: shadowed.at(-1) }, shadowedSeqs: shadowed, shadowedTokenCount: estTokens(shadowedChars), provider: 'dsm', model: 'extractive' } })
  add({
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${OPEN}` }, ...summary, { type: 'text', text: CLOSE }], source: { kind: 'compact-checkpoint', compactionId }, id: randomUUID() },
    sourceEventSeqs: [start.seq, sum.seq, ...shadowed],
    surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) },
  })
  add({ type: 'compaction/end', data: { compactionId, turn: null } })

  const after = surfaceOf(evs)
  const afterTokens = estTokens(after.reduce((s, q) => s + modelChars(evs.find((e) => e.seq === q)), 0))
  const beforeTokens = estTokens(surface.reduce((s, q) => s + modelChars(bySeq.get(q)), 0))
  const backup = backupLog(home, session, stamp, 'compact')
  writeLog(session.latest.path, `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`)
  if (parseLines(readLog(session.latest.path)).length !== evs.length) throw new Error('自检失败：写回后事件数不对。')
  return { compactedTurns: compacted.length, keptTurns: k, beforeTokens, afterTokens, summaryChars: body.length, backup }
}
