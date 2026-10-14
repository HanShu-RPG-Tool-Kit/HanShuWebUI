/**
 * 包级 pass：把工程皮肤库里「已启用」的皮肤打进 client 平面。
 *
 * - `assets/skin/<skinId>.png` — skinId 即内容 SHA-256
 * - `assets/skins.json` — customId → skinId 稳定别名索引（无 customId 的不进表）
 *
 * 皮肤库是工程级（`.hanshu/skinmanager`），整次编译只在首个包吐一次，避免多包重复。
 */

import { SkinApiError } from '../../../skin/contracts/types'
import { getSkinApi } from '../../../skin/api'
import type { CompileArtifact, PackagePass } from '../types'

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function listActiveEntries() {
  const api = await getSkinApi()
  const entries = []
  let page = 1
  for (;;) {
    const res = await api.listEntries({
      active: true,
      page,
      pageSize: 200,
      sortBy: 'name',
      sortDirection: 'asc',
    })
    entries.push(...res.entries)
    if (entries.length >= res.total || res.entries.length === 0) break
    page += 1
    if (page > 500) break
  }
  return { api, entries }
}

export const activeSkinsPass: PackagePass = {
  id: 'active-skins',
  async run(_prior, ctx) {
    const workspace = ctx.index.workspace
    const pkg = ctx.index.package
    if (workspace.packages[0]?.id !== pkg.id) return []

    const warn = (message: string) =>
      ctx.report({
        severity: 'warning',
        code: 'active_skin',
        message,
        packageName: pkg.name,
      })

    let api: Awaited<ReturnType<typeof getSkinApi>>
    let entries: Awaited<ReturnType<typeof listActiveEntries>>['entries']
    try {
      ;({ api, entries } = await listActiveEntries())
    } catch (e) {
      if (e instanceof SkinApiError && e.code === 'PROJECT_REQUIRED') {
        warn('未打开工程，跳过启用皮肤导出')
        return []
      }
      warn(`读取皮肤库失败：${e instanceof Error ? e.message : String(e)}`)
      return []
    }

    if (entries.length === 0) return []

    const out: CompileArtifact[] = []
    const exportedIds = new Set<string>()
    const alias: Record<string, string> = {}

    for (const entry of entries) {
      if (entry.customId) {
        if (alias[entry.customId] && alias[entry.customId] !== entry.skinId) {
          warn(
            `自定义 ID「${entry.customId}」映射冲突（${alias[entry.customId]} vs ${entry.skinId}），保留先出现的`,
          )
        } else {
          alias[entry.customId] = entry.skinId
        }
      }

      if (exportedIds.has(entry.skinId)) continue
      exportedIds.add(entry.skinId)

      try {
        const { pngBase64 } = await api.exportSkin(entry.skinId, 'png')
        if (!pngBase64) {
          warn(`皮肤 ${entry.name}（${entry.skinId.slice(0, 12)}…）导出 PNG 为空`)
          continue
        }
        out.push({
          path: `assets/skin/${entry.skinId}.png`,
          bytes: b64ToBytes(pngBase64),
          plane: 'client',
          packageName: pkg.name,
          sourcePath: `skin:${entry.entryId}`,
          provides: [{ kind: 'skinId', id: entry.skinId }],
        })
      } catch (e) {
        warn(
          `皮肤 ${entry.name}（${entry.skinId.slice(0, 12)}…）导出失败：${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }

    const orderedAlias: Record<string, string> = {}
    for (const key of Object.keys(alias).sort((a, b) => a.localeCompare(b))) {
      orderedAlias[key] = alias[key]!
    }

    out.push({
      path: 'assets/skins.json',
      bytes: `${JSON.stringify(orderedAlias, null, 2)}\n`,
      plane: 'client',
      packageName: pkg.name,
      sourcePath: 'skin:library',
      provides: Object.keys(orderedAlias).map((id) => ({
        kind: 'skinCustomId',
        id,
      })),
    })

    return out
  },
}
