import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDshHome, normalizeHome, scanRoots, homesFromProbe, findHomes, rememberHome, readConfig } from '../src/discover.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsm-disc-'))
/** 造一个 DSH-build 风格安装：<install>\data\sessions\<项目>\session-xxx\session.v4.jsonl.zstd */
function makeInstall(install, { workspace = false } = {}) {
  const s = join(install, 'data', 'sessions', '--w-proj--', 'session-0123abcd-0000-0000-0000-000000000000')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'session.v4.jsonl.zstd'), '')
  if (workspace) { mkdirSync(join(install, 'data', 'storages'), { recursive: true }); writeFileSync(join(install, 'data', 'storages', 'workspace.json'), '{}') }
  mkdirSync(join(install, 'app'), { recursive: true })
  writeFileSync(join(install, 'DeepSeek Harness.exe'), '')
  return join(install, 'data')
}
const noScan = { scan: false, probe: { lnk: [], reg: [], env: [] }, env: {}, home: '/nonexistent-home' }

test('强判定：别的程序的 data\\sessions 不算，DSH 的算', () => {
  const r = tmp()
  mkdirSync(join(r, 'other', 'data', 'sessions', 'abc'), { recursive: true })
  writeFileSync(join(r, 'other', 'data', 'sessions', 'abc', 'x.json'), '')
  assert.equal(isDshHome(join(r, 'other', 'data')), false)
  assert.equal(isDshHome(makeInstall(join(r, 'dsh'))), true)
})

test('用户给安装目录、data 目录或 sessions 目录都能归一到 data', () => {
  const r = tmp(); const data = makeInstall(join(r, '随便起的名字'))
  assert.equal(normalizeHome(join(r, '随便起的名字')), data)
  assert.equal(normalizeHome(data), data)
  assert.equal(normalizeHome(join(data, 'sessions')), data)
  assert.equal(normalizeHome(`"${join(r, '随便起的名字')}"`), data)   // 拖进窗口带引号
  assert.equal(normalizeHome(join(r, 'nope')), undefined)
})

test('扫盘：任意名字、3 层以内都能找到；更深、node_modules 里的不找', () => {
  const r = tmp()
  const a = makeInstall(join(r, 'MyTools'))
  const b = makeInstall(join(r, 'Apps', 'Deep Seek 助手'))
  const c = makeInstall(join(r, 'x', 'y', 'z'))
  makeInstall(join(r, 'x', 'y', 'z', 'w'))
  makeInstall(join(r, 'node_modules', 'dsh'))
  const found = scanRoots([r], { depth: 3 })
  assert.deepEqual(new Set(found), new Set([a, b, c]))
})

test('快捷方式和注册表：指向 DSH 的才看，往上找安装目录', () => {
  const r = tmp()
  const a = makeInstall(join(r, 'A 安装'))
  const b = makeInstall(join(r, 'B'))
  const c = makeInstall(join(r, 'C'))
  makeInstall(join(r, 'Unrelated'))
  const probe = {
    lnk: [
      { name: 'DeepSeek Harness', target: join(r, 'A 安装', 'DeepSeek Harness.exe'), cwd: '', args: '' },
      { name: '便携启动', target: 'C:\\Windows\\System32\\cmd.exe', cwd: join(r, 'C', 'app'), args: '/c start-dsh.cmd' },
      { name: '记事本', target: join(r, 'Unrelated', 'DeepSeek Harness.exe').replace('DeepSeek Harness', 'notepad'), cwd: '', args: '' },
    ],
    reg: [{ name: 'DeepSeek Harness', loc: '', icon: `"${join(r, 'B', 'DeepSeek Harness.exe')}",0`, uninst: '' }],
    env: [],
  }
  assert.deepEqual(new Set(homesFromProbe(probe)), new Set([a, b, c]))
})

test('dsm 放在安装目录任意一层都能找到，便宜的步骤找到就不扫盘', () => {
  const r = tmp(); const data = makeInstall(join(r, '奇怪的名字'))
  mkdirSync(join(r, '奇怪的名字', 'tools', 'dsm'), { recursive: true })
  let probed = false
  const probe = new Proxy({ lnk: [], reg: [], env: [] }, { get(t, k) { probed = true; return t[k] } })
  const homes = findHomes(undefined, { ...noScan, probe, appDir: join(r, '奇怪的名字', 'tools', 'dsm'), configDir: join(r, 'cfg') })
  assert.deepEqual(homes.map((h) => h.path), [data])
  assert.equal(probed, false)
})

test('dsm 放在别处：先用上次记住的；什么都没有时才扫盘', () => {
  const r = tmp(); const data = makeInstall(join(r, 'disk', 'Apps', 'DSH 2'))
  const cfg = join(r, 'cfg')
  const elsewhere = join(r, 'desktop'); mkdirSync(elsewhere)
  assert.deepEqual(findHomes(undefined, { ...noScan, appDir: elsewhere, configDir: cfg }), [])
  const scanned = findHomes(undefined, { ...noScan, scan: true, scanRoots: [join(r, 'disk')], appDir: elsewhere, configDir: cfg })
  assert.deepEqual(scanned, [{ path: data, via: '磁盘扫描' }])
  rememberHome(data, cfg)
  assert.deepEqual(findHomes(undefined, { ...noScan, appDir: elsewhere, configDir: cfg }), [{ path: data, via: '上次使用' }])
  rememberHome(join(r, 'other'), cfg); rememberHome(data, cfg)
  assert.equal(readConfig(cfg).homes[0], data)
})

test('DSH_HOME 指向安装目录也认', () => {
  const r = tmp(); const data = makeInstall(join(r, 'P'))
  const homes = findHomes(undefined, { ...noScan, env: { DSH_HOME: join(r, 'P') }, appDir: join(r, 'zz'), configDir: join(r, 'cfg') })
  assert.equal(homes[0].path, data)
})
