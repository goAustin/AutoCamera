import type { ReactElement } from 'react';
import { Button } from './Button.js';

export interface ConfirmPanelProps {
  readonly title: string;
  /** Spells out the consequence — budget spent, state made terminal. */
  readonly detail: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Disables both actions and shows progress on the confirm button. */
  readonly busy?: boolean | undefined;
  /** Renders the confirm action in the destructive tone. */
  readonly destructive?: boolean | undefined;
}

/** The inline confirmation gate in front of any consequential action. */
export function ConfirmPanel({
  title,
  detail,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  busy = false,
  destructive = false,
}: ConfirmPanelProps): ReactElement {
  return (
    <div className="confirm-panel" role="alertdialog" aria-label={title}>
      <strong>{title}</strong>
      <p>{detail}</p>
      <div className="button-row">
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
