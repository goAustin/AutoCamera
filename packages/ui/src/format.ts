/** Turns a snake_case or kebab-case machine token into Title Case prose. */
export function humanize(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replaceAll('.', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Formats an ISO timestamp in the viewer's locale, falling back to the raw value. */
export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : value;
}

/** Formats a seconds count, dropping the decimals when the value is whole. */
export function formatDuration(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}s`;
}

/** Formats a USD amount already denominated in dollars. */
export function formatMoney(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  return `$${text}`;
}

/** Shortens an opaque identifier to a head-and-tail form for display. */
export function shortId(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail) return value;
  // slice(-0) is slice(0) — a zero tail must not append the whole string back.
  return tail > 0
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : `${value.slice(0, head)}…`;
}
