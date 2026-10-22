import type { ProjectFileTree } from '../collab/generated'
import type { FileEdit } from './serviceClient'
const touches = (edit: FileEdit) => [edit.path, ...(edit.destination ? [edit.destination] : []), ...(edit.affectedPaths ?? [])]
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
/** Keep source/language ownership and move chains together, preserving captured CAS versions. */
export function partitionSyncEdits(edits: FileEdit[], tree: ProjectFileTree, authority: (path: string) => string) {
  const groups: FileEdit[][] = []
  for (const edit of edits) {
    const matches = groups.filter(group => group.some(other => touches(other).some(a => touches(edit).some(b => overlaps(a,b) || authority(a) === authority(b)))))
    if (!matches.length) groups.push([edit])
    else { matches[0].push(edit); for (const group of matches.slice(1)) { matches[0].push(...group); groups.splice(groups.indexOf(group),1) } }
  }
  const version = (path: string) => tree.entries.find(entry => entry.path === path)?.version ?? null
  const isCurrent = (edit: FileEdit) => (edit.version ?? null) === version(edit.path) && (!edit.destination || (edit.destinationVersion ?? null) === version(edit.destination))
  return { safe: groups.filter(group => group.every(isCurrent)), conflicting: groups.filter(group => !group.every(isCurrent)) }
}

