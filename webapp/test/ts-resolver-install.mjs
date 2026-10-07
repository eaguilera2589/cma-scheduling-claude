/**
 * Test-only ESM resolution hook for `node --test` running TypeScript sources.
 *
 * Node's native type stripping executes .ts directly, but it does NOT resolve
 * TypeScript-style extensionless relative imports ("./types") or the Next.js
 * "@/..." alias. This hook adds exactly that, and only when the ".ts" target
 * actually exists — everything else (bare packages, JS package internals)
 * delegates to the default resolver via nextResolve().
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const p = path.join(root, 'src', `${specifier.slice(2)}.ts`);
      if (fs.existsSync(p)) return { shortCircuit: true, url: pathToFileURL(p).href };
      return nextResolve(specifier, context); // let the default produce a normal error
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/.test(specifier)) {
      let candidate;
      try {
        candidate = new URL(`${specifier}.ts`, context.parentURL);
      } catch {
        return nextResolve(specifier, context);
      }
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { shortCircuit: true, url: candidate.href };
      }
    }
    return nextResolve(specifier, context);
  },
});
