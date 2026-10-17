#!/usr/bin/env node
/**
 * 打包后的冒烟测试（CI 在 Windows 上跑）：node scripts/smoke-exe.mjs dist/dsm.exe
 * 造一个临时数据目录，用 exe 跑 list / empty / restore，并验证「DSH 在跑就拒绝」。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as zlib from 'node:zlib'
import assert from 'node:assert/strict'

const exe = resolve(process.argv[2] ?? 'dist/dsm.exe')
const root = mkdtempSync(join(tmpdir(), 'dsm-smoke-'))
const home = join(root, 'data')
mkdirSync(join(home, 'storages'), { recursive: true })

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join('')))
function addSession(id, events) {
  const dir = join(home, 'sessions', '--w-proj--', id)
  mkdirSync(dir, { recursive: true })
  const h = { type: 'session', version: 4, id, createdAt: 1, cwd: '/w/proj', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame([h]), frame(events)]))
}
const seed = [{ type: 'permission/preset', seq: 0, time: 1, data: {} }, { type: 'sandbox/mode', seq: 1, time: 1, data: {} }]
addSession('session-empty', seed)
addSession('session-chat', [...seed,
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } }])

const dsm = (...args) => {
  const r = spawnSync(exe, ['--home', home, ...args], { encoding: 'utf8', timeout: 120000 })
  const out = `${r.stdout}${r.stderr}`
  console.log(`$ dsm ${args.join(' ')}  (退出码 ${r.status})\n${out}`)
  return { code: r.status, out }
}
const trashCount = () => (existsSync(join(home, '.dsm', 'trash')) ? readdirSync(join(home, '.dsm', 'trash')).length : 0)

assert.match(dsm('--help').out, /交互菜单/)
const l = dsm('list')
assert.equal(l.code, 0); assert.match(l.out, /共 2 个/)

// 假装 DSH 在跑：同目录下一个叫 DeepSeek Harness.exe 的进程
const fake = join(root, process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness')
copyFileSync(process.execPath, fake)
const child = spawn(fake, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))
const blocked = dsm('empty', '--yes')
child.kill()
assert.equal(blocked.code, 1); assert.match(blocked.out, /还在运行/); assert.equal(trashCount(), 0)
await new Promise((r) => setTimeout(r, 1500))

const e = dsm('empty', '--yes')
assert.equal(e.code, 0); assert.match(e.out, /已移入回收站：1 个/)
assert.match(dsm('list').out, /共 1 个/)
const r = dsm('restore', '1', '--yes')
assert.equal(r.code, 0); assert.match(r.out, /已恢复 1 个/)
assert.match(dsm('list').out, /共 2 个/)
console.log('冒烟测试通过')
