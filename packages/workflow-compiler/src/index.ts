export interface WorkflowFixture {
  readonly version: string;
  readonly name: string;
  readonly hash: string;
}

export const PHASE_1_WORKFLOW_FIXTURE: WorkflowFixture = {
  version: 'phase-1-placeholder',
  name: 'placeholder-t2v',
  hash: 'not-generated-in-phase-1',
};
