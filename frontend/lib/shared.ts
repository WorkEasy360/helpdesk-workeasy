// Must stay the first import: it switches Zod to interpreted mode before any schema in the
// shared package is created (see lib/zod-config.ts). `@digisoft/shared` resolves to this file;
// frontend/shared itself is a byte-identical copy of the backend package and is not edited.
import '@/lib/zod-config';

export * from '../shared/index';
