import type { ReactElement } from 'react';
import { useRef } from 'react';

/**
 * "Fill in from a receipt photo" (#93: moved out of the fill-up form): the
 * button, the hidden file picker, what it does, and what the last read said.
 */
export function ReceiptScanField({
  scanning,
  note,
  onFile,
}: {
  readonly scanning: boolean;
  /** What the last read said, or null. */
  readonly note: string | null;
  readonly onFile: (file: File) => void;
}): ReactElement {
  const photoInput = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <button
        className="button button--secondary"
        type="button"
        onClick={() => photoInput.current?.click()}
        disabled={scanning}
      >
        {scanning ? 'Reading the photo…' : 'Fill in from a receipt photo'}
      </button>
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) onFile(file);
        }}
      />
      <p className="note flush">
        Photograph a paper receipt and the gallons, price, date and station are filled in for you — into empty fields
        only, so nothing you typed is overwritten. Pump displays are not supported; their segment digits are not
        readable by this. Needs a connection the first time.
      </p>
      {note !== null && (
        <p className="warning space-above-sm" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
