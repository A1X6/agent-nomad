import type { AgentId, KdfParams, ScopeKey, Username } from '@agentnomad/contracts';

/** A stored account. Holds nothing that can decrypt the user's data. */
export interface UserRecord {
  readonly id: string;
  readonly username: Username;
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: KdfParams;
  /** Server-side hash of the auth key; the auth key itself is never stored. */
  readonly authHash: string;
  /** The data key, locked with the user's password key. */
  readonly wrappedDataKey: Uint8Array;
  readonly createdAt: Date;
}

export type NewUser = Omit<UserRecord, 'id' | 'createdAt'>;

/** Accounts (T14). */
export interface UserRepository {
  findByUsername(username: Username): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Rejects when the username is taken. */
  create(user: NewUser): Promise<UserRecord>;
  /** Removes the user; their sessions and bundles go with them. */
  delete(id: string): Promise<void>;
}

/** A login on one device. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  /** Hash of the session token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly deviceName: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export type NewSession = Omit<SessionRecord, 'id' | 'createdAt'>;

/** Sessions (T14). */
export interface SessionRepository {
  create(session: NewSession): Promise<SessionRecord>;
  /** Returns only sessions that have not expired. */
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  delete(id: string): Promise<void>;
}

/** Identifies one saved setup: one user, one agent, one scope. */
export interface BundleKey {
  readonly userId: string;
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
}

/** Everything about a saved setup except its encrypted bytes (those live in the BlobStore). */
export interface BundleMeta {
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
  readonly nameEnc: Uint8Array | null;
  readonly contentHash: Uint8Array;
  readonly formatVersion: number;
  readonly revision: number;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
}

/** Metadata for a new revision. The bytes are written to the BlobStore first. */
export interface BundleMetaWrite {
  readonly key: BundleKey;
  /** Revision the client last saw; `0` means "must not exist yet". */
  readonly expectedRevision: number;
  readonly nameEnc: Uint8Array | null;
  readonly contentHash: Uint8Array;
  readonly formatVersion: number;
  readonly sizeBytes: number;
}

export type PutMetaResult =
  /** Stored as a new revision (`expectedRevision + 1`). */
  | { readonly outcome: 'saved'; readonly meta: BundleMeta }
  /** A retry of the upload that is already stored (same content hash); nothing changed. */
  | { readonly outcome: 'unchanged'; readonly meta: BundleMeta }
  /** Someone saved a newer revision first. */
  | { readonly outcome: 'conflict'; readonly currentRevision: number };

export interface BundlePage {
  readonly items: readonly BundleMeta[];
  readonly nextCursor: string | null;
}

/** Saved-setup metadata with the revision check, done atomically (T14, T16). */
export interface BundleRepository {
  /** Metadata only, newest first, one page at a time. */
  list(
    userId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): Promise<BundlePage>;
  get(key: BundleKey): Promise<BundleMeta | null>;
  putMeta(write: BundleMetaWrite): Promise<PutMetaResult>;
  /** Returns `false` when there was nothing to delete. */
  delete(key: BundleKey): Promise<boolean>;
}
