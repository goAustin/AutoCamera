export interface TestClock {
  now(): Date;
}

export function fixedTestClock(
  isoTime = '2026-01-01T00:00:00.000Z',
): TestClock {
  const value = new Date(isoTime);
  return {
    now: () => new Date(value),
  };
}
