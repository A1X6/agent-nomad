import { BundlePathSchema } from '@agentnomad/contracts';

import { HOME_PLACEHOLDER, PathError, type PathEnvironment, type PathResolver } from './paths.ts';

/** Device names Windows reserves, with or without an extension (`CON`, `nul.txt`). */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
]);

/** Characters Windows does not allow in file names. */
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/;

/** Characters that can be part of a folder name next to the home path (for exact matching). */
const NAME_CHARACTER = '[A-Za-z0-9._-]';

/** One path segment in text: stops at whitespace, quotes, separators and shell punctuation. */
const TEXT_SEGMENT = '[^\\s"\'`\\\\/,;|&<>(){}\\[\\]*?]+';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => char.charCodeAt(0) < 0x20);
}

/** Throws when a bundle path cannot be created as-is on Windows. */
function assertWindowsSafe(bundlePath: string): void {
  for (const segment of bundlePath.split('/')) {
    const stem = (segment.split('.')[0] ?? '').toUpperCase();
    if (
      WINDOWS_RESERVED_NAMES.has(stem) ||
      WINDOWS_FORBIDDEN_CHARACTERS.test(segment) ||
      hasControlCharacter(segment) ||
      segment.endsWith('.') ||
      segment.endsWith(' ')
    ) {
      throw new PathError(
        `"${bundlePath}" cannot be restored on Windows (invalid name "${segment}")`,
      );
    }
  }
}

function assertSafeBundlePath(bundlePath: string): void {
  if (!BundlePathSchema.safeParse(bundlePath).success) {
    throw new PathError(`Unsafe bundle path: "${bundlePath}"`);
  }
}

/** Windows paths with backslashes and no trailing separator (except a drive root like `C:\`). */
function normalizeWindows(path: string): string {
  const backslashed = path.replace(/\//g, '\\');
  return /^[A-Za-z]:\\$/.test(backslashed) ? backslashed : backslashed.replace(/\\+$/, '');
}

/** POSIX paths with no trailing slash (except the root `/`). */
function normalizePosix(path: string): string {
  return path === '/' ? path : path.replace(/\/+$/, '');
}

function assertValidHome(environment: PathEnvironment): void {
  const { os, homeDir } = environment;
  const valid =
    os === 'win32'
      ? /^[A-Za-z]:[\\/][^\\/]/.test(homeDir)
      : homeDir.startsWith('/') && normalizePosix(homeDir) !== '/';
  if (!valid)
    throw new PathError(`Home folder must be an absolute path below the root: "${homeDir}"`);
}

/** Replaces the home folder in text, in each way it can be written, with `{{HOME}}/...`. */
function windowsToPortable(text: string, homeDir: string): string {
  const segments = homeDir.split(/[\\/]+/).filter((segment) => segment !== '');
  // JSON-escaped backslashes first, then forward slashes, then plain backslashes.
  const separators = ['\\\\\\\\', '/', '\\\\'];
  return separators.reduce((current, separator) => {
    const pattern = new RegExp(
      `(?<!${NAME_CHARACTER})${segments.map(escapeRegExp).join(separator)}` +
        `((?:${separator}${TEXT_SEGMENT})*)(?!${NAME_CHARACTER})`,
      'gi',
    );
    const separatorPattern = new RegExp(separator, 'g');
    return current.replace(
      pattern,
      (_match, rest: string) => HOME_PLACEHOLDER + rest.replace(separatorPattern, '/'),
    );
  }, text);
}

function posixToPortable(text: string, homeDir: string): string {
  const pattern = new RegExp(
    `(?<!${NAME_CHARACTER}|/)${escapeRegExp(homeDir)}(?!${NAME_CHARACTER})`,
    'g',
  );
  return text.replace(pattern, HOME_PLACEHOLDER);
}

/**
 * PathResolver for one OS and home folder (T10). Pure string logic, so every OS can be
 * tested on any OS. Portable text always uses forward slashes after `{{HOME}}`; on Windows
 * the home folder is restored as `C:/Users/...`, which Windows accepts and JSON needs no
 * escaping for.
 */
export function createPathResolver(environment: PathEnvironment): PathResolver {
  assertValidHome(environment);
  const windows = environment.os === 'win32';
  const homeDir = windows
    ? normalizeWindows(environment.homeDir)
    : normalizePosix(environment.homeDir);
  const portableHome = windows ? homeDir.replace(/\\/g, '/') : homeDir;

  return {
    environment,

    toNativePath(baseDir, bundlePath) {
      assertSafeBundlePath(bundlePath);
      if (windows) {
        assertWindowsSafe(bundlePath);
        const base = normalizeWindows(baseDir);
        const joiner = base.endsWith('\\') ? '' : '\\';
        return base + joiner + bundlePath.split('/').join('\\');
      }
      const base = normalizePosix(baseDir);
      return (base === '/' ? '' : base) + '/' + bundlePath;
    },

    toBundlePath(baseDir, nativePath) {
      const [base, path] = windows
        ? [normalizeWindows(baseDir), nativePath.replace(/\//g, '\\')]
        : [normalizePosix(baseDir), nativePath];
      const separator = windows ? '\\' : '/';
      const prefix = base.endsWith(separator) ? base : base + separator;
      // Windows paths are case-insensitive; macOS and Linux paths are compared exactly.
      const inside = windows
        ? path.toLowerCase().startsWith(prefix.toLowerCase())
        : path.startsWith(prefix);
      if (!inside) throw new PathError(`"${nativePath}" is not inside "${baseDir}"`);

      const bundlePath = path.slice(prefix.length).split(separator).join('/');
      if (!BundlePathSchema.safeParse(bundlePath).success) {
        throw new PathError(`"${nativePath}" is not inside "${baseDir}"`);
      }
      return bundlePath;
    },

    toPortableText(text) {
      return windows ? windowsToPortable(text, homeDir) : posixToPortable(text, homeDir);
    },

    fromPortableText(text) {
      return text.replaceAll(HOME_PLACEHOLDER, portableHome);
    },
  };
}
