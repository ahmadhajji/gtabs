import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetAllMocks } from './setup';
import { getSettings, saveSettings } from '../src/storage';
import { DEFAULT_SETTINGS } from '../src/types';

const html = readFileSync(resolve(__dirname, '../src/options.html'), 'utf8');
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const click = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!.click();
const selectProvider = (name: string) => {
  const card = [...document.querySelectorAll<HTMLElement>('.provider-card')].find(c => c.querySelector('.name')?.textContent === name);
  if (!card) throw new Error(`Missing provider ${name}`);
  card.click();
};
async function load(): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = html;
  await import('../src/options');
  await vi.waitFor(() => expect(document.querySelectorAll('.provider-card').length).toBeGreaterThan(0));
}

beforeEach(async () => {
  resetAllMocks();
  localStorage.clear();
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((message, callback) => {
    if (typeof callback !== 'function') throw new Error('Missing callback');
    callback({ type: 'status', status: 'done', available: true, models: [], workspaceNames: [] });
  });
  await load();
});

describe('provider settings', () => {
  it('saves a custom URL, optional key and free-form model and keeps profiles across switches and reload', async () => {
    input('baseUrl').value = 'http://127.0.0.1:9988/api/v1///';
    input('apiKey').value = ' test-secret ';
    input('model-select').value = 'my/model-v2';
    click('save-provider');
    // The request must start in the click gesture, before a storage await.
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1/*'] });
    await vi.waitFor(async () => expect((await getSettings()).model).toBe('my/model-v2'));
    expect((await getSettings()).baseUrl).toBe('http://127.0.0.1:9988/api/v1');
    const synced = await chrome.storage.sync.get('settings');
    expect(JSON.stringify(synced)).not.toContain('test-secret');
    selectProvider('OpenRouter');
    expect(input('apiKey').value).toBe('');
    input('apiKey').value = 'router-test-key';
    input('model-select').value = 'custom-router/model';
    click('save-provider');
    await vi.waitFor(async () => expect((await getSettings()).provider).toBe('openrouter'));
    await load();
    expect(input('model-select').value).toBe('custom-router/model');
    selectProvider('OpenAI-compatible proxy');
    expect(input('baseUrl').value).toBe('http://127.0.0.1:9988/api/v1');
    expect(input('apiKey').value).toBe('test-secret');
    expect(input('model-select').value).toBe('my/model-v2');
  });

  it('denied host permission leaves the saved provider unchanged and explains recovery', async () => {
    vi.mocked(chrome.permissions.request).mockResolvedValue(false);
    input('baseUrl').value = 'https://proxy.example/v1';
    input('model-select').value = 'model';
    click('save-provider');
    await vi.waitFor(() => expect(document.querySelector('#test-result')?.textContent).toContain('Host access denied'));
    expect((await getSettings()).baseUrl).toBe('');
  });

  it('saves and tests an endpoint without authentication and retains an explicit Off schedule', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, reorgSchedule: 'off' });
    input('baseUrl').value = 'http://localhost:1234/v1';
    input('model-select').value = 'model';
    click('test-btn');
    await vi.waitFor(() => expect(document.querySelector('#test-result')?.textContent).toBe('Connected!'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'test-connection' }, expect.any(Function));
    expect((await getSettings()).apiKey).toBe('');
    expect((await getSettings()).reorgSchedule).toBe('off');
  });

  it('defaults to five minutes, allows disabling it, and never auto-saves incomplete provider drafts', async () => {
    expect(input('reorgSchedule').value).toBe('five-minutes');
    expect(input('mergeMode').checked).toBe(true);
    input('baseUrl').value = 'incomplete';
    input('model-select').value = 'draft';
    input('reorgSchedule').value = 'off';
    input('reorgSchedule').dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await getSettings()).reorgSchedule).toBe('off'));
    expect((await getSettings()).model).toBe('');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('requires a URL/model and does not copy a provider key to another endpoint', async () => {
    click('save-provider');
    await vi.waitFor(() => expect(document.querySelector('#test-result')?.textContent).toContain('model ID'));
    selectProvider('OpenRouter');
    input('apiKey').value = 'router-test-key';
    selectProvider('OpenAI-compatible proxy');
    expect(input('apiKey').value).toBe('');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
});
