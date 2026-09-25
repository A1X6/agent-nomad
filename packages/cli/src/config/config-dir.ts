import { isAbsolute, join } from 'node:path';

export interface ConfigDirInput {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * agentnomad's own folder for this user: `%APPDATA%\agentnomad` on Windows, else
 * `$XDG_CONFIG_HOME/agentnomad` or `~/.config/agentnomad` (macOS too, like most CLIs).
 */
export function configDir({ platform, homedir, env }: ConfigDirInput): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return join(
      appData && isAbsolute(appData) ? appData : join(homedir, 'AppData', 'Roaming'),
      'agentnomad',
    );
  }
  const xdg = env['XDG_CONFIG_HOME'];
  // The XDG spec says relative values are invalid and must be ignored.
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir, '.config'), 'agentnomad');
}
