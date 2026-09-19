import { PROVIDERS, type LLMConfig, type Settings } from './types';

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function endpointPermission(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  // Chrome host permissions apply to all ports on the selected host.
  return `${url.protocol}//${url.hostname}/*`;
}

export function validateProvider(config: LLMConfig & { provider: string }): LLMConfig {
  const provider = PROVIDERS.find(p => p.id === config.provider);
  if (!provider) throw new Error('Choose a provider in Settings.');
  const model = config.model.trim();
  if (!model) throw new Error('Enter a model ID in Settings.');
  const apiKey = config.apiKey.trim();
  if (provider.needsKey && !apiKey) throw new Error('Enter an API key in Settings.');
  return { baseUrl: provider.isBuiltIn ? '' : normalizeBaseUrl(config.baseUrl), model, apiKey };
}

export async function requireProvider(settings: Settings): Promise<void> {
  const config = validateProvider(settings);
  if (!config.baseUrl) {
    if (!globalThis.LanguageModel) throw new Error('Built-in AI is unavailable. Choose a provider in Settings.');
  } else if (!await chrome.permissions.contains({ origins: [endpointPermission(config.baseUrl)] })) {
    throw new Error('API host access is missing. Open Settings and click Save provider to grant access.');
  }
}
