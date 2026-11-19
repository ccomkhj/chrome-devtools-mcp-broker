import { createRequire } from 'node:module';

/** The package version. package.json is the only place it is written down. */
export const version = createRequire(import.meta.url)('../package.json').version;
if (typeof version !== 'string' || version === '') throw new Error('package.json has no version.');
