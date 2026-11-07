/**
 * Host 半入口：把 cfr 与 rg 注册为模型可调用的 jar 工具。
 */

import { createCfr } from './src/cfr.js'
import { normalizeConfig } from './src/config.js'
import { createRg } from './src/rg.js'
import { registerJarTools } from './src/tools.js'

/** Loader 条目标识，与 patch 里的 id 一致。 */
export const name = 'jar-cfr'

/** 硬依赖：缺工具注册表或子进程服务时插件不加载。 */
export const inject = ['tools', 'subprocess']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ cacheDir?: string, javaPath?: string, cfrJar?: string, rgPath?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const cfr = createCfr(ctx, settings)
  const rg = createRg(ctx, settings)
  return ctx.effect(() => registerJarTools(ctx, { cfr, rg }))
}
