import { LoadingState } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const LoadingArtifact = () => (
  <Surface>
    <LoadingState label="Loading authorized artifact…" />
  </Surface>
);

export const LoadingRuns = () => (
  <Surface>
    <LoadingState label="Reading durable run history…" />
  </Surface>
);
