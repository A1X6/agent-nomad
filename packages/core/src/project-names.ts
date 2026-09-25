import {
  GLOBAL_SCOPE_KEY,
  ProjectNameSchema,
  type AgentId,
  type BundleScope,
  type ScopeKey,
} from '@agentnomad/contracts';
import { strFromU8, strToU8 } from 'fflate';

import { DecryptionError, type Aead, type KeyedHash } from './crypto.ts';

/** Scope key of the global setup (defined in contracts, shared with the server). */
export { GLOBAL_SCOPE_KEY };

/**
 * Labels for keys and associated data. Part of the stored format: changing them would make
 * existing projects unfindable or unreadable (a new scheme is added as v2 instead).
 */
const SCOPE_KEY_LABEL = strToU8('agentnomad/scope-key/v1');
const NAME_LABEL = 'agentnomad/project-name/v1';

/** Where an encrypted project name belongs. Opening it anywhere else fails. */
export interface ProjectNameContext {
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Validated project name as UTF-8 bytes, NFC-normalised so every OS types it the same. */
function nameBytes(projectName: string): Uint8Array {
  return strToU8(ProjectNameSchema.parse(projectName).normalize('NFC'));
}

/**
 * The server-side id of a project (T12): a keyed hash of the name. The key is derived from
 * the data key, so only the owner can compute it, and two users with the same project name
 * get unrelated keys.
 */
export function projectScopeKey(
  hash: KeyedHash,
  dataKey: Uint8Array,
  projectName: string,
): ScopeKey {
  const hashKey = hash.keyedHash(SCOPE_KEY_LABEL, dataKey);
  return toHex(hash.keyedHash(nameBytes(projectName), hashKey));
}

/** `global` for the global scope, the project scope key for a project. */
export function scopeKeyFor(hash: KeyedHash, dataKey: Uint8Array, scope: BundleScope): ScopeKey {
  return scope.kind === 'global' ? GLOBAL_SCOPE_KEY : projectScopeKey(hash, dataKey, scope.name);
}

function nameAssociatedData(context: ProjectNameContext): Uint8Array {
  return strToU8(`${NAME_LABEL}/${context.agent}/${context.scopeKey}`);
}

/** Encrypts a project name so `list` can show it; bound to its agent and scope key. */
export function encryptProjectName(
  aead: Aead,
  dataKey: Uint8Array,
  projectName: string,
  context: ProjectNameContext,
): Uint8Array {
  return aead.seal(nameBytes(projectName), dataKey, nameAssociatedData(context));
}

/** Decrypts a project name. Throws DecryptionError if it was moved, changed or the key is wrong. */
export function decryptProjectName(
  aead: Aead,
  sealed: Uint8Array,
  dataKey: Uint8Array,
  context: ProjectNameContext,
): string {
  const name = strFromU8(aead.open(sealed, dataKey, nameAssociatedData(context)));
  if (!ProjectNameSchema.safeParse(name).success) throw new DecryptionError();
  return name;
}
