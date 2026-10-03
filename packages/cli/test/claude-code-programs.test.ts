import { describe, expect, it } from 'vitest';

import {
  createProgramLocator,
  type DetectorSystem,
  type ExecutableLookupSystem,
} from '../src/index.ts';

describe('program locator', () => {
  const system = (pc: {
    platform: NodeJS.Platform;
    path: string;
    executables: string[];
    files: Record<string, string>;
    links?: Record<string, string>;
  }): ExecutableLookupSystem & Pick<DetectorSystem, 'readText' | 'realPath'> => ({
    platform: pc.platform,
    homedir: pc.platform === 'win32' ? 'C:\\Users\\a' : '/home/a',
    env: { PATH: pc.path, PATHEXT: '.EXE;.CMD' },
    isExecutable: (path) => Promise.resolve(pc.executables.includes(path)),
    readText: (path) => Promise.resolve(pc.files[path] ?? null),
    realPath: (path) => Promise.resolve(pc.links?.[path] ?? path),
  });
  const manifest = JSON.stringify({
    name: 'ccstatusline',
    version: '2.2.22',
    bin: { ccstatusline: 'dist/cli.js' },
  });

  it('finds a global npm package on Windows (prefix/node_modules)', async () => {
    const find = createProgramLocator(
      system({
        platform: 'win32',
        path: 'C:\\nvm4w\\nodejs',
        executables: ['C:\\nvm4w\\nodejs\\ccstatusline.cmd'],
        files: { 'C:\\nvm4w\\nodejs\\node_modules\\ccstatusline\\package.json': manifest },
      }),
    );
    expect(await find('ccstatusline')).toEqual({
      command: 'ccstatusline',
      npm: { package: 'ccstatusline', version: '2.2.22' },
    });
  });

  it('finds a global npm package on macOS and Linux (prefix/lib/node_modules)', async () => {
    const find = createProgramLocator(
      system({
        platform: 'linux',
        path: '/usr/local/bin',
        executables: ['/usr/local/bin/ccstatusline'],
        files: { '/usr/local/lib/node_modules/ccstatusline/package.json': manifest },
      }),
    );
    expect((await find('ccstatusline'))?.npm?.version).toBe('2.2.22');
  });

  const mermaid = JSON.stringify({
    name: '@mermaid-js/mermaid-cli',
    version: '11.4.2',
    bin: { mmdc: 'src/cli.js' },
  });

  it('finds a scoped package whose bin name differs on macOS and Linux, by the link (BUG-02)', async () => {
    const find = createProgramLocator(
      system({
        platform: 'linux',
        path: '/usr/local/bin',
        executables: ['/usr/local/bin/mmdc'],
        links: {
          '/usr/local/bin/mmdc': '/usr/local/lib/node_modules/@mermaid-js/mermaid-cli/src/cli.js',
        },
        files: { '/usr/local/lib/node_modules/@mermaid-js/mermaid-cli/package.json': mermaid },
      }),
    );
    expect(await find('mmdc')).toEqual({
      command: 'mmdc',
      npm: { package: '@mermaid-js/mermaid-cli', version: '11.4.2' },
    });
  });

  it('finds a scoped package whose bin name differs on Windows, by the .cmd launcher (BUG-02)', async () => {
    const shim = [
      '@ECHO off',
      'SETLOCAL',
      'CALL :find_dp0',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@mermaid-js\\mermaid-cli\\src\\cli.js" %*',
    ].join('\r\n');
    const find = createProgramLocator(
      system({
        platform: 'win32',
        path: 'C:\\nvm4w\\nodejs',
        executables: ['C:\\nvm4w\\nodejs\\mmdc.cmd'],
        files: {
          'C:\\nvm4w\\nodejs\\mmdc.cmd': shim,
          'C:\\nvm4w\\nodejs\\node_modules\\@mermaid-js\\mermaid-cli\\package.json': mermaid,
        },
      }),
    );
    expect((await find('mmdc'))?.npm).toEqual({
      package: '@mermaid-js/mermaid-cli',
      version: '11.4.2',
    });
  });

  it('a program from elsewhere has no npm details; a missing one is null', async () => {
    const find = createProgramLocator(
      system({
        platform: 'linux',
        path: '/usr/bin',
        executables: ['/usr/bin/jq'],
        files: {},
      }),
    );
    expect(await find('jq')).toEqual({ command: 'jq', npm: null });
    expect(await find('nope')).toBeNull();
  });
});
