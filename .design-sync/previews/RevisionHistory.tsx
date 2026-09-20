import { RevisionHistory } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const revisions = [
  {
    id: '01a072c3-87f9-78e1-a2e5-deb3071acb35',
    revisionNumber: 3,
    validationStatus: 'validated',
    source: 'comfy_export',
    createdAt: '2026-09-06T02:09:51.000Z',
    executionHash: '6e7ec38830a94f11c0de5b2a7c118d43',
    parentRevisionId: '01a072c3-7cb1-7a40-9f22-118d43c0de5b',
    validationErrors: [],
  },
  {
    id: '01a072c3-7cb1-7a40-9f22-118d43c0de5b',
    revisionNumber: 2,
    validationStatus: 'invalid',
    source: 'studio_draft',
    createdAt: '2026-09-06T02:04:12.000Z',
    executionHash: 'c0de5b2a7c118d436e7ec38830a94f11',
    validationErrors: [
      {
        code: 'NODE_CLASS_UNRESOLVED',
        message: 'MiniMaxH3Sampler is not installed on this executor.',
      },
    ],
  },
];

export const WithSelection = () => (
  <Surface>
    <RevisionHistory
      revisions={revisions}
      selectedRevisionId={revisions[0].id}
      onUse={() => undefined}
      onValidate={() => undefined}
    />
  </Surface>
);

export const ReadOnly = () => (
  <Surface>
    <RevisionHistory revisions={revisions} />
  </Surface>
);

export const Empty = () => (
  <Surface>
    <RevisionHistory revisions={[]} />
  </Surface>
);
