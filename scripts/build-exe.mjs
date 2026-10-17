#!/usr/bin/env node
/**
 * 打包单文件 dsm.exe（Node SEA）：
 *   node scripts/build-exe.mjs [官方 Windows node.exe 路径]
 * 需要：与本机相同版本的 Windows x64 node.exe（不给就从 nodejs.org 下载），npx 可用（esbuild、postject）。
 * 输出：dist/dsm.exe
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' })

// 1. 打成单个 CommonJS 文件（Node 22 的 SEA 只认 CJS）
run('npx', ['--yes', 'esbuild@0.28.2', 'bin/dsm.mjs', '--bundle', '--platform=node', '--target=node22',
  '--format=cjs', '--outfile=dist/dsm.cjs', '--log-level=warning'])

// 2. SEA blob（关掉 snapshot / code cache，blob 才能跨平台生成）
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify({
  main: 'dist/dsm.cjs', output: 'dist/dsm.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}))
run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'])

// 3. 注入到官方 Windows node.exe
let base = process.argv[2]
if (!base) {
  base = process.platform === 'win32' ? process.execPath : join(dist, `node-${process.version}-win-x64.exe`)
  if (!existsSync(base)) run('curl', ['-sSfL', '-o', base, `https://nodejs.org/dist/${process.version}/win-x64/node.exe`])
}
const out = join(dist, 'dsm.exe')
copyFileSync(base, out)
run('npx', ['--yes', 'postject@1.0.0-alpha.6', out, 'NODE_SEA_BLOB', 'dist/dsm.blob',
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])
console.log(`\n完成：${out}`)
