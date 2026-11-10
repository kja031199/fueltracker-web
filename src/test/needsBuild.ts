/**
 * Global setup for the build project: stops the run, with the reason, when
 * there is no build in `dist/` to read. See `prerequisites.ts`.
 */
import { existsSync } from 'node:fs';
import { buildMissing, prerequisiteError } from './prerequisites';

export function setup(): void {
  const missing = buildMissing(existsSync);
  if (missing !== null) throw prerequisiteError(missing);
}
