import { ErrorNotice } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const WithTrace = () => (
  <Surface>
    <ErrorNotice
      message="The attempt could not be accepted (ATTEMPT_NOT_EVALUATED)"
      traceId="bdf2fb9f6efc5025c1de79c0ee9815c6"
    />
  </Surface>
);

export const Retryable = () => (
  <Surface>
    <ErrorNotice
      message="The VideoOps API did not respond within the timeout."
      traceId="4c1ea77b90335da2f6b0128de5731ac9"
      onRetry={() => undefined}
    />
  </Surface>
);

export const Bare = () => (
  <Surface>
    <ErrorNotice message="The development bearer token was rejected." />
  </Surface>
);
