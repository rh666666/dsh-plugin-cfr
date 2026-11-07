/**
 * 插件配置的默认值与规范化。
 *
 * 配置来自 Loader 行的 `config`；缺失字段一律回退默认值。
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 随包分发的 cfr.jar。 */
export const BUNDLED_CFR = join(PACKAGE_ROOT, 'vendor', 'cfr.jar')

/** 配置缺省值。 */
export const DEFAULT_CONFIG = Object.freeze({
  cacheDir: '',
  javaPath: 'java',
  cfrJar: BUNDLED_CFR,
  rgPath: '',
})

/**
 * DSH 数据根目录。
 * @returns {string}
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured || join(homedir(), '.dsh')
}

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/**
 * 把原始配置规范化成插件内部使用的完整配置。
 * @param {Record<string, unknown>} [raw] Loader 行传入的 config
 * @returns {{ cacheDir: string, javaPath: string, cfrJar: string, rgPath: string }}
 */
export function normalizeConfig(raw) {
  const source = raw ?? {}
  return {
    cacheDir: text(source.cacheDir) || join(dshHome(), 'cache', 'jar-decompile'),
    javaPath: text(source.javaPath) || DEFAULT_CONFIG.javaPath,
    cfrJar: text(source.cfrJar) || DEFAULT_CONFIG.cfrJar,
    rgPath: text(source.rgPath),
  }
}
