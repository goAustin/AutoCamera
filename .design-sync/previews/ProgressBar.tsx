import { ProgressBar } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const Sweep = () => (
  <Surface>
    <div style={{ display: 'grid', gap: '1rem' }}>
      <ProgressBar value={2} max={20} />
      <ProgressBar value={11} max={20} />
      <ProgressBar value={20} max={20} />
    </div>
  </Surface>
);

export const CustomCaption = () => (
  <Surface>
    <ProgressBar value={7} max={12} caption="sampling steps · MiniMax H3" />
  </Surface>
);
