/**
 * 内置目标定义脚本：本目录下所有 `.py` 会在构建时打进包，
 * 资源树「目标定义 / 内置」与进度目标目录都会读这里。
 *
 * 增删改：直接改本文件夹里的 `.py` 即可，无需再改 TypeScript 列表。
 */

const modules = import.meta.glob('./*.py', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

export type BuiltinGoalDefinitionScript = { name: string; source: string }

export const BUILTIN_GOAL_DEFINITION_SCRIPTS: BuiltinGoalDefinitionScript[] = Object.entries(modules)
  .map(([path, source]) => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    source: String(source).replace(/\r\n/g, '\n'),
  }))
  .filter((item) => item.name.endsWith('.py'))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
