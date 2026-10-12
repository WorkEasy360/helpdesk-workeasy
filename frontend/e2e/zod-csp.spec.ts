import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The app's Content-Security-Policy has no `unsafe-eval`. Zod 4 probes for string evaluation
 * (`Function("")`) the first time an object schema is created unless it is switched to
 * interpreted mode first, and the probe is a CSP violation on every page. These tests keep
 * that switch in front of every schema. (No browser needed.)
 */

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.next', 'shared', 'e2e', 'test-results', 'playwright-report']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

test.describe('zod is switched to interpreted mode before any schema is created', () => {
  test('every frontend file that imports zod imports the config first', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sourceFiles(root)) {
      if (file.endsWith(path.join('lib', 'zod-config.ts'))) continue;
      const source = readFileSync(file, 'utf8');
      const zodImport = source.search(/from\s+'zod'/);
      if (zodImport < 0) continue;
      checked += 1;
      const config = source.indexOf("import '@/lib/zod-config'");
      if (config < 0 || config > zodImport) offenders.push(path.relative(root, file));
    }
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('@digisoft/shared resolves to the wrapper whose first import is the config', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(tsconfig.compilerOptions.paths['@digisoft/shared']).toEqual(['./lib/shared.ts']);
    const wrapper = readFileSync(path.join(root, 'lib', 'shared.ts'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('import') || line.startsWith('export'));
    expect(wrapper[0]).toBe("import '@/lib/zod-config';");
    expect(wrapper[1]).toContain("'../shared/index'");
  });

  test('nothing imports the shared package by a path that skips the wrapper', () => {
    const offenders = sourceFiles(root)
      .filter((file) => /from\s+'(\.\.?\/)+shared(\/|')/.test(readFileSync(file, 'utf8')))
      .filter((file) => !file.endsWith(path.join('lib', 'shared.ts')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  test('parsing with the shared schemas never evaluates code', () => {
    const forget = () => {
      for (const key of Object.keys(require.cache)) {
        if (/node_modules[\\/]zod[\\/]|[\\/]frontend[\\/](shared|lib)[\\/]/.test(key)) delete require.cache[key];
      }
    };
    const realFunction = globalThis.Function;
    let evaluations = 0;
    const counting = new Proxy(realFunction, {
      construct(target, args, newTarget) {
        evaluations += 1;
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, thisArg, args) {
        evaluations += 1;
        return Reflect.apply(target, thisArg, args as unknown[]);
      },
    });

    // Control: the shared package on its own (no config) does probe for string evaluation, so
    // the counter would notice.
    forget();
    globalThis.Function = counting as FunctionConstructor;
    try {
      // Zod keeps its settings on a global, so another test file in this worker may already have
      // switched it to interpreted mode: put it back to the default for the control.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('zod') as typeof import('zod')).z.config({ jitless: false });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bare = require('../shared/auth') as typeof import('../shared/auth');
      bare.loginSchema.safeParse({ email: 'a@b.example', password: 'x' });
      expect(evaluations).toBeGreaterThan(0);

      // Through the wrapper (what the app imports): no evaluation at all.
      forget();
      evaluations = 0;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wrapped = require('../lib/shared') as typeof import('../shared/index');
      const parsed = wrapped.loginSchema.safeParse({ email: 'A@B.example', password: 'x' });
      expect(parsed.success).toBe(true);
      expect(wrapped.registerSchema.safeParse({}).success).toBe(false);
      expect(wrapped.createUserSchema.safeParse({}).success).toBe(false);
      expect(evaluations).toBe(0);
    } finally {
      globalThis.Function = realFunction;
      forget();
    }
  });
});
