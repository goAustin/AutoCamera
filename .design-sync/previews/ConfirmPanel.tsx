import { ConfirmPanel } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const BudgetRetry = () => (
  <Surface>
    <ConfirmPanel
      title="Spend budget on a derived retry?"
      detail="This creates a new immutable attempt and reserves the server-enforced preview cost. The source attempt remains terminal."
      confirmLabel="Confirm retry"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  </Surface>
);

export const ResolveUncertain = () => (
  <Surface>
    <ConfirmPanel
      title="Resolve and retry this attempt?"
      detail="The original ComfyUI submission is uncertain. Confirm that a human has resolved that uncertainty before creating a new attempt."
      confirmLabel="Confirm resolved retry"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  </Surface>
);

export const Destructive = () => (
  <Surface>
    <ConfirmPanel
      title="Reject this attempt?"
      detail="Rejecting is terminal for this attempt. A derived retry must be created explicitly afterwards."
      confirmLabel="Reject attempt"
      destructive
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  </Surface>
);

export const Busy = () => (
  <Surface>
    <ConfirmPanel
      title="Apply a budget-spending recommendation?"
      detail="This human-approved action will create a derived retry after the server rechecks scope, limits, budget, workflow validation, and executor capability."
      confirmLabel="Apply and retry"
      busy
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  </Surface>
);
