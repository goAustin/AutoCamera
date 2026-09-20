import { EmptyState } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const NoRuns = () => (
  <Surface>
    <EmptyState
      title="No managed runs"
      detail="Managed Run exports will be recorded here."
    />
  </Surface>
);

export const NoRecommendations = () => (
  <Surface>
    <EmptyState
      title="No pending recommendations"
      detail="Operational signals will appear here when the durable event loop needs attention."
    />
  </Surface>
);

export const NoRevisions = () => (
  <Surface>
    <EmptyState
      title="No revisions yet"
      detail="Create a revision after saving or exporting a draft."
    />
  </Surface>
);
