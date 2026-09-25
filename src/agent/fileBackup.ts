/** @deprecated 请用 ../history/fileHistory；此处保留兼容导出 */
export {
  pushFileVersion as pushFileBackup,
  pushFileVersion,
  listFileVersions as listFileBackups,
  listHistoryFileNames as listAllBackupFiles,
  type FileVersion as FileBackup,
} from '../history/fileHistory'
