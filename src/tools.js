/**
 * 模型可调用的 jar 工具定义。
 */

import { isAbsolute, resolve } from 'node:path'

const DEFAULT_READ_LIMIT = 400
const MAX_READ_LIMIT = 2000
const DEFAULT_MAX_MATCHES = 80
const MAX_MAX_MATCHES = 500
const DECOMPILE_TIMEOUT_MS = 900_000
const READ_TIMEOUT_MS = 120_000

/**
 * 注册 jar_decompile、jar_search、jar_read 三个工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ cfr: ReturnType<typeof import('./cfr.js').createCfr>, rg: ReturnType<typeof import('./rg.js').createRg> }} deps
 * @returns {() => void} 注销函数
 */
export function registerJarTools(ctx, { cfr, rg }) {
  const disposers = [
    ctx.tools.register(decompileTool(cfr)),
    ctx.tools.register(searchTool(cfr, rg)),
    ctx.tools.register(readTool(cfr)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function decompileTool(cfr) {
  return {
    name: 'jar_decompile',
    description: '把一个 jar 反编译成 Java 源码并缓存到本地目录，返回缓存目录。'
      + '同一个 jar 只会真正反编译一次，之后命中缓存直接返回。'
      + '需要在整个 jar 内检索时用它预热，或直接调用 jar_search（会自动确保已反编译）。',
    parameters: {
      type: 'object',
      properties: {
        jar: {
          type: 'string',
          description: 'jar 文件路径；相对路径按当前会话工作目录解析。',
        },
      },
      required: ['jar'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否成功' },
          jar: { type: 'string', description: '调用时传入的 jar' },
          outDir: { type: 'string', description: '缓存里的源码目录' },
          classCount: { type: 'number', description: '产出的 Java 文件数' },
          cached: { type: 'boolean', description: '是否直接复用已有缓存' },
          text: { type: 'string', description: '给模型读的正文' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '(无输出)') }],
    },
    timeoutMs: DECOMPILE_TIMEOUT_MS,
    async execute(args, exec) {
      const jar = requireString(args, 'jar')
      if (!jar) return failure('jar 必须是非空字符串路径。')
      const jarPath = resolveFrom(sessionCwd(exec), jar)
      try {
        const result = await cfr.decompile(jarPath, exec.signal)
        return {
          ok: true,
          jar,
          outDir: result.outDir,
          classCount: result.classCount,
          cached: result.cached,
          text: [
            `${result.cached ? '缓存已存在' : '反编译完成'}：${jar}`,
            `输出目录：${result.outDir}`,
            `Java 文件：${result.classCount}`,
            '后续用 jar_search 检索源码，或用 jar_read 读取单个类。',
          ].join('\n'),
        }
      } catch (error) {
        return failure(`反编译失败：${messageOf(error)}`)
      }
    },
  }
}

function searchTool(cfr, rg) {
  return {
    name: 'jar_search',
    description: '在 jar 的反编译源码里用 ripgrep 做正则检索，返回 `文件:行号:内容`。'
      + 'jar 尚未反编译时会自动先反编译。适合定位类、方法、字符串常量与调用点。'
      + '用 glob 可以只搜某些包，例如 `**/util/*.java`。',
    parameters: {
      type: 'object',
      properties: {
        jar: {
          type: 'string',
          description: 'jar 文件路径；相对路径按当前会话工作目录解析。',
        },
        pattern: {
          type: 'string',
          description: 'ripgrep 正则表达式。',
        },
        glob: {
          type: 'string',
          description: '限定路径的 glob，例如 `**/service/*.java`。',
        },
        ignoreCase: {
          type: 'boolean',
          description: '是否忽略大小写。',
        },
        maxMatches: {
          type: 'number',
          description: `最多返回多少处匹配，默认 ${DEFAULT_MAX_MATCHES}，上限 ${MAX_MAX_MATCHES}。`,
        },
      },
      required: ['jar', 'pattern'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否成功' },
          jar: { type: 'string', description: '调用时传入的 jar' },
          total: { type: 'number', description: '匹配总数' },
          shown: { type: 'number', description: '实际返回的匹配数' },
          truncated: { type: 'boolean', description: '结果是否被截断' },
          text: { type: 'string', description: '给模型读的正文' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '(无输出)') }],
    },
    timeoutMs: DECOMPILE_TIMEOUT_MS,
    async execute(args, exec) {
      const jar = requireString(args, 'jar')
      const pattern = requireString(args, 'pattern')
      if (!jar) return failure('jar 必须是非空字符串路径。')
      if (!pattern) return failure('pattern 必须是非空正则表达式。')
      const jarPath = resolveFrom(sessionCwd(exec), jar)
      const glob = optionalString(args, 'glob')
      try {
        const compiled = await cfr.decompile(jarPath, exec.signal)
        const result = await rg.search({
          dir: compiled.outDir,
          pattern,
          glob,
          ignoreCase: args?.ignoreCase === true,
          signal: exec.signal,
        })
        const maxMatches = clampInt(args?.maxMatches, 1, MAX_MAX_MATCHES, DEFAULT_MAX_MATCHES)
        const shown = result.matches.slice(0, maxMatches)
        const total = result.matches.length
        const lines = [total === 0
          ? `没有匹配：${pattern}`
          : `在 ${jar} 里匹配到 ${total} 处${total > shown.length ? `（显示前 ${shown.length} 处）` : ''}：`]
        for (const match of shown) {
          lines.push(`${match.path}:${match.line}:${match.text}`)
        }
        return {
          ok: true,
          jar,
          total,
          shown: shown.length,
          truncated: result.truncated || total > shown.length,
          text: lines.join('\n'),
        }
      } catch (error) {
        return failure(`检索失败：${messageOf(error)}`)
      }
    },
  }
}

function readTool(cfr) {
  return {
    name: 'jar_read',
    description: '读取 jar 里一个类的反编译源码，按行返回。'
      + '类名可以写全限定名 `com.foo.Bar`、内部名 `com/foo/Bar` 或短名 `Bar`；短名有多个候选时会列出候选。'
      + '缓存里没有该类时会即时反编译这一个类。大文件用 offset 与 limit 翻页。',
    parameters: {
      type: 'object',
      properties: {
        jar: {
          type: 'string',
          description: 'jar 文件路径；相对路径按当前会话工作目录解析。',
        },
        className: {
          type: 'string',
          description: '类名，支持全限定名、内部名或短名。',
        },
        offset: {
          type: 'number',
          description: '起始行，1 基，默认 1。',
        },
        limit: {
          type: 'number',
          description: `读取行数，默认 ${DEFAULT_READ_LIMIT}，上限 ${MAX_READ_LIMIT}。`,
        },
      },
      required: ['jar', 'className'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否成功' },
          jar: { type: 'string', description: '调用时传入的 jar' },
          path: { type: 'string', description: '源码相对路径' },
          totalLines: { type: 'number', description: '源码总行数' },
          startLine: { type: 'number', description: '本次返回的起始行' },
          text: { type: 'string', description: '给模型读的正文' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '(无输出)') }],
    },
    timeoutMs: READ_TIMEOUT_MS,
    async execute(args, exec) {
      const jar = requireString(args, 'jar')
      const className = requireString(args, 'className')
      if (!jar) return failure('jar 必须是非空字符串路径。')
      if (!className) return failure('className 必须是非空类名。')
      const jarPath = resolveFrom(sessionCwd(exec), jar)
      const offset = clampInt(args?.offset, 1, Number.MAX_SAFE_INTEGER, 1)
      const limit = clampInt(args?.limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT)
      try {
        const result = await cfr.readClass(jarPath, className, exec.signal)
        if (result.status === 'ambiguous') {
          return failure(`类名有多个候选，请改用完整类名：\n${result.candidates.join('\n')}`)
        }
        if (result.status === 'missing') {
          return failure(`没有找到类 ${className}：jar 内可能不存在该类，或类名写法有误。`)
        }
        const lines = result.source.split(/\r?\n/u)
        const total = lines.length
        const start = Math.min(offset, total)
        const end = Math.min(total, start + limit - 1)
        const body = lines
          .slice(start - 1, end)
          .map((line, index) => `${String(start + index).padStart(4, ' ')}  ${line}`)
          .join('\n')
        const remaining = total - end
        return {
          ok: true,
          jar,
          path: result.path,
          totalLines: total,
          startLine: start,
          text: [
            `${result.path}（共 ${total} 行，显示 ${start}-${end}）`,
            body,
            remaining > 0 ? `\n还有 ${remaining} 行，可增大 offset 继续读。` : '',
          ].filter(Boolean).join('\n'),
        }
      } catch (error) {
        return failure(`读取失败：${messageOf(error)}`)
      }
    },
  }
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : process.cwd()
}

function resolveFrom(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function requireString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

function optionalString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function failure(text) {
  return { ok: false, text }
}

function messageOf(error) {
  return String(error?.message ?? error)
}
