import type { ReactElement } from 'react';

export interface ArtifactPlayerProps {
  /** An object URL for the already-authorized clip. The design system never fetches. */
  readonly src: string;
  /** Still frame shown before playback, so the slot is never a black void. */
  readonly poster?: string | undefined;
  readonly label?: string | undefined;
}

/** The review surface for a generated clip. */
export function ArtifactPlayer({
  src,
  poster,
  label = 'Generated artifact',
}: ArtifactPlayerProps): ReactElement {
  return (
    <video
      className="artifact-player"
      controls
      preload="metadata"
      src={src}
      poster={poster}
      aria-label={label}
    >
      <track kind="captions" />
    </video>
  );
}
