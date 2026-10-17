/**
 * 改动前的安全闸：
 *   1. DSH 必须完全退出——JSONL 后端只允许一个写入者，「不是当前会话」不等于没人在写；
 *      检测不出来或检测出错一律当作「在运行」（失败即关闭），--force 才放行。
 *   2. 同一数据目录同时只允许一个 dsm 在改（.dsm/lock）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { DSM_DIR } from './store.mjs'
import { APP_DIR, IS_SEA } from './runtime.mjs'

// 自己：打包形态只认 dsm.exe 这个文件（exe 可能就放在 DSH 安装目录里，不能排除整个目录）
const SELF = (IS_SEA ? process.execPath : APP_DIR).toLowerCase()

function processes() {
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 64 << 20 })
    const list = JSON.parse(out || '[]')
    return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.ProcessId, name: p.Name ?? '', exe: p.ExecutablePath ?? '', cmd: p.CommandLine ?? '' }))
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 << 20 })
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l)
    return { pid: Number(m?.[1]), name: '', exe: '', cmd: m?.[2] ?? '' }
  })
}

/** 返回疑似 DSH 的进程描述；检测失败时抛错。 */
export function dshProcesses(home) {
  const base = basename(home).toLowerCase() === 'data' ? dirname(home) : home
  const needles = [home, base].map((s) => s.toLowerCase())
  const isDsh = (p) => {
    const hay = `${p.exe}\n${p.cmd}`.toLowerCase()
    if (p.pid === process.pid || p.pid === process.ppid) return false
    if (hay.includes(SELF) || /[\\/]bin[\\/]dsm\.mjs/.test(hay)) return false
    if (/deepseek harness/.test(hay)) return true
    if (/(^|[\\/\s"])dsh(\.exe|\.cmd|\.js)?(?=[\s"]|$)/.test(hay)) return true
    if (/@deepseek-ai[\\/]dsh[\\/]/.test(hay)) return true
    return needles.some((n) => n.length > 3 && hay.includes(n))
  }
  return processes().filter(isDsh).map((p) => `${p.pid} ${(p.exe || p.cmd).slice(0, 120)}`)
}

/** 有 DSH 在跑（或无法确认）就抛错。 */
export function assertQuiescent(home, { force = false } = {}) {
  if (force) return
  let found
  try { found = dshProcesses(home) } catch (e) {
    throw new Error(`无法确认 DSH 是否已退出（${e.message}）。确认已完全退出后可加 --force。`)
  }
  if (found.length) {
    throw new Error(`DSH 似乎还在运行，请先完全退出（含托盘）：\n  ${found.join('\n  ')}\n确认与本数据目录无关可加 --force。`)
  }
}

export function withLock(home, fn) {
  const dir = join(home, DSM_DIR)
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'lock')
  if (existsSync(lock)) {
    let pid
    try { pid = JSON.parse(readFileSync(lock, 'utf8')).pid } catch { /* 坏锁 */ }
    let alive = false
    if (pid) { try { process.kill(pid, 0); alive = true } catch { alive = false } }
    if (alive) throw new Error(`另一个 dsm（pid ${pid}）正在修改这个数据目录。`)
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const release = () => { try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) rmSync(lock) } catch { /* 已删 */ } }
  try {
    const r = fn()
    if (r && typeof r.then === 'function') return r.finally(release)
    release()
    return r
  } catch (e) { release(); throw e }
}
