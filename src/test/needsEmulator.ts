/**
 * Global setup for the rules project: stops the run, with the reason, when no
 * Firestore emulator is running. See `prerequisites.ts`.
 */
import { emulatorMissing, prerequisiteError } from './prerequisites';

export function setup(): void {
  const missing = emulatorMissing(process.env);
  if (missing !== null) throw prerequisiteError(missing);
}
