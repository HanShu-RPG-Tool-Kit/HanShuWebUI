/**
 * Stable platform surface for plugins.
 *
 * Plugins may import these modules directly; the application itself must not depend on
 * any plugin. Keeping the barrel here (rather than moving whole directories) keeps the
 * migration incremental while giving plugins a single import point.
 */
export {
  getProjectSession,
  subscribeProjectSession,
  useProjectSession,
} from '../project/projectSession'
export type { Workspace, SourceFile, Project, AssetFile } from '../workspace'
export { getProjectClient, normalizeProjectPath } from '../project/serviceClient'
export { flushProjectEditors, registerProjectEditorFlush } from '../project/editorFlush'
export { confirmDialog, chooseDialog } from '../ui/dialogs/dialogStore'
export { normalizeResourceName, getExtension, editorLanguageForFile } from '../workspace'
export {
  parseLocaleAssetPath,
  normalizeSourcePath,
  voiceRootDir,
} from '../i18n/localeLayout'
export {
  collectSourceKeys,
  suspectKeySpans,
} from '../hanshu/sourceKeys'
export {
  parseTextSpans,
} from '../monaco/textSpans'
export {
  collectInjectDefinitions,
  collectJumpTargets,
} from '../hanshu/injectRefs'
