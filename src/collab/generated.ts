// Generated from project-core. Run npm run generate:protocol; do not edit.

export type Role = "owner" | "editor" | "viewer";

export type Subject = { id: string, name: string, kind: string, enabled: boolean, };

export type ResourceKind = "folder" | "progress" | "goalDefinition";

export type ResourceInfo = { id: string, parentId: string | null, name: string, kind: ResourceKind, revision: number, };

export type Resource = { id: string, parentId: string | null, name: string, kind: ResourceKind, revision: number, content: string | null, };

export type Session = { id: string, subjectId: string, clientName: string, expiresAt: number, resourceId: string | null, activity: string, };

export type Lease = { id: string, resourceId: string, sessionId: string, expiresAt: number, };

export type Member = { subject: Subject, role: Role, };

export type Snapshot = { projectId: string, projectName: string, revision: number, filesRevision: number, session: Session, role: Role, members: Array<Member>, resources: Array<ResourceInfo>, sessions: Array<Session>, leases: Array<Lease>, };

export type ProjectFile = { path: string, kind: string, version: string, size: number, };

export type ProjectFileTree = { revision: number, entries: Array<ProjectFile>, };

export type FileChange = { op: string, path: string, version: string | null, content: string | null, destination: string | null, destinationVersion: string | null, leaseId: string, };

export type FileTransactionStatus = "committed" | "rejected";

export type FileTransactionError = { code: string, message: string, };

export type FileTransactionReceipt = { transactionId: string, status: FileTransactionStatus, tree: ProjectFileTree | null, error: FileTransactionError | null, };

export type SourceFileMove = { path: string, destination: string | null, };

