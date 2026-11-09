import type { ReactElement } from 'react';

/**
 * A button that asks before it acts (#93): the first press shows a confirm
 * and a way out, and only the confirm does the thing.
 *
 * There were three hand-written copies — leaving a shared car, deleting a car,
 * deleting a fill-up. Controlled rather than holding its own state, so a list
 * still has at most one row asking at a time: the screen keeps which one.
 */
export interface ConfirmButtonProps {
  /** Whether it is asking now. */
  readonly asking: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** The first button: "Delete", "Leave". */
  readonly label: string;
  /** The button that acts: "Delete this fill-up". */
  readonly confirmLabel: string;
  /** The way out: "Keep", "Stay". */
  readonly cancelLabel: string;
  /** How the first button looks. Leaving is not destructive; deleting is. */
  readonly tone?: 'danger' | 'secondary';
}

export function ConfirmButton({
  asking,
  onAsk,
  onCancel,
  onConfirm,
  label,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
}: ConfirmButtonProps): ReactElement {
  if (!asking) {
    return (
      <button className={`button button--${tone}`} type="button" onClick={onAsk}>
        {label}
      </button>
    );
  }
  return (
    <>
      <button className="button button--danger" type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button className="button button--secondary" type="button" onClick={onCancel}>
        {cancelLabel}
      </button>
    </>
  );
}
