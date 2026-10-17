/**
 * 找 DSH 数据目录。DSH 自己的规则：配置里显式指定 > $DSH_HOME > ~/.dsh；
 * DSH-build 便携版 / 桌面版的启动器把 DSH_HOME 设成 <安装目录>\data。
 * 安装目录可以叫任何名字、放在任何盘，所以这里按「从准到泛」依次找：
 *
 *   1. --home
 *   2. $DSH_HOME（含 Windows 用户 / 系统环境变量里长期设置的）
 *   3. dsm 自己所在目录往上逐层（工具放在安装目录里任意一层都能找到）
 *   4. 上次用过的目录（%APPDATA%\dsm\config.json）
 *   5. Windows 开始菜单 / 桌面快捷方式的目标、卸载注册表里的安装位置
 *   6. 每个盘往下 3 层里所有「<目录>\data 像 DSH 数据目录」的位置（有时间预算，跳过系统目录）
 *   7. ~/.dsh
 *
 * 1–4、7 很便宜，先做；有结果就直接用，5、6 只在一个都没找到或用户选「搜索其它位置」时才做。
 * 都找不到时，交互界面让用户把目录拖进窗口（见 bin/dsm.mjs）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { APP_DIR } from './runtime.mjs'

const SESSION_DIR_RE = /^session-[0-9a-f-]{8,}$/i

/** 强判定：workspace.json，或 sessions\<项目>\session-xxx\ 里有日志。用于泛扫，避免误认别的程序的 data。 */
export function isDshHome(dir) {
  try {
    if (existsSync(join(dir, 'storages', 'workspace.json'))) return true
    const sess = join(dir, 'sessions')
    if (!existsSync(sess)) return false
    let checked = 0
    for (const proj of readdirSync(sess, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      for (const s of readdirSync(join(sess, proj.name), { withFileTypes: true })) {
        if (!s.isDirectory() || !SESSION_DIR_RE.test(s.name)) continue
        if (readdirSync(join(sess, proj.name, s.name)).some((f) => /^session(\.v\d+)?\.jsonl/.test(f))) return true
        if (++checked > 20) return false
      }
      if (checked > 20) return false
    }
    // 刚装好、一个会话都没有：有 sessions 目录 + DSH 特有文件
    return ['cordis.patch.yml', '.credentials.yaml', 'profiles', 'llm-deepseek'].some((f) => existsSync(join(dir, f)))
  } catch { return false }
}

/** 弱判定：用户明确指定或环境变量给出的目录，有 sessions 或 workspace.json 就算。 */
export function looksLikeHome(dir) {
  return existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'storages', 'workspace.json'))
}

/** 用户给的可能是安装目录、data 目录，甚至 sessions 目录：都归一到 data 目录。 */
export function normalizeHome(input) {
  if (!input) return undefined
  let p = resolve(String(input).trim().replace(/^["']|["']$/g, ''))
  if (basename(p).toLowerCase() === 'sessions' && existsSync(p)) p = dirname(p)
  if (looksLikeHome(p)) return p
  for (const sub of ['data', join('resources', 'data')]) if (looksLikeHome(join(p, sub))) return join(p, sub)
  return undefined
}

// ---------- 记住上次的选择 ----------
export function configDir(env = process.env) {
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsm')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dsm')
}
export function readConfig(dir = configDir()) {
  try { return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) } catch { return {} }
}
export function rememberHome(home, dir = configDir()) {
  try {
    const cfg = readConfig(dir)
    cfg.homes = [home, ...(cfg.homes ?? []).filter((h) => h !== home)].slice(0, 10)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  } catch { /* 记不住也不影响使用 */ }
}

// ---------- Windows：快捷方式、注册表、长期环境变量 ----------
const PS_PROBE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ lnk = @(); reg = @(); env = @() }
$sh = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'),
          [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),
          "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
foreach ($d in $dirs) { if ($d -and (Test-Path $d)) {
  Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -Depth 3 | ForEach-Object {
    $l = $sh.CreateShortcut($_.FullName)
    if ($l.TargetPath) { $out.lnk += @{ name = $_.BaseName; target = $l.TargetPath; cwd = $l.WorkingDirectory; args = $l.Arguments } }
  } } }
foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') {
  Get-ItemProperty $k | Where-Object { $_.DisplayName -match 'DeepSeek|DSH|Harness' } | ForEach-Object {
    $out.reg += @{ name = $_.DisplayName; loc = $_.InstallLocation; icon = $_.DisplayIcon; uninst = $_.UninstallString } } }
foreach ($scope in 'User','Machine') { $v = [Environment]::GetEnvironmentVariable('DSH_HOME', $scope); if ($v) { $out.env += $v } }
$out | ConvertTo-Json -Depth 4 -Compress
`

function windowsProbe() {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROBE],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 << 20 })
    const j = JSON.parse(raw || '{}')
    const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])
    return { lnk: arr(j.lnk), reg: arr(j.reg), env: arr(j.env) }
  } catch { return { lnk: [], reg: [], env: [] } }
}

/** 从一个可执行文件 / 目录出发，往上 3 层找 <层>\data 或 <层> 本身。 */
function homesNear(p) {
  const out = []
  if (!p) return out
  let d = String(p).replace(/^"|"(\s.*)?$/g, '').replace(/,\d+$/, '')
  try { if (existsSync(d) && !statSync(d).isDirectory()) d = dirname(d) } catch { return out }
  for (let i = 0; i < 4 && d; i++) {
    for (const c of [join(d, 'data'), d]) if (isDshHome(c)) out.push(c)
    const up = dirname(d); if (up === d) break; d = up
  }
  return out
}

/** 快捷方式里只看和 DSH 沾边的（名字、目标、参数、工作目录任一命中），避免把每个程序都翻一遍。 */
const DSH_HINT = /deepseek|dsh|harness/i
export function homesFromProbe(probe) {
  const out = []
  for (const v of probe.env) out.push(...homesNear(v))
  for (const r of probe.reg) for (const p of [r.loc, r.icon, r.uninst]) out.push(...homesNear(p))
  for (const l of probe.lnk) {
    if (![l.name, l.target, l.args, l.cwd].some((s) => DSH_HINT.test(s ?? ''))) continue
    for (const p of [l.cwd, l.target]) out.push(...homesNear(p))
    const m = /DSH_HOME=("?)([^"&]+)\1/i.exec(l.args ?? ''); if (m) out.push(...homesNear(m[2]))
  }
  return out
}

// ---------- 泛扫各盘 ----------
const SKIP_DIR = /^(\$.*|windows|system volume information|recovery|perflogs|msocache|config\.msi|node_modules|\.git|appdata|winsxs|programdata|intel|amd|nvidia)$/i

/** 广度优先扫 root 下 depth 层，返回每个 <目录>\data（或目录本身）是 DSH 数据目录的位置。超时即停。 */
export function scanRoots(roots, { depth = 3, budgetMs = 4000 } = {}) {
  const found = []
  const deadline = Date.now() + budgetMs
  let queue = roots.filter((r) => existsSync(r)).map((r) => [r, 0])
  while (queue.length && Date.now() < deadline) {
    const next = []
    for (const [dir, lvl] of queue) {
      if (Date.now() > deadline) break
      let ents
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      if (lvl > 0 && ents.some((e) => e.isDirectory() && e.name.toLowerCase() === 'data') && isDshHome(join(dir, 'data'))) found.push(join(dir, 'data'))
      if (lvl > 0 && isDshHome(dir)) found.push(dir)
      if (lvl >= depth) continue
      for (const e of ents) if (e.isDirectory() && !SKIP_DIR.test(e.name)) next.push([join(dir, e.name), lvl + 1])
    }
    queue = next
  }
  return found
}

export function windowsDrives() {
  const out = []
  for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${c}:\\`)) out.push(`${c}:\\`)
  return out
}

/**
 * 返回 [{ path, via }]，去重、按上面的优先级排序。
 * opts 主要给测试用：env、appDir、configDir、probe（替代 PowerShell）、scanRoots、platform。
 */
export function findHomes(explicit, opts = {}) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const found = []
  const seen = new Set()
  const key = (p) => (platform === 'win32' ? p.toLowerCase() : p)
  const add = (p, via, strict = true) => {
    if (!p) return
    const r = resolve(p)
    if (seen.has(key(r))) return
    if (!(strict ? isDshHome(r) : looksLikeHome(r))) return
    seen.add(key(r)); found.push({ path: r, via })
  }

  if (explicit) {
    const h = normalizeHome(explicit)
    return h ? [{ path: h, via: '--home' }] : []
  }
  if (env.DSH_HOME) add(normalizeHome(env.DSH_HOME) ?? env.DSH_HOME, '环境变量 DSH_HOME', false)
  for (let d = opts.appDir ?? APP_DIR; ; d = dirname(d)) {
    add(join(d, 'data'), 'dsm 所在目录'); add(d, 'dsm 所在目录')
    if (dirname(d) === d) break
  }
  for (const h of readConfig(opts.configDir ?? configDir(env)).homes ?? []) add(h, '上次使用', false)
  add(join(opts.home ?? homedir(), '.dsh'), '默认位置 ~/.dsh', false)
  // 便宜的几步已经找到就先用；找不到或用户要求（deep）才查快捷方式、注册表、扫盘
  if (found.length && !opts.deep) return found
  if (platform === 'win32' || opts.probe) {
    const probe = opts.probe ?? windowsProbe()
    for (const h of homesFromProbe(probe)) add(h, '快捷方式 / 注册表')
  }
  const roots = opts.scanRoots ?? (platform === 'win32' ? windowsDrives() : [])
  if (roots.length && opts.scan !== false) for (const h of scanRoots(roots, opts)) add(h, '磁盘扫描')
  return found
}
