/**
 * The VideoOps design system.
 *
 * Every export here is presentational: it takes props and returns markup.
 * Nothing in this package fetches, authenticates, routes, or holds a query
 * client — that wiring lives in the application that composes these parts.
 */
export { AppShell, type AppShellProps } from './components/AppShell.js';
export {
  ArtifactPlayer,
  type ArtifactPlayerProps,
} from './components/ArtifactPlayer.js';
export {
  AttemptSummary,
  type AttemptSummaryProps,
} from './components/AttemptSummary.js';
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
} from './components/Button.js';
export {
  ConfirmPanel,
  type ConfirmPanelProps,
} from './components/ConfirmPanel.js';
export {
  EvaluationPanel,
  type EvaluationPanelProps,
} from './components/EvaluationPanel.js';
export {
  EventTimeline,
  type EventTimelineProps,
} from './components/EventTimeline.js';
export {
  FactList,
  type Fact,
  type FactListProps,
} from './components/FactList.js';
export {
  ErrorNotice,
  type ErrorNoticeProps,
  Notice,
  type NoticeProps,
} from './components/Notice.js';
export { Panel, type PanelProps } from './components/Panel.js';
export {
  ProgressBar,
  type ProgressBarProps,
} from './components/ProgressBar.js';
export {
  RecommendationCard,
  type RecommendationCardProps,
  RecommendationList,
  type RecommendationListProps,
} from './components/RecommendationCard.js';
export {
  RevisionHistory,
  type RevisionHistoryProps,
} from './components/RevisionHistory.js';
export {
  EmptyState,
  type EmptyStateProps,
  LoadingState,
  type LoadingStateProps,
} from './components/StateBlock.js';
export {
  StatusBadge,
  type StatusBadgeProps,
  type StatusTone,
  toneForStatus,
} from './components/StatusBadge.js';
export { TokenGate, type TokenGateProps } from './components/TokenGate.js';

export {
  formatDate,
  formatDuration,
  formatMoney,
  humanize,
  shortId,
} from './format.js';

export type {
  AttemptView,
  CheckResult,
  EvaluationView,
  RecommendationView,
  RevisionView,
  TimelineEvent,
  ValidationIssue,
} from './types.js';
