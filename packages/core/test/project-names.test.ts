import { MAX_NAME_ENC_BYTES, ScopeKeySchema } from '@agentnomad/contracts';
import { strToU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DATA_KEY_BYTES,
  DecryptionError,
  GLOBAL_SCOPE_KEY,
  createSodiumCryptoService,
  decryptProjectName,
  encryptProjectName,
  projectScopeKey,
  scopeKeyFor,
  type CryptoService,
} from '../src/index.ts';

let crypto: CryptoService;
let dataKey: Uint8Array;

beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(DATA_KEY_BYTES);
});

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** True when `needle` appears as a run of bytes inside `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return hex(haystack).includes(hex(needle));
}

describe('projectScopeKey', () => {
  it('gives the same key for the same name every time (so any PC finds the project)', () => {
    expect(projectScopeKey(crypto, dataKey, 'my-saas-app')).toBe(
      projectScopeKey(crypto, dataKey, 'my-saas-app'),
    );
  });

  it('is a 64-character lowercase hex key the API accepts, never "global"', () => {
    const key = projectScopeKey(crypto, dataKey, 'my-saas-app');
    expect(ScopeKeySchema.safeParse(key).success).toBe(true);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different keys for different names', () => {
    expect(projectScopeKey(crypto, dataKey, 'app-one')).not.toBe(
      projectScopeKey(crypto, dataKey, 'app-two'),
    );
  });

  it('gives different keys to different users with the same project name (unlinkable)', () => {
    const otherUser = crypto.randomBytes(DATA_KEY_BYTES);
    expect(projectScopeKey(crypto, dataKey, 'my-saas-app')).not.toBe(
      projectScopeKey(crypto, otherUser, 'my-saas-app'),
    );
  });

  it('cannot be guessed from the name alone (it is not a plain hash of the name)', () => {
    const name = 'my-saas-app';
    expect(projectScopeKey(crypto, dataKey, name)).not.toBe(hex(crypto.sha256(strToU8(name))));
  });

  it('treats the same name typed on different OSes as equal (Unicode NFC)', () => {
    expect(projectScopeKey(crypto, dataKey, 'café')).toBe(projectScopeKey(crypto, dataKey, 'café'));
  });

  it('is case-sensitive, like the name the user typed', () => {
    expect(projectScopeKey(crypto, dataKey, 'App')).not.toBe(
      projectScopeKey(crypto, dataKey, 'app'),
    );
  });

  it.each(['', ' padded', 'line\nbreak', 'a'.repeat(101)])('refuses invalid name %j', (name) => {
    expect(() => projectScopeKey(crypto, dataKey, name)).toThrow();
  });
});

describe('scopeKeyFor', () => {
  it('uses "global" for the global scope', () => {
    expect(scopeKeyFor(crypto, dataKey, { kind: 'global' })).toBe(GLOBAL_SCOPE_KEY);
    expect(GLOBAL_SCOPE_KEY).toBe('global');
  });

  it('uses the project scope key for a project', () => {
    expect(scopeKeyFor(crypto, dataKey, { kind: 'project', name: 'my-saas-app' })).toBe(
      projectScopeKey(crypto, dataKey, 'my-saas-app'),
    );
  });
});

describe('project name encryption', () => {
  const name = 'my-saas-app';
  const context = () => ({
    agent: 'claude-code',
    scopeKey: projectScopeKey(crypto, dataKey, name),
  });

  it('round-trips the name', () => {
    const sealed = encryptProjectName(crypto, dataKey, name, context());
    expect(decryptProjectName(crypto, sealed, dataKey, context())).toBe(name);
  });

  it('never contains the name in readable form (the server sees no plaintext)', () => {
    const sealed = encryptProjectName(crypto, dataKey, name, context());
    expect(containsBytes(sealed, strToU8(name))).toBe(false);
  });

  it('looks different every time, even for the same name', () => {
    expect(hex(encryptProjectName(crypto, dataKey, name, context()))).not.toBe(
      hex(encryptProjectName(crypto, dataKey, name, context())),
    );
  });

  it('fits the API size limit even for the longest name in 4-byte characters', () => {
    const longest = '😀'.repeat(50); // 100 UTF-16 units, 200 bytes of UTF-8
    const scopeKey = projectScopeKey(crypto, dataKey, longest);
    const sealed = encryptProjectName(crypto, dataKey, longest, { agent: 'claude-code', scopeKey });
    expect(sealed.length).toBeLessThanOrEqual(MAX_NAME_ENC_BYTES);
    expect(decryptProjectName(crypto, sealed, dataKey, { agent: 'claude-code', scopeKey })).toBe(
      longest,
    );
  });

  it('cannot be moved to another project or agent by the server', () => {
    const sealed = encryptProjectName(crypto, dataKey, name, context());
    const otherProject = { ...context(), scopeKey: projectScopeKey(crypto, dataKey, 'other') };
    expect(() => decryptProjectName(crypto, sealed, dataKey, otherProject)).toThrow(
      DecryptionError,
    );
    expect(() =>
      decryptProjectName(crypto, sealed, dataKey, { ...context(), agent: 'codex' }),
    ).toThrow(DecryptionError);
  });

  it('cannot be read with another data key', () => {
    const sealed = encryptProjectName(crypto, dataKey, name, context());
    expect(() =>
      decryptProjectName(crypto, sealed, crypto.randomBytes(DATA_KEY_BYTES), context()),
    ).toThrow(DecryptionError);
  });

  it('refuses to encrypt an invalid name', () => {
    expect(() => encryptProjectName(crypto, dataKey, 'bad\nname', context())).toThrow();
  });
});
