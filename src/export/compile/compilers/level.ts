import { parseLevelDocument, type LevelArea, type LevelDocument } from '../../../workspaces/gameplay/levelDoc'
import { NAV_DISPLAY_ICON, NAV_DISPLAY_MAX_DISTANCE, NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_NAME, parseNavigationPoint, validateNavigationPoint, type NavigationPoint } from '../../../workspaces/gameplay/navigationPoint'
import type { CompileArtifact, FileCompiler, PackagePass } from '../types'

/**
 * 一个 `.level` 编译成多个运行时文件：
 *   levels/<模板>.json
 *   regions/<模板>$<区域 id>.json
 *   navigation_points/<模板>$<导航点 id>.json
 *
 * 子对象的 `level` 在这里写入，作者文档里不出现。
 */

const INVALID_ID = /[$\\/:*?"<>|\u0000-\u001f]/

function templateIdOf(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.level$/i, '')
}

function areaToJson(area: LevelArea): Record<string, unknown> {
  if (area.kind === 'rect') return { x: area.x, z: area.z, y: area.y }
  if (area.kind === 'circle') return { shape: 'circle', center: area.center, radius: area.radius, y: area.y }
  return { shape: 'polygon', points: area.points, y: area.y }
}

export function compiledNavigationPoint(point: NavigationPoint, level: string): Record<string, unknown> {
  const custom: Record<string, unknown> = {}
  for (const key of [NAV_DISPLAY_NAME, NAV_DISPLAY_ICON, NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_MAX_DISTANCE]) {
    if (point.custom_data[key] !== undefined) custom[key] = point.custom_data[key]
  }
  for (const [key, value] of Object.entries(point.custom_data)) if (!(key in custom)) custom[key] = value
  return {
    level,
    type: point.type,
    param: { x: point.param.x, y: point.param.y, z: point.param.z },
    custom_data: custom,
  }
}

function regionArtifacts(level: LevelDocument, templateId: string, packageName: string, sourcePath: string): CompileArtifact[] {
  return level.regions.map((region) => ({
    path: `regions/${templateId}$${region.id}.json`,
    bytes: `${JSON.stringify({
      level: templateId,
      areas: region.areas.map(areaToJson),
      ...(Object.keys(region.custom_data).length ? { custom_data: region.custom_data } : {}),
    }, null, 2)}\n`,
    plane: 'shared',
    packageName,
    sourcePath,
  }))
}

function navigationArtifacts(level: LevelDocument, templateId: string, packageName: string, sourcePath: string): CompileArtifact[] {
  return level.navigation.map((point) => ({
    path: `navigation_points/${templateId}$${point.id}.json`,
    bytes: `${JSON.stringify(compiledNavigationPoint({ ...point, level: templateId }, templateId), null, 2)}\n`,
    plane: 'shared',
    packageName,
    sourcePath,
  }))
}

export const levelCompiler: FileCompiler = {
  id: 'level',
  match: (file) => file.name.toLowerCase().endsWith('.level'),
  async compile(file, ctx) {
    const templateId = templateIdOf(file.name)
    const error = (message: string, sourcePath = file.name) => ctx.report({ severity: 'error', code: 'level_invalid', message, sourcePath })
    if (!templateId || INVALID_ID.test(templateId)) {
      error(`地图模板文件名不能包含 $ \\ / : * ? " < > | 或控制字符：${file.name}`)
      return []
    }
    let level: LevelDocument
    try {
      level = parseLevelDocument(file.content)
    } catch (cause) {
      error(`地图模板无法导出：${cause instanceof Error ? cause.message : String(cause)}`)
      return []
    }
    const packageName = ctx.index.package.name
    return [
      {
        path: `levels/${templateId}.json`,
        bytes: `${JSON.stringify({ tags: level.tags, custom_data: level.custom_data }, null, 2)}\n`,
        plane: 'shared',
        packageName,
        sourcePath: file.name,
      },
      ...regionArtifacts(level, templateId, packageName, file.name),
      ...navigationArtifacts(level, templateId, packageName, file.name),
    ]
  },
}

export const navigationCompiler: FileCompiler = {
  id: 'navigation-point',
  match: (file) => file.name.toLowerCase().endsWith('.nav'),
  async compile(file, ctx) {
    const name = file.name.replace(/^.*[\\/]/, '').replace(/\.nav$/i, '')
    if (!name || INVALID_ID.test(name)) {
      ctx.report({ severity: 'error', code: 'navigation_invalid', message: `动态导航点文件名不合法：${file.name}`, sourcePath: file.name })
      return []
    }
    try {
      const point = parseNavigationPoint(file.content)
      const issues = validateNavigationPoint(point)
      if (issues.length) throw new Error(issues.join('；'))
      return [{
        path: `navigation_points/${name}.json`,
        bytes: `${JSON.stringify(compiledNavigationPoint(point, point.level.trim()), null, 2)}\n`,
        plane: 'shared',
        packageName: ctx.index.package.name,
        sourcePath: file.name,
      }]
    } catch (cause) {
      ctx.report({
        severity: 'error',
        code: 'navigation_invalid',
        message: `动态导航点无法导出：${cause instanceof Error ? cause.message : String(cause)}`,
        sourcePath: file.name,
      })
      return []
    }
  },
}

/** 模板子项与动态导航点共用 `navigation_points/`，重复路径会互相覆盖。 */
export const levelArtifactPass: PackagePass = {
  id: 'level-artifacts',
  async run(prior, ctx) {
    const seen = new Map<string, string>()
    for (const artifact of prior) {
      if (!/^(levels|regions|navigation_points)\//.test(artifact.path)) continue
      const owner = seen.get(artifact.path.toLowerCase())
      if (owner) {
        ctx.report({
          severity: 'error',
          code: 'level_duplicate_export',
          message: `导出路径重复：${artifact.path}（${owner} 与 ${artifact.sourcePath ?? artifact.path}）`,
          sourcePath: artifact.sourcePath ?? artifact.path,
          packageName: artifact.packageName,
        })
      } else {
        seen.set(artifact.path.toLowerCase(), artifact.sourcePath ?? artifact.path)
      }
    }
    return []
  },
}
