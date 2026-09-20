import { Notice } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const Info = () => (
  <Surface>
    <Notice variant="info">
      Technical evaluation is not available yet. The worker will add it after
      artifact ingestion.
    </Notice>
  </Surface>
);

export const Failure = () => (
  <Surface>
    <Notice variant="error">
      The executor rejected the workflow revision because node class
      MiniMaxH3Sampler is not installed on this host.
    </Notice>
  </Surface>
);
