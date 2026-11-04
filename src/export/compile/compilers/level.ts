import { LEVEL_ID_MAX, parseLevelDocument, type LevelArea, type LevelDocument } from '../../../workspaces/gameplay/levelDoc'
import { parseNavigationPoint, validateNavigationPoint } from '../../../workspaces/gameplay/navigationPoint'
import type { CompileArtifact, FileCompiler, PackagePass } from '../types'
import { effectSections } from '../../../workspaces/gameplay/regionEffects'

/**
 * 一个 `.level` 编译成多个运行时文件：
 *   levels/<模板>.json
 *   regions/<模板>$<区域 id>.json
 *   landmarks/<模板>$<地标 id>.json
 *
 * 子对象的 `level` 在这里写入，作者文档里不出现。
 */

const INVALID_ID = /[$\\/:*?"<>|\u0000-\u001f]/

function validFileId(id: string): boolean {
  return id.trim().length > 0 && id.length <= LEVEL_ID_MAX && id !== '.' && id !== '..' && !INVALID_ID.test(id)
}

function templateIdOf(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.level$/i, '')
}

function areaToJson(area: LevelArea): Record<string, unknown> {
  if (area.kind === 'rect') return { x: area.x, z: area.z, y: area.y }
  if (area.kind === 'circle') return { shape: 'circle', center: area.center, radius: area.radius, y: area.y }
  return { shape: 'polygon', points: area.points, y: area.y }
}

function regionArtifacts(level: LevelDocument, templateId: string, packageName: string, sourcePath: string): CompileArtifact[] {
  return level.regions.map((region) => ({
    path: `regions/${templateId}$${region.id}.json`,
    bytes: `${JSON.stringify({
      level: templateId,
      areas: region.areas.map(areaToJson),
      ...effectSections(region),
      ...(Object.keys(region.custom_data).length ? { custom_data: region.custom_data } : {}),
    }, null, 2)}\n`,
    plane: 'shared',
    packageName,
    sourcePath,
  }))
}

function landmarkArtifacts(level: LevelDocument, templateId: string, packageName: string, sourcePath: string): CompileArtifact[] {
  return level.landmarks.map((point) => ({
    path: `landmarks/${templateId}$${point.id}.json`,
    bytes: `${JSON.stringify({
      level: templateId,
      kind: point.kind,
      param: { x: point.param.x, y: point.param.y, z: point.param.z },
      ...(Object.keys(point.custom_data).length ? { custom_data: point.custom_data } : {}),
    }, null, 2)}\n`,
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
    if (!validFileId(templateId)) {
      error(`地图模板 ID 需要 1..${LEVEL_ID_MAX} 个字符，不能是 . / .. 或包含 $ \\ / : * ? " < > | 或控制字符：${file.name}`)
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
      ...landmarkArtifacts(level, templateId, packageName, file.name),
    ]
  },
}

export const navigationCompiler: FileCompiler = {
  id: 'navigation-point',
  match: (file) => file.name.toLowerCase().endsWith('.nav'),
  async compile(file, ctx) {
    const name = file.name.replace(/^.*[\\/]/, '').replace(/\.nav$/i, '')
    if (!validFileId(name)) {
      ctx.report({ severity: 'error', code: 'navigation_invalid', message: `动态导航器文件名不合法：${file.name}`, sourcePath: file.name })
      return []
    }
    try {
      const point = parseNavigationPoint(file.content)
      const issues = validateNavigationPoint(point)
      if (point.id && point.id !== name) issues.push(`导航器 id「${point.id}」与文件名「${name}」不一致`)
      if (issues.length) throw new Error(issues.join('；'))
      const templates = ctx.index.workspace.packages.flatMap((pkg) => pkg.scripts)
        .filter((source) => source.name.toLowerCase().endsWith('.level') && templateIdOf(source.name) === point.level)
      if (templates.length === 0) throw new Error(`地图模板不存在：${point.level}`)
      const local = point.track.ref.slice(point.track.ref.indexOf('$') + 1)
      if (!templates.some((source) => parseLevelDocument(source.content).landmarks.some((landmark) => landmark.id === local))) {
        throw new Error(`地标不存在：${point.track.ref}`)
      }
      // 运行时只加载 landmarks/。导航器是作者文件，不另写一份坐标或 navigation_points。
      return []
    } catch (cause) {
      ctx.report({
        severity: 'error',
        code: 'navigation_invalid',
        message: `动态导航器无法导出：${cause instanceof Error ? cause.message : String(cause)}`,
        sourcePath: file.name,
      })
      return []
    }
  },
}

/** 模板子项导出路径重复时互相覆盖。只允许 levels / regions / landmarks。 */
export const levelArtifactPass: PackagePass = {
  id: 'level-artifacts',
  async run(prior, ctx) {
    const seen = new Map<string, string>()
    for (const artifact of prior) {
      if (artifact.path.startsWith('navigation_points/')) {
        ctx.report({
          severity: 'error',
          code: 'navigation_points_removed',
          message: `navigation_points 已废弃：${artifact.path}。地标写在 landmarks/，导航器只引用地标。`,
          sourcePath: artifact.sourcePath ?? artifact.path,
          packageName: artifact.packageName,
        })
        continue
      }
      if (!/^(levels|regions|landmarks)\//.test(artifact.path)) continue
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
