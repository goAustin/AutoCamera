import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

interface ApiReadiness {
  readonly service: 'api';
  readonly status: 'ok' | 'degraded';
  readonly dependencies: {
    readonly postgres: 'ok' | 'unavailable';
  };
}

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000';

async function fetchReadiness(): Promise<ApiReadiness> {
  const response = await fetch(`${apiOrigin}/health/ready`);
  const payload: unknown = await response.json();

  if (!response.ok) {
    throw new Error('API is not ready.');
  }

  if (!isApiReadiness(payload)) {
    throw new Error('API returned an unexpected readiness response.');
  }

  return payload;
}

function isApiReadiness(value: unknown): value is ApiReadiness {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ApiReadiness>;
  return (
    candidate.service === 'api' &&
    (candidate.status === 'ok' || candidate.status === 'degraded') &&
    typeof candidate.dependencies === 'object' &&
    candidate.dependencies !== null &&
    'postgres' in candidate.dependencies
  );
}

export function App(): ReactElement {
  const readiness = useQuery({
    queryKey: ['api-readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 5_000,
  });

  const status = readiness.isPending
    ? 'Checking API readiness…'
    : readiness.isError
      ? 'API unavailable'
      : readiness.data.status === 'ok'
        ? 'API ready'
        : 'API waiting for PostgreSQL';

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">LOCAL OPERATIONS CONSOLE</p>
        <h1 id="page-title">H3 VideoOps</h1>
        <p className="lede">
          A durable control-plane shell for the H3 video workflow. Bootstrap is
          online; generation modules arrive in the later phases.
        </p>
        <div className="status-card" role="status" aria-live="polite">
          <span
            className={`status-dot ${readiness.isSuccess ? 'status-dot--ready' : ''}`}
            aria-hidden="true"
          />
          <div>
            <span className="status-label">API readiness</span>
            <strong>{status}</strong>
          </div>
          {readiness.isSuccess && (
            <span className="dependency">
              PostgreSQL: {readiness.data.dependencies.postgres}
            </span>
          )}
        </div>
      </section>
    </main>
  );
}
