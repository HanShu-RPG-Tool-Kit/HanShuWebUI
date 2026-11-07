/**
 * 工程级导出 / 发版：读 `projectSession`，不经某一工作区菜单分发。
 */

import { pushActivity, updateActivity } from '../activity'
import {
  buildResourcePackZip,
  bundlePacksZip,
  exportPaks,
} from '../export/resourcePack'
import { buildProjectPackZip } from '../export/projectPack'
import { saveBlobAs } from '../export/saveBlob'
import {
  AUTO_PUBLISH_PAK_NAME,
  publishPakBlob,
  summarizePublishResult,
} from '../gameDevServer/publish'
import { flushProjectEditors } from './editorFlush'
import { getProjectSession } from './projectSession'

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

function warnBlock(warnings: string[]): string {
  const shown = warnings.slice(0, 20).join('\n')
  const more =
    warnings.length > 20 ? `\n…另有 ${warnings.length - 20} 条` : ''
  return `${shown}${more}`
}

/** 面板短摘要：只露前几条。 */
function warnSummary(warnings: string[]): string {
  if (warnings.length === 0) return ''
  const preview = warnings.slice(0, 3).join('；')
  const more =
    warnings.length > 3 ? `；…另有 ${warnings.length - 3} 条（点「复制」可取全文）` : ''
  return `编译警告 ${warnings.length} 条：${preview}${more}`
}

/** 复制用：全量警告，不截断。 */
function warnClipboard(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return [
    `编译警告 ${warnings.length} 条：`,
    ...warnings.map((w, i) => `${i + 1}. ${w}`),
  ].join('\n')
}

function preparedWorkspace() {
  flushProjectEditors()
  return getProjectSession().workspace
}

/** 导出 combined PAK（兼容）；桌面／支持的浏览器走「另存为」 */
export async function exportCombinedPak(): Promise<void> {
  try {
    const { blob, fileCount, warnings } = await buildResourcePackZip(
      preparedWorkspace(),
    )
    const result = await saveBlobAs(blob, `hanshu-${stamp()}.pak`, {
      title: '导出 PAK',
      filterLabel: 'PAK',
      extensions: ['pak'],
    })
    if (result === 'cancelled') return
    if (warnings.length > 0) {
      window.alert(
        `已导出 PAK（${fileCount} 个文件），但有警告：\n\n${warnBlock(warnings)}`,
      )
    }
  } catch (err) {
    window.alert(
      `导出 PAK 失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** 导出 client / server / shared；可选用口令加密 server */
export async function exportPlanePaks(): Promise<void> {
  try {
    const passphrase =
      window.prompt(
        '服务端 PAK 加密口令（留空则不加密；口令不会写入工程）',
        '',
      ) ?? ''
    const { packs, warnings } = await exportPaks(preparedWorkspace(), {
      targets: ['client', 'server', 'shared'],
      encrypt: passphrase
        ? { targets: ['server'], passphrase }
        : undefined,
    })
    const bundle = await bundlePacksZip(packs)
    const result = await saveBlobAs(bundle, `hanshu-paks-${stamp()}.zip`, {
      title: '导出分平面 PAK',
      filterLabel: '分平面 PAK 包',
      extensions: ['zip'],
    })
    if (result === 'cancelled') return

    const summary = packs
      .map(
        (p) =>
          `${p.target}: ${p.fileCount} 文件${p.encrypted ? '（已加密）' : ''}`,
      )
      .join('\n')
    if (warnings.length > 0) {
      window.alert(
        `已导出分平面 PAK：\n${summary}\n\n警告：\n${warnBlock(warnings)}`,
      )
    } else {
      window.alert(`已导出分平面 PAK：\n${summary}`)
    }
  } catch (err) {
    window.alert(
      `导出分平面 PAK 失败：${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/** 编译 combined 并 POST /publish 为 auto.pak */
export async function autoPublishPak(): Promise<void> {
  const activityId = 'pak.auto-publish'
  pushActivity({
    id: activityId,
    kind: 'progress',
    title: '自动发版',
    detail: `编译并上传 ${AUTO_PUBLISH_PAK_NAME}`,
    source: 'export',
    progress: 'indeterminate',
    done: false,
  })
  try {
    const { blob, fileCount, warnings } = await buildResourcePackZip(
      preparedWorkspace(),
    )
    updateActivity(activityId, {
      detail: `上传 ${AUTO_PUBLISH_PAK_NAME}（${fileCount} 个文件）…`,
    })
    const result = await publishPakBlob(blob, AUTO_PUBLISH_PAK_NAME)
    const summary = summarizePublishResult(result)
    const retained = result.publishedOrSkipped === false
    updateActivity(activityId, {
      kind: retained || warnings.length > 0 ? 'warning' : 'success',
      title: retained
        ? '自动发版完成（部分保留旧表）'
        : warnings.length > 0
          ? `自动发版完成（${warnings.length} 条编译警告）`
          : '自动发版完成',
      detail: [summary, warnSummary(warnings)].filter(Boolean).join('\n'),
      clipboardDetail: [summary, warnClipboard(warnings)]
        .filter(Boolean)
        .join('\n\n'),
      progress: undefined,
      done: true,
    })
  } catch (err) {
    updateActivity(activityId, {
      kind: 'error',
      title: '自动发版失败',
      detail: err instanceof Error ? err.message : String(err),
      progress: undefined,
      done: true,
    })
  }
}

/** 导出工程包：原样完整打包；桌面／支持的浏览器走「另存为」zip */
export async function exportProjectPack(): Promise<void> {
  try {
    const { blob, fileCount, warnings } = await buildProjectPackZip(
      preparedWorkspace(),
    )
    const fileName = `hanshu-project-${stamp()}.zip`
    const result = await saveBlobAs(blob, fileName, {
      title: '导出工程包',
      filterLabel: '工程包',
      extensions: ['zip'],
    })
    if (result === 'cancelled') return

    if (warnings.length > 0) {
      window.alert(
        `已导出工程包（${fileCount} 个文件），但有警告：\n\n${warnBlock(warnings)}`,
      )
    } else if (fileCount === 0) {
      window.alert('工程包为空（没有可导出的文件）')
    }
  } catch (err) {
    window.alert(
      `导出工程包失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** 按菜单 id 分发工程级导出 / 发版；未知 id 返回 false */
export function runProjectExportAction(id: string): boolean {
  switch (id) {
    case 'auto-publish-pak':
      void autoPublishPak()
      return true
    case 'export-pak':
      void exportCombinedPak()
      return true
    case 'export-pak-planes':
      void exportPlanePaks()
      return true
    case 'export-project-pack':
      void exportProjectPack()
      return true
    default:
      return false
  }
}
