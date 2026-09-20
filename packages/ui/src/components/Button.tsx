import type { ReactElement, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'quiet' | 'danger';

export interface ButtonProps {
  /** Visual weight. One `primary` per surface; `danger` for destructive actions. */
  readonly variant?: ButtonVariant | undefined;
  /** Native button behaviour. `submit` participates in the enclosing form. */
  readonly type?: 'button' | 'submit' | undefined;
  readonly disabled?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  /** Accessible name when the label alone is not descriptive. */
  readonly ariaLabel?: string | undefined;
  readonly children: ReactNode;
}

/**
 * The only button in the system. Every action surface composes this rather
 * than hand-writing `className="button button--*"`.
 */
export function Button({
  variant = 'quiet',
  type = 'button',
  disabled = false,
  onClick,
  ariaLabel,
  children,
}: ButtonProps): ReactElement {
  return (
    <button
      className={`button button--${variant}`}
      type={type === 'submit' ? 'submit' : 'button'}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
