import { type ReactElement, useCallback, useRef, useState } from 'react';

export interface ArtifactPlayerProps {
  /** An object URL for the already-authorized clip. The design system never fetches. */
  readonly src: string;
  /** Still frame shown before playback, so the slot is never a black void. */
  readonly poster?: string | undefined;
  readonly label?: string | undefined;
}

/* A minimal inline placeholder poster so the frame is never a black void
   when the caller has no thumbnail to hand — there is no poster URL on the
   real API today (see the redesign brief's "degrade honestly" section).
   Colours mirror the panel/faint tokens; an SVG data URI is rendered in its
   own isolated context and cannot resolve a page's CSS custom property. */
const FALLBACK_POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
      '<rect width="640" height="360" fill="#1c1d1d"/>' +
      '<circle cx="320" cy="180" r="34" fill="none" stroke="#8a8a87" stroke-width="2"/>' +
      '<path d="M311 163 L340 180 L311 197 Z" fill="#8a8a87"/>' +
      '</svg>',
  );

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

function PlayGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="6" y="4.5" width="4" height="15" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" fill="currentColor" />
    </svg>
  );
}

/** The review surface for a generated clip: a poster-backed 16:9 frame, a
 * custom play control, and a scrubber — never the browser's native chrome. */
export function ArtifactPlayer({
  src,
  poster,
  label = 'Generated artifact',
}: ArtifactPlayerProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const seek = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  }, []);

  const percent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="artifact-player">
      <div className="artifact-frame">
        <video
          ref={videoRef}
          preload="metadata"
          src={src}
          poster={poster ?? FALLBACK_POSTER}
          aria-label={label}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) =>
            setDuration(event.currentTarget.duration)
          }
          onTimeUpdate={(event) =>
            setCurrentTime(event.currentTarget.currentTime)
          }
        >
          <track kind="captions" />
        </video>
        <button
          type="button"
          className="artifact-play-toggle"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={togglePlay}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
      </div>
      <input
        className="artifact-scrubber"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        style={{
          background: `linear-gradient(to right, var(--acc) ${percent}%, var(--panel2) ${percent}%)`,
        }}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Seek"
      />
      <div className="artifact-meta">
        {formatTime(currentTime)} / {formatTime(duration)}
      </div>
    </div>
  );
}
