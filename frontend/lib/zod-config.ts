import { z } from 'zod';

/**
 * Zod 4 compiles object schemas into specialised functions with `new Function(...)`, and
 * probes for that ability (`Function("")`) when the first object schema is created. This
 * app's Content-Security-Policy forbids string evaluation (no `unsafe-eval`), so the probe is
 * a policy violation on every page. Interpreted mode behaves identically, just without the
 * fast path.
 *
 * The flag is read when a schema is CREATED, so this module must run before any schema is
 * built: it is imported first by `lib/shared.ts` (which is what `@digisoft/shared` resolves
 * to, see tsconfig.json) and by every frontend file that imports `zod` itself. A test
 * (e2e/zod-csp.spec.ts) fails when a file forgets.
 */
z.config({ jitless: true });

export {};
