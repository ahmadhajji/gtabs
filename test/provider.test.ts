import { describe, expect, it } from 'vitest';
import { classificationEndpoint, endpointPermission, normalizeBaseUrl, validateProvider } from '../src/provider';
import { DEFAULT_SETTINGS } from '../src/types';

describe('provider configuration boundary', () => {
  it('routes OpenRouter aliases to its Decisions endpoint without changing hosts', () => {
    const config = { ...DEFAULT_SETTINGS, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1///', model: ' ~typesafe/jev-latest ' };
    expect(classificationEndpoint(config)).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(classificationEndpoint({ ...config, provider: 'openrouter-free' })).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(classificationEndpoint({ ...config, baseUrl: 'http://localhost:11434/api/v1' })).toBe('http://localhost:11434/api/alpha/decisions');
    expect(classificationEndpoint({ ...config, model: 'openai/gpt-5-mini' })).toBeNull();
    expect(classificationEndpoint({ ...config, provider: 'custom' })).toBeNull();
  });

  it('explains the required OpenRouter model ID for a bare Jev name', () => {
    expect(() => validateProvider({ ...DEFAULT_SETTINGS, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'jev-latest', apiKey: 'test-key' })).toThrow('typesafe/jev-1.13');
  });

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

  it('requires a key for Jev and retains its classification endpoint and model', () => {
    const config = { ...DEFAULT_SETTINGS, provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' };
    expect(() => validateProvider(config)).toThrow('API key');
    expect(validateProvider({ ...config, apiKey: ' test-key ' })).toEqual({ baseUrl: config.baseUrl, model: config.model, apiKey: 'test-key' });
  });
});
