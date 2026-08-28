export type Phase1ServiceStatus = 'bootstrapping' | 'ready' | 'degraded';

export interface ServiceHealth {
  readonly service: string;
  readonly status: Phase1ServiceStatus;
  readonly checkedAt: string;
}

export const DOMAIN_PACKAGE_NAME = '@h3/domain' as const;
