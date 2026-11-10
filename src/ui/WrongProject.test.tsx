import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WrongProjectScreen } from './WrongProjectScreen';

/**
 * What a development build shows when `.env.local` points at production (#45).
 *
 * The reader is a developer, so it says exactly what is wrong and where the fix
 * is written down — and it must not look like a sign-in screen, because nothing
 * behind it was started.
 */
describe('WrongProjectScreen', () => {
  test('says the build is pointed at production and names the project', () => {
    render(<WrongProjectScreen projectId="fueltracker-899eb" />);
    expect(
      screen.getByRole('heading', { name: /pointed at the production project/i }),
    ).toBeTruthy();
    expect(screen.getByText('fueltracker-899eb')).toBeTruthy();
  });

  test('says where the fix is written down', () => {
    render(<WrongProjectScreen projectId="fueltracker-899eb" />);
    expect(screen.getByText('docs/deploying.md')).toBeTruthy();
  });

  test('offers no way to sign in', () => {
    render(<WrongProjectScreen projectId="fueltracker-899eb" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
