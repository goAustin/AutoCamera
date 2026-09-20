import type { ReactElement, ReactNode } from 'react';

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
}

export interface FactListProps {
  readonly facts: readonly Fact[];
  /**
   * Column count on a wide viewport. Collapses to two columns under 760px and
   * one under 520px. Labels sit directly above their values at every width —
   * never justified to opposite edges, where the eye loses the pairing.
   */
  readonly columns?: 1 | 3 | 4 | undefined;
}

/** A definition list of short label/value pairs. */
export function FactList({ facts, columns = 1 }: FactListProps): ReactElement {
  const className =
    columns === 1 ? 'fact-list' : `fact-list fact-list--columns-${columns}`;
  return (
    <dl className={className}>
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
