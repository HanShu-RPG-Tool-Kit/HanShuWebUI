// Generated from project-core. Run npm run generate:protocol; do not edit.

export type ProgressSlot = { present: boolean, value: unknown, };

export type ProgressTarget = { "kind": "field", field: 'name' | 'description' | 'authorNotes' | 'tags' | 'completion' | 'visibility' | 'acceptance' | 'abandonable' | 'repeat' | 'rewardKits', } | { "kind": "goal-config", goalId: string, goalKind: string, key: string, } | { "kind": "goal-body", goalId: string, } | { "kind": "goal", goalId: string, } | { "kind": "goal-order", } | { "kind": "locale", locale: string, key: string, };

export type ProgressEffect = { target: ProgressTarget, expected: ProgressSlot, value: ProgressSlot, };

export type ProgressCommand = { "command": "apply", documentId: string, changes: Array<ProgressEffect>, } | { "command": "revert", transactionId: string, };

export type ProgressLanguage = { path: string, content: string | null, };

export type ProgressCommandResult = { path: string, documentId: string, effects: Array<ProgressEffect>, source: string, languages: Array<ProgressLanguage>, };

export type HistoryRestoreSelection = { sequence: number, paths: Array<string> | null, skinEntryId: string | null, includeRelated: boolean, };

export type HistoryRestoreRequest = { sequence: number, paths: Array<string> | null, skinEntryId: string | null, includeRelated: boolean, expectedHead: string, };

export type HistoryRestorePlan = { request: HistoryRestoreRequest, changes: Array<HistoryRestoreChange>, leasePaths: Array<string>, warnings: Array<string>, };

export type HistoryRestoreChange = { path: string, action: string, beforeVersion: string | null, afterVersion: string | null, };

export type Role = "owner" | "editor" | "viewer";

export type Subject = { id: string,
/**
 * Login identifier; `name` is the display nickname.
 */
username: string, name: string, kind: string, enabled: boolean, };

export type ResourceKind = "folder" | "progress" | "goalDefinition";

export type ResourceInfo = { id: string, parentId: string | null, name: string, kind: ResourceKind, revision: number, };

export type Resource = { id: string, parentId: string | null, name: string, kind: ResourceKind, revision: number, content: string | null, };

export type FileActivity = "viewing" | "editing";

export type FilePresence = {
/**
 * A public project-relative file path. Unsaved files may be announced before creation.
 */
path: string,
/**
 * The server-derived authority shared by a source and its language/voice assets.
 */
authorityId: string,
/**
 * An opaque skin entry identity used only for collaborator display, never for authority.
 * It may reference a deleted entry whose local draft is being recovered.
 */
entryId: string | null,
/**
 * Editor intent for free editors; managed progress editors derive this from their lease.
 * This field never grants or proves write authority.
 */
activity: FileActivity, };

export type Session = { id: string, subjectId: string, clientName: string, expiresAt: number, resourceId: string | null, activity: string,
/**
 * Focus only; opening a file never grants a write lease.
 */
filePresence: FilePresence | null, };

export type Lease = { id: string, resourceId: string, sessionId: string, expiresAt: number, };

export type Member = { subject: Subject, role: Role, };

export type Snapshot = {
/**
 * Monotonic for this running service, including ephemeral presence/lease updates.
 */
statusVersion: number,
/**
 * Server wall-clock milliseconds sampled when this snapshot is constructed.
 * Clients use this as an anchor for lease/session expiry, not their own wall clock.
 */
serverTime: number, projectId: string, projectName: string, revision: number, filesRevision: number, session: Session, role: Role, members: Array<Member>, resources: Array<ResourceInfo>, sessions: Array<Session>, leases: Array<Lease>, };

export type ProjectFile = { path: string, kind: string, version: string, size: number, };

export type ProjectFileTree = { revision: number, entries: Array<ProjectFile>, };

export type FileChange = { op: string, path: string, version: string | null, content: string | null, destination: string | null, destinationVersion: string | null, leaseId: string, };

export type FileTransactionStatus = "committed" | "rejected";

export type FileTransactionError = { code: string, message: string, };

export type FileTransactionReceipt = { transactionId: string, status: FileTransactionStatus, tree: ProjectFileTree | null, error: FileTransactionError | null,
/**
 * Exact entry result at commit time, retained by immutable transaction receipts.
 */
skinEntries?: Array<Record<string, unknown>>,
/**
 * Exact semantic operation result, persisted atomically with the commit decision.
 */
skinCommandResult?: { command: string; result: Record<string, unknown> },
/**
 * Authoritative selective edit/undo result, part of the durable commit decision.
 */
progressResult?: ProgressCommandResult, };

export type HistoryActor = { subjectId: string, name: string, clientName: string, sessionId: string, };

export type HistoryObject = { kind: string, hash: string | null, size: number, };

export type HistoryChange = { path: string, before: HistoryObject | null, after: HistoryObject | null, };

export type HistoryMove = { from: string, to: string, };

export type HistoryEntry = { sequence: number, projectId: string, time: number, kind: string, transactionId: string | null, actor: HistoryActor | null, changes: Array<HistoryChange>, moves: Array<HistoryMove>, groupId: number, label: string | null, };

export type HistoryPage = { entries: Array<HistoryEntry>, nextBefore: number | null, head: number, projectId: string, };

export type HistoryTree = { sequence: number, scopePath: string | null, entries: Array<ProjectFile>, };

export type HistoryContent = { sequence: number, path: string, content: string, version: string, size: number, };

export type HistoryStats = { head: number, revisions: number, objects: number, storedBytes: number, rawBytes: number, namedVersions: number, };

export type FileOperationKind = "progress-command" | "history-restore" | "write" | "skin-entry-patch" | "skin-library-command" | "mkdir" | "check" | "move" | "remove";

export type FileOperationRequest = { op: FileOperationKind, path: string, destination: string | null, };

export type PlannedFileOperation = { op: FileOperationKind, path: string, destination: string | null, version: string | null, destinationVersion: string | null, originPath: string, };

export type ResourceRelationKind = "ownership" | "reference";

export type ResourceRelationRole = "language" | "voice" | "rewardKit";

export type ResourceRelation = { kind: ResourceRelationKind, role: ResourceRelationRole, from: string, to: string, };

export type FileEditAuthority = { path: string, authorityPath: string, sourceKind: string | null, };

export type ResourceOperationPlan = { revision: number, operations: Array<PlannedFileOperation>, leasePaths: Array<string>, authorities: Array<FileEditAuthority>, relations: Array<ResourceRelation>, };

export type ResourceRelations = { path: string, relations: Array<ResourceRelation>, };

