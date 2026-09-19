import { describe, expect, it } from 'vitest';
import { endpointPermission, normalizeBaseUrl, validateProvider } from '../src/provider';
import { DEFAULT_SETTINGS } from '../src/types';

describe('provider configuration boundary', () => {
  it.each([
    ['http://localhost:1234/v1///', 'http://localhost/*'],
    ['http://127.0.0.1:8888/v1', 'http://127.0.0.1/*'],
    ['http://192.168.1.7:4000/api/v1', 'http://192.168.1.7/*'],
    ['https://proxy.example/custom/v1/', 'https://proxy.example/*'],
  ])('requests only the configured host for %s', (url, permission) => {
    expect(endpointPermission(url)).toBe(permission);
    expect(normalizeBaseUrl(url)).not.toMatch(/\/$/);
  });

  it.each(['', 'ftp://host/v1', 'https://key:secret@host/v1', 'https://host/v1?key=secret', 'https://host/v1#fragment'])('rejects unsafe or incomplete base URL %s', baseUrl => {
    expect(() => normalizeBaseUrl(baseUrl)).toThrow();
  });

  it('accepts optional proxy auth while requiring an OpenRouter key', () => {
    expect(validateProvider({ ...DEFAULT_SETTINGS, baseUrl: 'https://proxy.example/v1', model: 'owner/model' }).apiKey).toBe('');
    expect(() => validateProvider({ ...DEFAULT_SETTINGS, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'owner/model' })).toThrow('API key');
  });
});
