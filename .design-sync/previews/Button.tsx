import { Button } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
    {children}
  </div>
);

export const Variants = () => (
  <Surface>
    <Row>
      <Button variant="primary">Accept passing attempt</Button>
      <Button variant="quiet">Reject</Button>
      <Button variant="danger">Reject attempt</Button>
    </Row>
  </Surface>
);

export const Disabled = () => (
  <Surface>
    <Row>
      <Button variant="primary" disabled>
        Accept passing attempt
      </Button>
      <Button variant="quiet" disabled>
        Retry with confirmation
      </Button>
      <Button variant="danger" disabled>
        Reject attempt
      </Button>
    </Row>
  </Surface>
);

export const ReviewActions = () => (
  <Surface>
    <Row>
      <Button variant="primary">Apply recommendation</Button>
      <Button variant="quiet">Dismiss</Button>
    </Row>
  </Surface>
);
