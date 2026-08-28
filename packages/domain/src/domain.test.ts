import { describe, expect, it } from 'vitest';
import {
  addMicrousd,
  assertUuid,
  createShot,
  createStoryboardProposal,
  createUuidV7,
  createVideoProject,
  DomainError,
  formatMicrousdToUsd,
  parseProjectStatus,
  parseShotStatus,
  parseStoryboardStatus,
  parseUsdToMicrousd,
  PROJECT_STATUS_TRANSITIONS,
  SHOT_STATUS_TRANSITIONS,
  STORYBOARD_STATUS_TRANSITIONS,
  subtractMicrousd,
  toIsoUtc,
  transitionProject,
  transitionShot,
  transitionStoryboard,
  type ProjectStatus,
  type Shot,
  type ShotStatus,
  type StoryboardProposal,
  type StoryboardStatus,
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

function proposalWithStatus(status: StoryboardStatus): StoryboardProposal {
  return {
    id: id(3),
    projectId: id(4),
    revision: 1,
    status,
    shots: [1, 2, 3].map((ordinal) => ({
      ordinal: ordinal as 1 | 2 | 3,
      purpose: `Purpose ${ordinal}`,
      prompt: `Prompt ${ordinal}`,
      durationSeconds: 1,
      mode: 't2v' as const,
      qualityTier: 'preview' as const,
    })),
    totalDurationSeconds: 3,
    durationToleranceSeconds: 0.05,
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

  it('allows and rejects every documented storyboard transition', () => {
    for (const [current, nextStatuses] of Object.entries(
      STORYBOARD_STATUS_TRANSITIONS,
    ) as [StoryboardStatus, readonly StoryboardStatus[]][]) {
      for (const next of nextStatuses) {
        expect(
          transitionStoryboard(proposalWithStatus(current), next).status,
        ).toBe(next);
      }
      for (const next of Object.keys(
        STORYBOARD_STATUS_TRANSITIONS,
      ) as StoryboardStatus[]) {
        if (!nextStatuses.includes(next)) {
          expect(() =>
            transitionStoryboard(proposalWithStatus(current), next),
          ).toThrow();
        }
      }
    }
    expectDomainCode(
      () => parseStoryboardStatus('future-status'),
      'UNKNOWN_STORYBOARD_STATUS',
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

  it('constructs a valid project, proposal, and approved-ready shot', () => {
    const project = createVideoProject({
      id: id(10),
      tenantId: id(11),
      title: '  Project  ',
      brief: '  Brief  ',
      targetDurationSeconds: 3,
      budgetMicrousd: parseUsdToMicrousd('5'),
      now: timestamp,
    });
    const proposal = createStoryboardProposal({
      id: id(12),
      projectId: project.id,
      revision: 1,
      shots: [1, 2, 3].map((ordinal) => ({
        ordinal: ordinal as 1 | 2 | 3,
        purpose: `Purpose ${ordinal}`,
        prompt: `Prompt ${ordinal}`,
        durationSeconds: 1,
        mode: 't2v' as const,
        qualityTier: 'preview' as const,
      })),
      now: timestamp,
    });
    const firstDefinition = proposal.shots[0];
    if (!firstDefinition) {
      throw new Error('Expected a first storyboard shot.');
    }
    const shot = createShot({
      id: id(13),
      projectId: project.id,
      storyboardProposalId: proposal.id,
      definition: firstDefinition,
      now: timestamp,
    });
    expect(project.status).toBe('draft');
    expect(proposal.shots).toHaveLength(3);
    expect(shot.status).toBe('approved_for_generation');
  });
});
