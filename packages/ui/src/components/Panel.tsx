import type { ReactElement, ReactNode } from 'react';

export interface PanelProps {
  /** The section's heading. Keep it human — not an internal event name. */
  readonly title: string;
  /** Small uppercase label above the title. Use sparingly: at most one per screen. */
  readonly kicker?: string | undefined;
  /** Count shown as a pill on the right of the heading. */
  readonly count?: number | undefined;
  /** Explanatory sentence under the heading. */
  readonly intro?: string | undefined;
  /** Content rendered to the right of the heading instead of a count. */
  readonly action?: ReactNode | undefined;
  /** Ties the section to its heading for assistive technology. */
  readonly titleId?: string | undefined;
  readonly children: ReactNode;
}

/**
 * The standard bordered section. One level of border only — content inside a
 * Panel should group with spacing and labels, never another nested frame.
 */
export function Panel({
  title,
  kicker,
  count,
  intro,
  action,
  titleId,
  children,
}: PanelProps): ReactElement {
  return (
    <section className="panel" aria-labelledby={titleId}>
      <div className="panel-heading">
        <div>
          {kicker && <span className="section-kicker">{kicker}</span>}
          <h3 id={titleId}>{title}</h3>
        </div>
        {action ??
          (count === undefined ? null : (
            <span className="count-badge">{count}</span>
          ))}
      </div>
      {intro && <p className="panel-intro">{intro}</p>}
      <div className="panel-body">{children}</div>
    </section>
  );
}
