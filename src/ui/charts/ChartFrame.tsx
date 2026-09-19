import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';

interface Row {
  readonly label: string;
  readonly value: string;
}

interface Props {
  readonly title: string;
  /** One sentence describing the series — the gist, before the detail. */
  readonly summary: string | null;
  /** Every point, for a reader navigating values rather than seeing shape. */
  readonly rows: readonly Row[];
  readonly rowHeadings: readonly [string, string];
  readonly children: ReactNode;
}

/**
 * The shell every chart sits in, and where its accessibility actually lives.
 *
 * ## Why a table, not labelled marks
 *
 * The iOS app pairs a spoken summary with an **audio graph** — VoiceOver plays
 * the shape of a series as sound. The web has no equivalent, so the summary
 * would be carrying the whole load on its own.
 *
 * So the drawing is `role="img"` with the summary as its label — the gist in
 * one sentence — and beside it sits a real `<table>` of every point, visible
 * only to assistive technology. That is strictly more useful than per-mark
 * ARIA on SVG: a table can be navigated cell by cell, read in any order, and
 * announces its own row and column headers, where a bag of labelled `<path>`
 * elements cannot.
 */
export function ChartFrame({
  title,
  summary,
  rows,
  rowHeadings,
  children,
}: Props): ReactElement {
  const tableId = useId();

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption className="card__title">{title}</figcaption>

      <div
        role="img"
        aria-label={summary === null ? `${title}: no data yet.` : `${title}. ${summary}`}
      >
        {children}
      </div>

      {rows.length > 0 && (
        <>
          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Show the numbers
            </summary>
            <table id={tableId} className="chart__table">
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{rowHeadings[0]}</th>
                  <th scope="col">{rowHeadings[1]}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </figure>
  );
}
