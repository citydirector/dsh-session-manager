/**
 * 运行形态：源码（node bin/dsm.mjs）或打包好的单文件 dsm.exe（Node SEA）。
 * 打包形态下 process.execPath 是 dsm.exe 本身，不能拿来跑别的 .mjs。
 */
import { dirname, resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as sea from 'node:sea'

export const IS_SEA = (() => { try { return sea.isSea() } catch { return false } })()

/** 工具所在目录：exe 所在目录，或源码仓库根目录。 */
export const APP_DIR = IS_SEA ? dirname(process.execPath)
  // eslint-disable-next-line no-undef -- 打包成 CJS 后 import.meta 为空，用 __dirname
  : import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : resolve(__dirname, '..')

/** 子进程用的 node：源码形态就是自己；打包形态要另找（DSH 自带的优先，其次 PATH）。 */
export function childNode(preferred = []) {
  for (const p of preferred) if (p && existsSync(p)) return p
  if (!IS_SEA) return process.execPath
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const hit = execFileSync(cmd, ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean)
    if (hit && existsSync(hit.trim())) return hit.trim()
  } catch { /* 没有 */ }
  return undefined
}
