import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button.js';

export interface AppShellProps {
  /**
   * Wraps the brand mark in the host's navigation link. The default renders a
   * plain anchor; pass a router link to keep navigation client-side.
   */
  readonly renderHomeLink?: ((children: ReactNode) => ReactElement) | undefined;
  /** Environment label shown beside the sign-out action. */
  readonly mode?: string | undefined;
  readonly onSignOut?: (() => void) | undefined;
  readonly children: ReactNode;
}

const BRAND = (
  <>
    <span className="brand-mark" aria-hidden="true" />
    <span>
      <strong>VideoOps</strong>
      <small>Project Studio</small>
    </span>
  </>
);

function defaultHomeLink(children: ReactNode): ReactElement {
  return (
    <a className="brand" href="/" aria-label="H3 VideoOps home">
      {children}
    </a>
  );
}

/** The outer frame: brand, environment, sign-out, and the page below. */
export function AppShell({
  renderHomeLink = defaultHomeLink,
  mode = 'Local development',
  onSignOut,
  children,
}: AppShellProps): ReactElement {
  return (
    <div className="app-frame videoops-surface">
      <header className="app-header">
        {renderHomeLink(BRAND)}
        <div className="header-actions">
          <span className="header-mode">{mode}</span>
          {onSignOut && <Button onClick={onSignOut}>Sign out</Button>}
        </div>
      </header>
      {children}
    </div>
  );
}
