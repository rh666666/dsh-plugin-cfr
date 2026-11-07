/**
 * ripgrep 调用层：在反编译源码目录里检索。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const GRACE_MS = 5000
const COLLECT_BYTES = 512 * 1024
const SPILL_BYTES = 2 * 1024 * 1024
const FALLBACK_COMMAND = 'rg'

/**
 * @vscode/ripgrep 随包安装的 rg；依赖缺失时返回 undefined。
 */
function bundledRg() {
  try {
    const { rgPath } = require('@vscode/ripgrep')
    return typeof rgPath === 'string' ? rgPath : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ rgPath: string }} config
 */
export function createRg(ctx, config) {
  let rgExecutable

  async function rgCommand(signal) {
    if (!rgExecutable) {
      const command = config.rgPath || bundledRg() || FALLBACK_COMMAND
      rgExecutable = ctx.subprocess.resolveExecutable(command, undefined, signal)
    }
    try {
      return await rgExecutable
    } catch (error) {
      rgExecutable = undefined
      throw error
    }
  }

  /**
   * 在目录里按正则检索，返回逐行匹配。
   * @param {{ dir: string, pattern: string, glob?: string, ignoreCase?: boolean, signal?: AbortSignal }} request
   * @returns {Promise<{ matches: Array<{ path: string, line: number, text: string }>, truncated: boolean }>}
   */
  async function search({ dir, pattern, glob, ignoreCase, signal }) {
    const rg = await rgCommand(signal)
    const argv = [
      rg,
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--color=never',
      '--no-config',
      '-e',
      pattern,
    ]
    if (ignoreCase) argv.push('--ignore-case')
    if (glob) argv.push('--glob', glob)
    const stdio = {
      stdin: 'ignore',
      stdout: { maxBytes: COLLECT_BYTES, spill: { maxBytes: SPILL_BYTES } },
      stderr: { maxBytes: COLLECT_BYTES, spill: { maxBytes: SPILL_BYTES } },
    }
    const handle = ctx.subprocess.spawn({ argv, cwd: dir, stdio, graceMs: GRACE_MS, signal })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false }
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      throw new Error(`rg 退出码 ${outcome.exitCode}：${stderr.text.trim().slice(0, 1000)}`)
    }
    return { matches: parseMatches(stdout.text), truncated: stdout.lossy }
  }

  return { search }
}

/**
 * 解析 `path:line:text` 形式的匹配行；路径已相对检索目录。
 */
function parseMatches(text) {
  const matches = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue
    const first = line.indexOf(':')
    if (first <= 0) continue
    const second = line.indexOf(':', first + 1)
    if (second < 0) continue
    const lineNumber = Number(line.slice(first + 1, second))
    if (!Number.isInteger(lineNumber)) continue
    matches.push({
      path: line.slice(0, first).replace(/\\/gu, '/'),
      line: lineNumber,
      text: line.slice(second + 1),
    })
  }
  return matches
}
