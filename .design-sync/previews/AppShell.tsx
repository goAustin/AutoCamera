import { AppShell, Button, FactList, Panel, StatusBadge } from '@h3/ui';

export const Studio = () => (
  <AppShell mode="Local development" onSignOut={() => undefined}>
    <main style={{ width: 'min(100% - 2.5rem, 1440px)', margin: '1.5rem auto' }}>
      <Panel
        title="Selected run"
        titleId="shell-run"
        action={<StatusBadge status="awaiting_review" />}
      >
        <FactList
          columns={3}
          facts={[
            { label: 'Evaluation', value: 'Passed' },
            { label: 'Estimated cost', value: '$0.10' },
            { label: 'Budget headroom', value: '$24.90' },
          ]}
        />
        <div className="button-row" style={{ marginTop: '1rem' }}>
          <Button variant="primary">Accept passing attempt</Button>
          <Button variant="quiet">Reject</Button>
        </div>
      </Panel>
    </main>
  </AppShell>
);
