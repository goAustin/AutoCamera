import { TokenGate } from '@h3/ui';

export const Studio = () => <TokenGate onSubmit={() => undefined} />;

export const Embedded = () => (
  <TokenGate embedded onSubmit={() => undefined} />
);
