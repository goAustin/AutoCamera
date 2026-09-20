/**
 * Presentational shapes. Deliberately narrower than the API types in
 * `@h3/domain`: a component in this library renders what it is handed and
 * never reaches for the network, a token, or a query client. Callers map
 * their domain records onto these — which is also where redaction belongs.
 */
import type { ReactNode } from 'react';

export interface CheckResult {
  readonly status: string;
  readonly detail: string;
}

export interface EvaluationView {
  readonly status: string;
  readonly checks: Readonly<Record<string, CheckResult>>;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly evaluatorVersion: string;
  readonly evaluatedAt: string;
}

export interface TimelineEvent {
  readonly id: string;
  /** Already-humanized event name. */
  readonly title: string;
  readonly timestamp: string;
  readonly sequence?: number | undefined;
  /** Pre-filtered, caller-redacted summary line. */
  readonly detail?: string | undefined;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface RevisionView {
  readonly id: string;
  readonly revisionNumber: number;
  readonly validationStatus: string;
  readonly source: string;
  readonly createdAt: string;
  readonly executionHash: string;
  readonly parentRevisionId?: string | undefined;
  readonly validationErrors: readonly ValidationIssue[];
}

export interface RecommendationView {
  readonly id: string;
  readonly severity: string;
  readonly title: string;
  readonly detail: string;
  readonly recommendationCode: string;
  /** Already-humanized action name. */
  readonly proposedAction: string;
}

export interface AttemptView {
  readonly id: string;
  readonly status: string;
  readonly queuedAt: string;
  readonly workflowHash: string;
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly requestedDurationSeconds: number;
  readonly seed: number | string;
  readonly estimatedCostUsd: string | number;
  readonly sourceAttemptId?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly failureMessage?: string | undefined;
}

export type Slot = ReactNode;
