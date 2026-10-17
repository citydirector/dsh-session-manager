/**
 * 纯函数检测器：不依赖任何 @deepseek-ai/* 包，插件和离线扫描脚本共用同一份判定。
 *
 * 两条规则，都在流内逐段运行，并且都能给出「循环从哪里开始」的精确位置，
 * 这是本插件能把循环从落盘内容里剪掉的前提：
 *
 * - **短句池轮转（pool）**：最近 N 个句子几乎全由少数几个反复出现的短句组成，
 *   例如 `Now. / OK. / Enough. / Let me write. / Emit. / Producing.`。
 *   这是 DeepSeek 退化时最常见的形态，逐字周期检测抓不到，因为轮转顺序会变。
 * - **逐字周期（cycle）**：尾部是一段文字的逐字重复（段落、长句、代码块被原样
 *   刷屏）。用尾部指纹的历史出现位置当候选周期，代价与流长度无关。
 *
 * 句子切分：句末标点（. ! ? 。！？…）后接空白，或换行。纯符号句子（表格分隔线、
 * `}`、`---`）不计入统计，也不打断循环段，避免把表格、日志、代码误判成循环。
 * 正文模式下 ``` 代码块内部完全跳过。
 *
 * @module dsh-loop-rescue/detector
 */

/** 默认阈值。按「宁可晚切一点，也不误伤正常输出」标定。 */
export const DEFAULTS = Object.freeze({
  /** 短句池：参与判定的最近句子数。 */
  poolWindow: 30,
  /** 短句池：窗口内句子的平均长度上限（字符）。 */
  poolMaxMeanChars: 60,
  /** 短句池：窗口内总长度下限（汉字按 3 计），太短不判。 */
  poolMinChars: 120,
  /** 短句池：一个句子在窗口内出现几次才算「反复出现」。 */
  poolMinRepeats: 3,
  /** 短句池：反复出现的句子占窗口的比例下限。 */
  poolMinCoverage: 0.75,
  /** 回溯循环起点时，允许夹杂的连续新句子数。 */
  poolGapAllowance: 2,
  /** 逐字周期：最短周期（字符）。 */
  cycleMinPeriod: 16,
  /** 逐字周期：最长周期（字符）。 */
  cycleMaxPeriod: 4000,
  /** 逐字周期：重复部分总长下限（字符）。 */
  cycleMinChars: 600,
  /** 逐字周期：至少重复几遍。 */
  cycleMinReps: 3,
  /** 逐字周期：每新增多少字符检查一次。 */
  cycleCheckEvery: 128,
})

const ASCII_TERMINATOR = /[.!?]/
const CJK_TERMINATOR = /[。！？…]/
const HAS_WORD = /[\p{L}\p{N}]/u
/** 正文里的列表项、表格行、引用行：结构化内容，天然重复，不计入短句池。 */
const STRUCTURED_LINE = /^(?:[-*+|>]|\d+[.)])\s?/

/**
 * 把句子规范成比较用的键：小写、合并空白、去掉首尾标点。
 * 数字保留原样：编号不同的行（表格、清单）本来就不是同一句话。
 * @param {string} s
 * @returns {string}
 */
export function normalizeUnit(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
}

/**
 * 长度估算：CJK 字符信息密度高，按 3 个字符计，使中英文阈值大致可比。
 * @param {string} s
 * @returns {number}
 */
export function weightedLength(s) {
  let n = 0
  for (const ch of s) n += /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 3 : 1
  return n
}

/**
 * @typedef {object} Detection
 * @property {'pool' | 'cycle'} rule 命中的规则
 * @property {number} cut 循环起点（在累计文本里的 UTF-16 下标），保留 `text.slice(0, cut)`
 * @property {number} repeatedChars 被判为循环的字符数（`text.length - cut`）
 * @property {number} [period] 逐字周期的周期长度
 * @property {string[]} [pool] 短句池里的句子（规范化后）
 */

/**
 * 单个 block（一段推理或一段正文）的流式循环检测器。
 */
export class StreamLoopDetector {
  /**
   * @param {'reasoning' | 'text'} kind 推理还是正文；正文会跳过代码块
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(kind, options = {}) {
    this.kind = kind
    this.o = { ...DEFAULTS, ...options }
    /** 累计文本。 */
    this.text = ''
    /** @type {{start: number, end: number, key: string}[]} 已切出的计数句子 */
    this.units = []
    this.unitStart = 0
    this.inFence = false
    this.lastCycleCheck = 0
    /** @type {Detection | undefined} */
    this.detection = undefined
  }

  /**
   * 追加一段增量。返回第一次命中的检测结果；命中后不再变化。
   * @param {string} delta
   * @returns {Detection | undefined}
   */
  push(delta) {
    if (this.detection !== undefined || delta.length === 0) return this.detection
    const from = this.text.length
    this.text += delta
    for (let i = from; i < this.text.length; i++) {
      const ch = this.text[i]
      const next = this.text[i + 1]
      const atLineEnd = ch === '\n'
      // 中文句末标点直接切；英文标点后面跟空白才切（避免切开 1.5、a.b），
      // 流尾的英文标点等下一段增量再说。
      const atSentenceEnd = CJK_TERMINATOR.test(ch)
        || (ASCII_TERMINATOR.test(ch) && next !== undefined && /\s/.test(next))
      if (atLineEnd || atSentenceEnd) {
        this.closeUnit(i + 1)
        if (this.detection !== undefined) return this.detection
      }
    }
    if (this.text.length - this.lastCycleCheck >= this.o.cycleCheckEvery) {
      this.lastCycleCheck = this.text.length
      const hit = this.checkCycle()
      if (hit !== undefined) this.detection = hit
    }
    return this.detection
  }

  /** @param {number} end */
  closeUnit(end) {
    const raw = this.text.slice(this.unitStart, end)
    const start = this.unitStart
    this.unitStart = end
    const trimmed = raw.trim()
    if (this.kind === 'text' && trimmed.startsWith('```')) {
      this.inFence = !this.inFence
      this.units = []
      return
    }
    if (this.inFence) return
    if (!HAS_WORD.test(trimmed)) return // 纯符号：中性，不计也不断
    if (this.kind === 'text' && STRUCTURED_LINE.test(trimmed)) return // 列表/表格：中性
    this.units.push({ start: start + raw.indexOf(trimmed), end, key: normalizeUnit(trimmed) })
    if (this.units.length > this.o.poolWindow * 4) this.units.splice(0, this.units.length - this.o.poolWindow * 4)
    const hit = this.checkPool()
    if (hit !== undefined) this.detection = hit
  }

  /** @returns {Detection | undefined} */
  checkPool() {
    const o = this.o
    if (this.units.length < o.poolWindow) return undefined
    const win = this.units.slice(-o.poolWindow)
    let chars = 0
    const counts = new Map()
    for (const u of win) {
      chars += weightedLength(u.key)
      counts.set(u.key, (counts.get(u.key) ?? 0) + 1)
    }
    if (chars < o.poolMinChars) return undefined
    if (chars / win.length > o.poolMaxMeanChars) return undefined
    const pool = new Set([...counts].filter(([, n]) => n >= o.poolMinRepeats).map(([k]) => k))
    // 只有一个句子在刷屏属于逐字周期的范畴，这里要求至少两种句子在轮转。
    if (pool.size < 2) return undefined
    let covered = 0
    for (const u of win) if (pool.has(u.key)) covered++
    if (covered / win.length < o.poolMinCoverage) return undefined

    // 回溯：从尾部往前走，经过池内句子，允许夹杂少量新句子。
    let first = this.units.length - 1
    let gap = 0
    for (let i = this.units.length - 1; i >= 0; i--) {
      if (pool.has(this.units[i].key)) {
        first = i
        gap = 0
      } else if (++gap > o.poolGapAllowance) break
    }
    const cut = this.units[first].start
    return { rule: 'pool', cut, repeatedChars: this.text.length - cut, pool: [...pool] }
  }

  /** @returns {Detection | undefined} */
  checkCycle() {
    const o = this.o
    const s = this.text
    const n = s.length
    if (n < o.cycleMinChars) return undefined
    // 正文里代码块内部的重复（生成数据、样例）不归本规则管。
    if (this.kind === 'text' && this.inFence) return undefined
    const probe = Math.min(32, o.cycleMinPeriod)
    const tail = s.slice(n - probe)
    const windowStart = Math.max(0, n - o.cycleMaxPeriod - probe)
    // 尾部指纹在之前出现的位置 → 候选周期。取最近的几个。
    const candidates = []
    let at = n - probe - 1
    while (candidates.length < 6) {
      const idx = s.lastIndexOf(tail, at)
      if (idx < windowStart || idx < 0) break
      const period = n - probe - idx
      if (period >= o.cycleMinPeriod) candidates.push(period)
      at = idx - 1
    }
    for (const p of candidates) {
      // 从尾部往前数，s[i] === s[i + p] 连续成立的长度。
      let i = n - 1 - p
      while (i >= 0 && s[i] === s[i + p]) i--
      const runStart = i + 1 // [runStart, n) 以周期 p 自重复
      const span = n - runStart
      const reps = span / p + 1
      if (span + p < o.cycleMinChars || reps < o.cycleMinReps) continue
      // 第一份拷贝本身可能是正常内容，保留它，从第二份起剪。
      // 周期回溯会多吃掉前文里恰好相同的几个字符（如 ".\n"），把切点吸附到下一个换行之后。
      let cut = Math.min(n, runStart + p)
      const nl = s.indexOf('\n', cut - 1)
      if (nl !== -1 && nl - cut < Math.min(p, 120)) cut = nl + 1
      return { rule: 'cycle', cut, repeatedChars: n - cut, period: p }
    }
    return undefined
  }

  /**
   * 流结束后的最终检查（尾部不足 cycleCheckEvery 的部分也查一遍，并把未闭合的最后一句计入）。
   * @returns {Detection | undefined}
   */
  finish() {
    if (this.detection !== undefined) return this.detection
    if (this.unitStart < this.text.length) this.closeUnit(this.text.length)
    if (this.detection === undefined) this.detection = this.checkCycle()
    return this.detection
  }
}

/**
 * 对一段完整文本跑一遍检测（离线扫描与测试用）。
 * @param {'reasoning' | 'text'} kind
 * @param {string} text
 * @param {Partial<typeof DEFAULTS>} [options]
 * @param {number} [chunk] 模拟流的切片大小
 * @returns {Detection | undefined}
 */
export function detectInText(kind, text, options, chunk = 24) {
  const d = new StreamLoopDetector(kind, options)
  for (let i = 0; i < text.length; i += chunk) {
    if (d.push(text.slice(i, i + chunk)) !== undefined) return d.detection
  }
  return d.finish()
}
