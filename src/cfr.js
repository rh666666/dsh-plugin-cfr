/**
 * cfr 调用层：解析 java 入口、维护反编译缓存、执行全量与单类反编译。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const GRACE_MS = 5000
const COLLECT_BYTES = 64 * 1024
const SPILL_BYTES = 1024 * 1024
const SINGLE_CLASS_BYTES = 4 * 1024 * 1024

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ cacheDir: string, javaPath: string, cfrJar: string }} config
 */
export function createCfr(ctx, config) {
  /** 每个缓存目录下已扫描出的 Java 源码路径。 */
  const listings = new Map()
  /** 同一 jar 的并发反编译只跑一次。 */
  const inflight = new Map()
  let javaExecutable

  async function javaCommand(signal) {
    if (!javaExecutable) {
      javaExecutable = ctx.subprocess.resolveExecutable(config.javaPath, undefined, signal)
    }
    try {
      return await javaExecutable
    } catch (error) {
      javaExecutable = undefined
      throw error
    }
  }

  /**
   * cfr 的启动 argv：始终用 java 直接拉起 cfr.jar，不经过任何命令行包装。
   * @param {readonly string[]} args
   * @param {AbortSignal} [signal]
   */
  async function cfrArgv(args, signal) {
    if (!config.cfrJar) {
      throw new Error('没有配置 cfrJar：请在插件配置里给出 cfr.jar 的绝对路径。')
    }
    return [await javaCommand(signal), '-jar', config.cfrJar, ...args]
  }

  /**
   * 运行一次子进程并回收输出；非零退出码属于正常返回。
   */
  async function run(argv, { cwd, signal, maxBytes = COLLECT_BYTES, spill = true }) {
    const stdio = {
      stdin: 'ignore',
      stdout: { maxBytes, ...(spill ? { spill: { maxBytes: SPILL_BYTES } } : {}) },
      stderr: { maxBytes, ...(spill ? { spill: { maxBytes: SPILL_BYTES } } : {}) },
    }
    const handle = ctx.subprocess.spawn({ argv, cwd, stdio, graceMs: GRACE_MS, signal })
    const outcome = await handle.done
    const stdout = readCollected(handle.collected.stdout)
    const stderr = readCollected(handle.collected.stderr)
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal ?? undefined,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.lossy || stderr.lossy,
      spillPath: stdout.spillPath ?? stderr.spillPath,
    }
  }

  /**
   * 反编译整个 jar 到缓存目录；已完成过的缓存直接复用。
   * @param {string} jarPath 已解析的 jar 绝对路径
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ outDir: string, classCount: number, cached: boolean }>}
   */
  async function decompile(jarPath, signal) {
    const jar = resolve(jarPath)
    const info = await stat(jar)
    if (!info.isFile()) throw new Error(`不是文件：${jar}`)
    const dir = cacheDirectory(jar, info)
    const outDir = join(dir, 'sources')
    const marker = join(dir, 'done.json')
    const done = await readMarker(marker)
    if (done) return { outDir, classCount: done.classCount, cached: true }
    const running = inflight.get(dir)
    if (running) return running
    const task = compile(jar, dir, outDir, marker, info, signal).finally(() => inflight.delete(dir))
    inflight.set(dir, task)
    return task
  }

  async function compile(jar, dir, outDir, marker, info, signal) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    listings.delete(outDir)
    const argv = await cfrArgv([jar, '--outputdir', outDir], signal)
    const result = await run(argv, { cwd: dirname(jar), signal })
    if (result.exitCode !== 0) {
      throw new Error(`cfr 退出码 ${result.exitCode}：${tail(result.stderr || result.stdout)}`)
    }
    const classCount = (await listJavaFiles(outDir)).length
    if (classCount === 0) {
      throw new Error(`cfr 没有产出源码，输入可能不是 jar：${tail(result.stderr || result.stdout)}`)
    }
    const record = { jar, classCount, size: info.size, createdAt: new Date().toISOString() }
    await writeFile(marker, JSON.stringify(record), 'utf8')
    return { outDir, classCount, cached: false }
  }

  /**
   * 读取一个类的源码：缓存优先，缺失时即时单类反编译并写入部分缓存。
   * @param {string} jarPath jar 绝对路径
   * @param {string} className 全限定名、内部名或短名
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ status: 'ok', source: string, path: string, cached: boolean }
   *   | { status: 'ambiguous', candidates: string[] }
   *   | { status: 'missing' }>}
   */
  async function readClass(jarPath, className, signal) {
    const jar = resolve(jarPath)
    const info = await stat(jar)
    const dir = cacheDirectory(jar, info)
    const found = await findClass(dir, className)
    if (found) return found
    const source = await decompileSingle(jar, className, signal)
    if (source === undefined) return { status: 'missing' }
    const relative = `${normalizeClassPath(className)}.java`
    const target = join(dir, 'partial', ...relative.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source, 'utf8')
    listings.delete(join(dir, 'partial'))
    return { status: 'ok', source, path: relative, cached: false }
  }

  /**
   * 在缓存与部分缓存里查找一个类。
   */
  async function findClass(dir, className) {
    const relative = normalizeClassPath(className)
    if (!relative) return undefined
    const target = `${relative}.java`
    const roots = [join(dir, 'sources'), join(dir, 'partial')].filter((root) => existsSync(root))
    for (const root of roots) {
      if ((await listJavaFiles(root)).includes(target)) {
        return { status: 'ok', source: await readFile(join(root, target), 'utf8'), path: target, cached: true }
      }
    }
    const short = `${relative.split('/').pop().toLowerCase()}.java`
    const named = []
    const fuzzy = []
    for (const root of roots) {
      for (const file of await listJavaFiles(root)) {
        const base = file.split('/').pop().toLowerCase()
        if (base === short) named.push({ root, file })
        else if (base.includes(short.replace(/\.java$/u, ''))) fuzzy.push({ root, file })
      }
    }
    const pool = named.length > 0 ? named : fuzzy
    if (pool.length === 1) {
      const [{ root, file }] = pool
      return { status: 'ok', source: await readFile(join(root, file), 'utf8'), path: file, cached: true }
    }
    if (pool.length > 1) {
      return { status: 'ambiguous', candidates: pool.slice(0, 20).map((entry) => entry.file) }
    }
    return undefined
  }

  /**
   * 只反编译一个类，源码直接来自 cfr 的标准输出。
   */
  async function decompileSingle(jar, className, signal) {
    const argv = await cfrArgv(
      [jar, normalizeClassPath(className).replace(/\//gu, '.')],
      signal,
    )
    const result = await run(argv, {
      cwd: dirname(jar),
      signal,
      maxBytes: SINGLE_CLASS_BYTES,
      spill: false,
    })
    if (result.exitCode !== 0) return undefined
    if (result.truncated) {
      throw new Error(`单类源码超过 ${SINGLE_CLASS_BYTES} 字节，改为先用 jar_decompile 反编译整个 jar。`)
    }
    const source = result.stdout.trim()
    return source ? `${source}\n` : undefined
  }

  /**
   * 缓存目录里的全部 Java 源码相对路径。
   */
  async function listJavaFiles(root) {
    const cached = listings.get(root)
    if (cached) return cached
    const files = []
    const stack = ['']
    while (stack.length > 0) {
      const relative = stack.pop()
      const entries = await readdir(join(root, relative), { withFileTypes: true })
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) stack.push(child)
        else if (entry.name.endsWith('.java')) files.push(child)
      }
    }
    listings.set(root, files)
    return files
  }

  /**
   * 缓存目录按 jar 路径与内容指纹区分，jar 更新后自动落到新目录。
   */
  function cacheDirectory(jar, info) {
    const digest = createHash('sha1')
      .update(`${jar}|${info.size}|${info.mtimeMs}`)
      .digest('hex')
      .slice(0, 12)
    const stem = basename(jar).replace(/[^\w.-]+/gu, '_')
    return join(config.cacheDir, `${stem}-${digest}`)
  }

  return { decompile, readClass }
}

async function readMarker(marker) {
  try {
    const parsed = JSON.parse(await readFile(marker, 'utf8'))
    return Number.isInteger(parsed?.classCount) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readCollected(reader) {
  if (!reader) return { text: '', lossy: false, spillPath: undefined }
  const read = reader.readFrom(0)
  return { text: read.text, lossy: read.lossy, spillPath: read.spillPath }
}

/**
 * 类名统一成源码相对路径形式：`com.foo.Bar` 与 `com/foo/Bar` 都得到 `com/foo/Bar`。
 */
function normalizeClassPath(className) {
  const trimmed = className.trim().replace(/\\/gu, '/').replace(/\.java$/iu, '')
  if (trimmed.includes('/')) return trimmed
  return trimmed.replace(/\./gu, '/')
}

function tail(text) {
  return text.trim().slice(-2000)
}
