import { describe, expect, it } from 'vitest';
import {
  addMicrousd,
  assertUuid,
  createShot,
  createUuidV7,
  createVideoProject,
  DOMAIN_EVENT_TYPES,
  DomainError,
  formatMicrousdToUsd,
  parseDomainEventType,
  parseProjectStatus,
  parseShotStatus,
  parseUsdToMicrousd,
  PROJECT_STATUS_TRANSITIONS,
  SHOT_STATUS_TRANSITIONS,
  subtractMicrousd,
  toIsoUtc,
  transitionProject,
  transitionShot,
  type ProjectStatus,
  type Shot,
  type ShotStatus,
  type Uuid,
} from './index.js';

const timestamp = toIsoUtc(new Date('2026-01-01T00:00:00.000Z'));

function expectDomainCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

function id(seed: number): Uuid {
  return createUuidV7(1_700_000_000_000 + seed, new Uint8Array(10).fill(seed));
}

function projectWithStatus(status: ProjectStatus) {
  return {
    id: id(1),
    tenantId: id(2),
    title: 'Test project',
    brief: 'A deterministic test brief.',
    status,
    targetDurationSeconds: 5,
    budgetMicrousd: parseUsdToMicrousd('25'),
    spentMicrousd: parseUsdToMicrousd('0'),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function shotWithStatus(status: ShotStatus): Shot {
  const acceptedAttemptId = status === 'accepted' ? id(9) : undefined;
  const shot: Shot = {
    id: id(5),
    projectId: id(6),
    storyboardProposalId: id(7),
    ordinal: 1,
    purpose: 'Purpose',
    prompt: 'Prompt',
    durationSeconds: 1,
    mode: 't2v',
    qualityTier: 'preview',
    status,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return acceptedAttemptId ? { ...shot, acceptedAttemptId } : shot;
}

describe('domain transitions', () => {
  it('allows every documented project transition', () => {
    for (const [current, nextStatuses] of Object.entries(
      PROJECT_STATUS_TRANSITIONS,
    ) as [ProjectStatus, readonly ProjectStatus[]][]) {
      for (const next of nextStatuses) {
        expect(transitionProject(projectWithStatus(current), next).status).toBe(
          next,
        );
      }
    }
  });

  it('rejects every undocumented project transition and unknown status', () => {
    for (const [current, nextStatuses] of Object.entries(
      PROJECT_STATUS_TRANSITIONS,
    ) as [ProjectStatus, readonly ProjectStatus[]][]) {
      for (const next of Object.keys(
        PROJECT_STATUS_TRANSITIONS,
      ) as ProjectStatus[]) {
        if (!nextStatuses.includes(next)) {
          expect(() =>
            transitionProject(projectWithStatus(current), next),
          ).toThrow();
        }
      }
    }
    expectDomainCode(
      () => parseProjectStatus('future-status'),
      'UNKNOWN_PROJECT_STATUS',
    );
    expectDomainCode(
      () => transitionProject(projectWithStatus('draft'), 'future-status'),
      'UNKNOWN_PROJECT_STATUS',
    );
  });

  it('allows and rejects every documented shot transition', () => {
    for (const [current, nextStatuses] of Object.entries(
      SHOT_STATUS_TRANSITIONS,
    ) as [ShotStatus, readonly ShotStatus[]][]) {
      for (const next of nextStatuses) {
        if (next === 'accepted' && current === 'awaiting_review') {
          expectDomainCode(
            () => transitionShot(shotWithStatus(current), next),
            'ACCEPTED_SHOT_REQUIRES_ATTEMPT',
          );
          continue;
        }
        expect(transitionShot(shotWithStatus(current), next).status).toBe(next);
      }
      for (const next of Object.keys(SHOT_STATUS_TRANSITIONS) as ShotStatus[]) {
        if (!nextStatuses.includes(next)) {
          expect(() => transitionShot(shotWithStatus(current), next)).toThrow();
        }
      }
    }
    expectDomainCode(
      () => parseShotStatus('future-status'),
      'UNKNOWN_SHOT_STATUS',
    );
  });

  it('models recoverable attention states without reopening terminal attempts', () => {
    const projectNeedsAttention = transitionProject(
      projectWithStatus('generating'),
      'needs_attention',
    );
    expect(projectNeedsAttention.status).toBe('needs_attention');
    expect(transitionProject(projectNeedsAttention, 'generating').status).toBe(
      'generating',
    );

    const shotRetryable = transitionShot(
      shotWithStatus('generating'),
      'retryable',
    );
    expect(shotRetryable.status).toBe('retryable');
    expect(transitionShot(shotRetryable, 'queued').status).toBe('queued');
  });
});

describe('historical domain-event retention (Phase 7D)', () => {
  // Phase 7D removed the brief-first product's emitters, but `domain_events`
  // is append-only (design reference section 4, invariant three): any
  // Phase 7C database that was ever used still contains rows typed with
  // these five planner-era strings. `packages/db/src/index.ts`'s `mapEvent`
  // calls `parseDomainEventType` on every row it reads back, and that
  // function throws `UNKNOWN_EVENT_TYPE` for a value absent from
  // `DOMAIN_EVENT_TYPES`. Removing a string here would make those historical
  // rows unreadable, not delete them -- the event timeline would throw and
  // SSE replay would throw. This test is the regression guard for that.
  const retainedPlannerEraTypes = [
    'project.planning_started',
    'project.planned',
    'storyboard.proposed',
    'storyboard.superseded',
    'storyboard.approved',
  ] as const;

  it('keeps every planner-era event type in DOMAIN_EVENT_TYPES', () => {
    for (const type of retainedPlannerEraTypes) {
      expect(DOMAIN_EVENT_TYPES).toContain(type);
    }
  });

  it('still parses a historical row typed with a planner-era event type', () => {
    for (const type of retainedPlannerEraTypes) {
      expect(parseDomainEventType(type)).toBe(type);
    }
    // The specific row the amendment names: a historical `storyboard.approved`
    // event, exactly as `packages/db/src/index.ts`'s `mapEvent` would read
    // one back from an append-only `domain_events` table.
    expect(parseDomainEventType('storyboard.approved')).toBe(
      'storyboard.approved',
    );
  });

  it('still rejects a type that was never valid', () => {
    expectDomainCode(
      () => parseDomainEventType('not.a.real.event'),
      'UNKNOWN_EVENT_TYPE',
    );
  });
});

describe('Phase 7E operational event type', () => {
  it('adds recommendation.created to DOMAIN_EVENT_TYPES without disturbing existing entries', () => {
    expect(DOMAIN_EVENT_TYPES).toContain('recommendation.created');
  });

  it('round-trips recommendation.created through parseDomainEventType', () => {
    expect(parseDomainEventType('recommendation.created')).toBe(
      'recommendation.created',
    );
  });
});

describe('domain money, identity, and constructors', () => {
  it('uses exact integer micro-dollars for conversion and arithmetic', () => {
    const one = parseUsdToMicrousd('1.000001');
    const two = parseUsdToMicrousd('2.50');
    expect(one).toBe(1_000_001);
    expect(addMicrousd(one, two)).toBe(3_500_001);
    expect(formatMicrousdToUsd(two)).toBe('2.5');
    expect(subtractMicrousd(two, one)).toBe(1_499_999);
    expectDomainCode(() => parseUsdToMicrousd('0.0000001'), 'INVALID_MONEY');
    expectDomainCode(() => subtractMicrousd(one, two), 'NEGATIVE_MONEY');
  });

  it('generates UUID v7 values with deterministic injected entropy', () => {
    const value = createUuidV7(1_700_000_000_000, new Uint8Array(10).fill(7));
    expect(value).toBe('018bcfe5-6800-7707-8707-070707070707');
    expect(assertUuid(value)).toBe(value);
  });

  it('constructs a valid project and an implicit graph-first shot', () => {
    // Phase 7D removed storyboard materialization; every surviving shot is
    // implicit, created directly off a run submission rather than off an
    // approved storyboard proposal (design reference glossary: "Shot ...
    // Never surfaced in the new API").
    const project = createVideoProject({
      id: id(10),
      tenantId: id(11),
      title: '  Project  ',
      brief: '  Brief  ',
      targetDurationSeconds: 3,
      budgetMicrousd: parseUsdToMicrousd('5'),
      now: timestamp,
    });
    const shot = createShot({
      id: id(13),
      projectId: project.id,
      implicit: true,
      definition: {
        ordinal: 1,
        purpose: 'Purpose',
        prompt: 'Prompt',
        durationSeconds: 1,
        mode: 't2v',
        qualityTier: 'preview',
      },
      now: timestamp,
    });
    expect(project.status).toBe('draft');
    expect(shot.status).toBe('approved_for_generation');
    expect(shot.implicit).toBe(true);
  });
});
