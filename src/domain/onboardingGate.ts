/**
 * The pure decision of whether to show the first-run experience, ported from
 * `Shared/Support/OnboardingGate.swift`.
 *
 * Kept apart from the view so the "who sees onboarding" rule can be tested
 * rather than inferred from a render.
 */

/**
 * Onboarding is shown only to a genuinely new user: one who has not finished
 * (or skipped) it **and** has no vehicles yet.
 *
 * The second condition is the one that earns its keep. A user who already has
 * data — upstream, vehicles synced from iCloud onto a fresh install; here, an
 * imported backup or a second browser profile — is never onboarded, even though
 * the completion flag has never been set on this device.
 */
export function shouldOnboard(hasCompleted: boolean, vehicleCount: number): boolean {
  return !hasCompleted && vehicleCount === 0;
}
