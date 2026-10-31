/**
 * The current auth state, as React state.
 *
 * Thin on purpose: the provider already pushes changes and already replays the
 * current value to a new subscriber, so this is a subscription and nothing
 * more. No loading flag of its own, no retry logic — `AuthState.loading` is the
 * provider's to report, and duplicating it here would let the two disagree.
 */

import { useEffect, useState } from 'react';
import type { AuthProvider, AuthState } from '../data/auth';

export function useAuth(provider: AuthProvider): AuthState {
  const [state, setState] = useState<AuthState>(() => provider.state());

  useEffect(() => {
    // `subscribe` calls back immediately, so a state change between the
    // `useState` initialiser and this effect cannot be missed.
    return provider.subscribe(setState);
  }, [provider]);

  return state;
}
