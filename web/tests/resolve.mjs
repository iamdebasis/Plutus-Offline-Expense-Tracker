import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
    for (const ext of ['.ts', '.tsx']) {
      const url = new URL(specifier + ext, context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
  }
  return next(specifier, context)
}
