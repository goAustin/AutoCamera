import { type FormEvent, type ReactElement, useState } from 'react';
import { Button } from './Button.js';

export interface TokenGateProps {
  /** Receives the trimmed token. Persisting it is the caller's decision. */
  readonly onSubmit: (token: string) => void;
  /** Compact framing for the ComfyUI side panel. */
  readonly embedded?: boolean | undefined;
}

/** The bearer-token sign-in for the Studio origin. */
export function TokenGate({
  onSubmit,
  embedded = false,
}: TokenGateProps): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError('Enter the local development bearer token to continue.');
      return;
    }
    setError(undefined);
    onSubmit(token);
  };

  return (
    <main
      className={
        embedded
          ? 'auth-shell auth-shell--embedded videoops-surface'
          : 'auth-shell videoops-surface'
      }
    >
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">
          {embedded
            ? 'VideoOps managed run panel'
            : 'Authenticated Project Studio'}
        </p>
        <h1 id="auth-title">
          {embedded ? 'Connect this panel.' : 'Connect this studio.'}
        </h1>
        <p className="lede">
          This local studio uses a development bearer token. It is held only in
          this Studio-origin browser session and is never passed to the ComfyUI
          origin.
        </p>
        <form
          className={
            embedded ? 'stack-form stack-form--embedded' : 'stack-form'
          }
          onSubmit={submit}
        >
          <label
            htmlFor="dev-token"
            className={embedded ? 'sr-only' : undefined}
          >
            Development token
          </label>
          <input
            id="dev-token"
            className="mono-field"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="DEV_AUTH_TOKEN"
            aria-describedby={error ? 'token-error' : undefined}
          />
          <Button variant="primary" type="submit">
            {embedded ? 'Connect' : 'Enter Project Studio'}
          </Button>
          {error && (
            <span id="token-error" className="field-error">
              {error}
            </span>
          )}
        </form>
        {!embedded && (
          <p className="auth-footer">
            Session-only bearer token · never sent to the ComfyUI origin
          </p>
        )}
      </section>
    </main>
  );
}
