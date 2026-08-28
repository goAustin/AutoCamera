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
    expect(getWebConfig({ NODE_ENV: 'test' }).apiOrigin).toBe(
      'http://127.0.0.1:3000',
    );
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
});
