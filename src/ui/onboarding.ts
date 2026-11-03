/**
 * Whether this account has been welcomed — an **account** preference (#55).
 *
 * It used to be browser-wide, so on a shared device the second person to sign
 * in never saw the first-run screen, because the first already had. Whether the
 * screen is actually shown is `shouldOnboard` in `domain/onboardingGate.ts`,
 * which also requires an empty fuel log, so somebody returning with data is not
 * walked through it again just because this flag is missing.
 */

import { accountPreference, flagCodec, writePreference } from './preferences';

export const HAS_ONBOARDED = accountPreference('hasOnboarded', flagCodec('true'));

/** Marks `uid` as welcomed. Not worth failing a first run over if it does not stick. */
export function saveHasOnboarded(uid: string | null): void {
  writePreference(HAS_ONBOARDED, true, uid);
}
