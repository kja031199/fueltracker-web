import type { ReactElement, ReactNode } from 'react';
import { currency } from '../domain/format';

/**
 * One fill-up as a list shows it (#93): what it was, the grey facts line, its
 * notes, and what it cost on the right.
 *
 * The fill-up list and the review list each drew this by hand. The facts come
 * from `fillUpFacts` (`domain/format.ts`), so both lines are worded the same.
 */
export function FillUpSummary({
  title,
  subtitle = '',
  facts,
  notes,
  cost,
  children,
}: {
  /** The bold part: a date, or a car's name. */
  readonly title: ReactNode;
  /** After the title, in grey, following " · ". Left out when empty. */
  readonly subtitle?: string;
  readonly facts: readonly string[];
  readonly notes: string;
  readonly cost: number;
  /** Any further lines, under the notes. */
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <div>
        <strong>{title}</strong>
        {subtitle !== '' && <span style={{ color: 'var(--text-secondary)' }}> · {subtitle}</span>}
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{facts.join(' · ')}</div>
        {notes !== '' && <div style={{ fontSize: '0.9rem' }}>{notes}</div>}
        {children}
      </div>
      <strong>{currency(cost)}</strong>
    </div>
  );
}
