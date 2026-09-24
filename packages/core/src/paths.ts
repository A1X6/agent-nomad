import type { SourceOs } from '@agentnomad/contracts';

/** Stands in for the user's home folder inside file contents, so they work on any PC. */
export const HOME_PLACEHOLDER = '{{HOME}}';

/**
 * The OS and home folder paths are resolved for. Passed in rather than read from the
 * machine, so core stays free of Node APIs and every OS can be tested on any OS.
 */
export interface PathEnvironment {
  readonly os: SourceOs;
  /** Absolute home folder in the OS's own format, e.g. `C:\Users\ahmed` or `/home/ahmed`. */
  readonly homeDir: string;
}

/** Converts between bundle paths and OS paths, and between real and portable home paths (T10). */
export interface PathResolver {
  readonly environment: PathEnvironment;
  /**
   * Bundle path (relative, forward slashes) to an absolute OS path under `baseDir`.
   * Example on Windows: `skills/a.md` under `C:\Users\ahmed\.claude` becomes
   * `C:\Users\ahmed\.claude\skills\a.md`.
   */
  toNativePath(baseDir: string, bundlePath: string): string;
  /** Absolute OS path under `baseDir` to a bundle path. Throws if the path is outside `baseDir`. */
  toBundlePath(baseDir: string, nativePath: string): string;
  /** Replaces this machine's home folder in text with `{{HOME}}` (on push). */
  toPortableText(text: string): string;
  /** Replaces `{{HOME}}` in text with this machine's home folder (on pull). */
  fromPortableText(text: string): string;
}
