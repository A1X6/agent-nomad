import {
  KDF_SALT_BYTES,
  MAX_BUNDLE_BYTES,
  MAX_NAME_ENC_BYTES,
  WRAPPED_DATA_KEY_BYTES,
  type KdfParams,
} from '@agentnomad/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** SHA-256 digest length, for `content_hash`. */
const SHA256_BYTES = 32;

/**
 * Raw bytes (Postgres `bytea`) as `Uint8Array`. Drizzle 0.45 has no built-in bytea column;
 * 1.0 adds one, and switching to it later does not change the database.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  // Node drivers return a Buffer (a Uint8Array subclass); copy to a plain Uint8Array.
  fromDriver: (value) => new Uint8Array(value),
});

/** A number written into DDL as a literal (check constraints cannot use parameters). */
const lit = (value: number) => sql.raw(String(value));

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Accounts. Nothing here can decrypt the user's data. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercase; validated by UsernameSchema before it gets here. */
    username: text('username').notNull(),
    kdfSalt: bytea('kdf_salt').notNull(),
    kdfParams: jsonb('kdf_params').$type<KdfParams>().notNull(),
    /** Server-side hash of the auth key. */
    authHash: text('auth_hash').notNull(),
    /** The data key, locked with the user's password key. */
    wrappedDataKey: bytea('wrapped_data_key').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_username_key').on(table.username),
    check('users_kdf_salt_length', sql`octet_length(${table.kdfSalt}) = ${lit(KDF_SALT_BYTES)}`),
    check(
      'users_wrapped_data_key_length',
      sql`octet_length(${table.wrappedDataKey}) = ${lit(WRAPPED_DATA_KEY_BYTES)}`,
    ),
  ],
);

/** One login on one device. Only the hash of the session token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    deviceName: text('device_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** For the idle timeout; refreshed at most once a day, not on every request. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

/**
 * Fixed-window request counters for rate limiting (T18). In the database, not in memory, so
 * every server instance on any host shares them. `key` is a keyed hash of the rule and the
 * subject (IP or username), so no readable IP address or username is stored.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (table) => [
    /** Pruning old windows. */
    index('rate_limits_window_started_at_idx').on(table.windowStartedAt),
  ],
);

/**
 * Encrypted bundle bytes (the Postgres BlobStore). Every upload gets a new random id, so two
 * uploads can never overwrite each other; which file is current is decided by
 * `bundles.blob_id`, never by the file's name. `ciphertext` is STORAGE EXTERNAL (custom
 * migration): it is already encrypted, so Postgres should not try to compress it.
 */
export const bundleBlobs = pgTable(
  'bundle_blobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 24-byte nonce followed by the encrypted bundle. */
    ciphertext: bytea('ciphertext').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /** Lets `bundles` point at a file of the same user only; also indexes `user_id`. */
    uniqueIndex('bundle_blobs_user_id_id_key').on(table.userId, table.id),
    check(
      'bundle_blobs_ciphertext_size',
      sql`octet_length(${table.ciphertext}) <= ${lit(MAX_BUNDLE_BYTES)}`,
    ),
  ],
);

/**
 * One saved setup per user, agent and scope: metadata only, plus a pointer to the file that
 * holds the current revision's bytes. List queries never touch the bytes.
 */
export const bundles = pgTable(
  'bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    /** `global`, or the keyed hash of the project name. */
    scopeKey: text('scope_key').notNull(),
    /** Encrypted project name; `null` for the global scope. */
    nameEnc: bytea('name_enc'),
    /** SHA-256 of the ciphertext; makes PUT retries idempotent. */
    contentHash: bytea('content_hash').notNull(),
    formatVersion: integer('format_ver').notNull(),
    revision: integer('revision').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** The current revision's file in `bundle_blobs`. */
    blobId: uuid('blob_id').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('bundles_user_agent_scope_key').on(table.userId, table.agent, table.scopeKey),
    /** `list`: one user's setups, newest first, paged by (updated_at, id). */
    index('bundles_user_updated_idx').on(table.userId, table.updatedAt.desc(), table.id.desc()),
    /** One file backs at most one setup; also indexes the foreign key below. */
    uniqueIndex('bundles_blob_id_key').on(table.blobId),
    /**
     * The file must belong to the same user, and cannot be deleted while a setup points to
     * it (no action: checked at the end of the statement, so account delete still cascades).
     */
    foreignKey({
      name: 'bundles_blob_fk',
      columns: [table.userId, table.blobId],
      foreignColumns: [bundleBlobs.userId, bundleBlobs.id],
    }),
    check('bundles_revision_positive', sql`${table.revision} >= 1`),
    check('bundles_format_ver_positive', sql`${table.formatVersion} >= 1`),
    check(
      'bundles_size_bytes_range',
      sql`${table.sizeBytes} between 1 and ${lit(MAX_BUNDLE_BYTES)}`,
    ),
    check(
      'bundles_content_hash_length',
      sql`octet_length(${table.contentHash}) = ${lit(SHA256_BYTES)}`,
    ),
    check(
      'bundles_name_enc_length',
      sql`${table.nameEnc} is null or octet_length(${table.nameEnc}) <= ${lit(MAX_NAME_ENC_BYTES)}`,
    ),
  ],
);
