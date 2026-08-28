export type MediaEvaluationStatus = 'not-run' | 'passed' | 'failed';

export interface MediaEvaluationPlaceholder {
  readonly status: MediaEvaluationStatus;
  readonly reason: string;
}

export const PHASE_1_EVALUATION_PLACEHOLDER: MediaEvaluationPlaceholder = {
  status: 'not-run',
  reason: 'Media evaluation is introduced after bootstrap.',
};
