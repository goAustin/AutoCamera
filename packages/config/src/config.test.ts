import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  getApiConfig,
  getWebConfig,
  parseEnvironment,
} from './index.js';

describe('configuration', () => {
  it('parses safe defaults in test mode', () => {
    const config = getApiConfig({ NODE_ENV: 'test' });

    expect(config.apiHost).toBe('127.0.0.1');
    expect(config.apiPort).toBe(3000);
    expect(config.projectDefaultBudgetUsd).toBe('25.00');
    expect(config.piProvider).toBe('faux');
    expect(config.piModel).toBe('h3-videoops-storyboard-v1');
    expect(config.piMaxConcurrentRuns).toBe(1);
    expect(config.comfyMode).toBe('fake');
    expect(config.comfyFrontendUrl).toBe('http://127.0.0.1:8188');
    expect(config.comfyRequestTimeoutMs).toBe(15_000);
    expect(config.notifyTimeoutMs).toBe(5_000);
    expect(config.notifyWebhookUrl).toBeUndefined();
    expect(getWebConfig({ NODE_ENV: 'test' }).apiOrigin).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('accepts an optional notify webhook and its timeout override', () => {
    expect(
      getApiConfig({
        NODE_ENV: 'test',
        NOTIFY_WEBHOOK_URL: 'https://ntfy.example.test/h3-videoops',
        NOTIFY_TIMEOUT_MS: '2000',
      }),
    ).toMatchObject({
      notifyWebhookUrl: 'https://ntfy.example.test/h3-videoops',
      notifyTimeoutMs: 2_000,
    });
  });

  it('rejects invalid names without exposing secret values', () => {
    const secret = 'do-not-print-this-token';

    expect(() =>
      parseEnvironment({
        NODE_ENV: 'development',
        API_PORT: 'not-a-port',
        DEV_AUTH_TOKEN: secret,
      }),
    ).toThrowError(ConfigurationError);

    try {
      parseEnvironment({
        NODE_ENV: 'development',
        API_PORT: 'not-a-port',
        DEV_AUTH_TOKEN: secret,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain('API_PORT');
      expect(String(error)).not.toContain(secret);
      return;
    }

    throw new Error('Expected invalid configuration to throw.');
  });

  it('requires the development bearer token outside tests', () => {
    expect(() => parseEnvironment({ NODE_ENV: 'development' })).toThrow(
      'DEV_AUTH_TOKEN',
    );
  });

  it('does not require hosted credentials in faux mode', () => {
    expect(() =>
      parseEnvironment({ NODE_ENV: 'development', DEV_AUTH_TOKEN: 'local' }),
    ).not.toThrow();
  });

  it('requires credentials only for an explicitly selected hosted provider', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'test',
        PI_PROVIDER: 'hosted',
      }),
    ).toThrowError('PI_API_KEY');
    expect(
      parseEnvironment({
        NODE_ENV: 'test',
        PI_PROVIDER: 'hosted',
        PI_API_KEY: 'secret',
      }).PI_PROVIDER,
    ).toBe('hosted');
  });

  it('requires explicit, protocol-safe remote Comfy endpoints', () => {
    expect(() =>
      parseEnvironment({ NODE_ENV: 'test', COMFY_MODE: 'remote' }),
    ).toThrowError('COMFY_BASE_URL');
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'test',
        COMFY_MODE: 'remote',
        COMFY_BASE_URL: 'ftp://comfy.example.test',
        COMFY_WS_URL: 'ws://comfy.example.test/ws',
        COMFY_FRONTEND_URL: 'http://comfy.example.test',
      }),
    ).toThrowError(ConfigurationError);
    expect(
      parseEnvironment({
        NODE_ENV: 'test',
        COMFY_MODE: 'remote',
        COMFY_BASE_URL: 'https://comfy.example.test',
        COMFY_WS_URL: 'wss://comfy.example.test/ws',
        COMFY_FRONTEND_URL: 'https://comfy.example.test',
        COMFY_REQUEST_TIMEOUT_MS: '20000',
        COMFY_AUTH_TOKEN: 'secret',
      }),
    ).toMatchObject({
      COMFY_MODE: 'remote',
      COMFY_REQUEST_TIMEOUT_MS: 20_000,
      COMFY_AUTH_TOKEN: 'secret',
    });
  });
});
