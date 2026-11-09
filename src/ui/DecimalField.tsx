import type { ReactElement } from 'react';

/**
 * A labelled field for a number typed as text (#93): the odometer, the volume
 * and the price were three copies of this. Text, not `type="number"`, so what
 * is typed stays on screen as typed — see `useFillUpForm`'s note on decimals.
 */
export function DecimalField({
  id,
  label,
  value,
  onChange,
  describedBy,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** The id of a warning about this value, while one is shown. */
  readonly describedBy?: string | undefined;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={describedBy}
      />
    </div>
  );
}
