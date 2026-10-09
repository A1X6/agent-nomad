import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The CLI's modules import each other in one direction (review 17 ARCH-01): a cycle loads in
 * whatever order the first importer dictates and breaks the moment a `const` crosses it, so
 * none is allowed. Type-only imports are erased and do not count.
 */

const SRC = resolve(import.meta.dirname, '..', 'src');

/** Every `import … from './x.ts'` and `export … from './x.ts'` that stays at runtime. */
const RUNTIME_IMPORT = /^(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+'(\.[^']+)'/gm;

async function sourceFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** Each module's runtime imports, as paths from `src/` with forward slashes. */
async function importGraph(): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  for (const file of await sourceFiles(SRC)) {
    const text = await readFile(file, 'utf8');
    const imports = [...text.matchAll(RUNTIME_IMPORT)].map((match) =>
      relative(SRC, resolve(dirname(file), match[1] ?? ''))
        .split(sep)
        .join('/'),
    );
    graph.set(relative(SRC, file).split(sep).join('/'), imports);
  }
  return graph;
}

/** The first cycle found, as the modules on it, or `null`. */
function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const done = new Set<string>();
  const onPath: string[] = [];
  const visit = (module: string): string[] | null => {
    const at = onPath.indexOf(module);
    if (at !== -1) return [...onPath.slice(at), module];
    if (done.has(module)) return null;
    onPath.push(module);
    for (const imported of graph.get(module) ?? []) {
      const cycle = visit(imported);
      if (cycle !== null) return cycle;
    }
    onPath.pop();
    done.add(module);
    return null;
  };
  for (const module of graph.keys()) {
    const cycle = visit(module);
    if (cycle !== null) return cycle;
  }
  return null;
}

describe('the import graph of packages/cli/src (review 17 ARCH-01)', () => {
  it('has no cycle among runtime imports', async () => {
    const graph = await importGraph();
    expect(graph.size).toBeGreaterThan(50);
    expect(findCycle(graph)).toBeNull();
  });

  it('would catch one', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts']],
      ['d.ts', ['a.ts']],
    ]);
    expect(findCycle(graph)).toEqual(['a.ts', 'b.ts', 'c.ts', 'a.ts']);
  });
});
