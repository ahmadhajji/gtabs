import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyTabs } from '../src/jev';
import { parseCategories } from '../src/categories';
import { suggest } from '../src/grouper';
import { testConnection } from '../src/llm';
import { DEFAULT_SETTINGS, type Settings, type TabInfo } from '../src/types';
import { getSettings, saveSettings } from '../src/storage';
import { resetAllMocks } from './setup';

const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', apiKey: 'test-key' };
const routerSettings: Settings = { ...settings, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'typesafe/jev-1.13', apiKey: 'openrouter-test-key' };
const tabs: TabInfo[] = [
  { id: 1, title: 'TypeScript tutorial on YouTube', url: 'https://youtube.com/watch?v=code' },
  { id: 2, title: 'Research paper', url: 'https://example.com/paper' },
];
function response(items: TabInfo[], choice = 'Development', confidence = 0.9): Response {
  return new Response(JSON.stringify({
    answers: Object.fromEntries(items.map(tab => [`tab_${tab.id}`, { type: 'choice', choice, confidence }])),
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
}

beforeEach(resetAllMocks);

describe('Jev classification', () => {
  it.each(['typesafe/jev-1.13', '~typesafe/jev-latest'])('routes OpenRouter model %s through its Decisions API with the same categories', async model => {
    vi.mocked(fetch).mockResolvedValueOnce(response(tabs));
    const result = await suggest(tabs, { ...routerSettings, model }, {});
    expect(result.suggestions).toEqual([{ name: 'Development', color: 'blue', tabs }]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer openrouter-test-key' } });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model, state: { tabs }, questions: { tab_1: { type: 'choice', criteria: { Development: expect.any(String), Other: expect.any(String) } } } });
    expect(result.inputTokens).toBe(100);
  });

  it('uses smaller OpenRouter batches and merges all classified tabs', async () => {
    const manyTabs = Array.from({ length: 41 }, (_, i) => ({ ...tabs[0], id: i + 1 }));
    for (let i = 0; i < manyTabs.length; i += 20) vi.mocked(fetch).mockResolvedValueOnce(response(manyTabs.slice(i, i + 20)));
    const result = await classifyTabs(manyTabs, routerSettings);
    expect(result.suggestions).toEqual([{ name: 'Development', color: 'blue', tabs: manyTabs }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.inputTokens).toBe(300);
  });

  it('tests OpenRouter Jev with a Choice request and keeps ordinary OpenRouter models on chat', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ answers: { category: { type: 'choice', choice: 'development', confidence: 1 } } })));
    await expect(testConnection(routerSettings)).resolves.toBe('OK');
    expect(fetch).toHaveBeenLastCalledWith('https://openrouter.ai/api/alpha/decisions', expect.any(Object));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    await expect(testConnection({ ...routerSettings, model: 'openai/gpt-5-mini' })).resolves.toBe('OK');
    expect(fetch).toHaveBeenLastCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.any(Object));
  });

  it('classifies all tabs together using explicit tab references, fixed criteria and stable category colors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      answers: {
        tab_1: { type: 'choice', choice: 'Development', confidence: 0.9 },
        tab_2: { type: 'choice', choice: 'Research', confidence: 0.85 },
      },
      usage: { input_tokens: 250, output_tokens: 40 },
    })));
    const result = await classifyTabs(tabs, settings);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'jev-latest', state: { tabs },
      questions: {
        tab_1: { type: 'choice', instructions: expect.stringContaining('tab 1 in state.tabs'), criteria: { Development: expect.any(String), Other: expect.any(String) } },
        tab_2: { instructions: expect.stringContaining('tab 2 in state.tabs') },
      },
    });
    expect(result).toEqual({ suggestions: [
      { name: 'Development', color: 'blue', tabs: [tabs[0]] },
      { name: 'Research', color: 'yellow', tabs: [tabs[1]] },
    ], inputTokens: 250, outputTokens: 40 });
  });

  it('uses Other for low confidence and honours a custom category list', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(tabs, 'Medicine', 0.59));
    const custom = { ...settings, classificationCategories: [{ name: 'Medicine', description: 'Clinical study and medical references.' }] };
    expect((await classifyTabs(tabs, custom)).suggestions).toEqual([{ name: 'Other', color: 'grey', tabs }]);
    vi.mocked(fetch).mockResolvedValueOnce(response(tabs, 'Medicine', 0.6));
    expect((await classifyTabs(tabs, custom)).suggestions[0].name).toBe('Medicine');
  });

  it('keeps explicit domain rules ahead of Jev and avoids requests for fully matched tabs', async () => {
    const rules = [{ domain: 'youtube.com', groupName: 'Tutorials', color: 'green' as const }];
    vi.mocked(fetch).mockResolvedValueOnce(response([tabs[1]], 'Research'));
    expect((await suggest(tabs, settings, {}, rules)).suggestions.map(g => g.name)).toEqual(['Tutorials', 'Research']);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ state: { tabs: [tabs[1]] } });
    vi.mocked(fetch).mockClear();
    await suggest([tabs[0]], settings, {}, rules);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { tab_1: { type: 'choice', choice: 'Development', confidence: 1 } },
    { tab_1: { type: 'choice', choice: 'Invented group', confidence: 1 }, tab_2: { type: 'choice', choice: 'Research', confidence: 1 } },
    { tab_1: { type: 'choice', choice: 'Development', confidence: -0.1 }, tab_2: { type: 'choice', choice: 'Research', confidence: 1 } },
    { tab_1: { type: 'choice', choice: 'Development', confidence: '0.9' }, tab_2: { type: 'choice', choice: 'Research', confidence: 1 } },
    { tab_1: { type: 'score', choice: 'Development', confidence: 1 }, tab_2: { type: 'choice', choice: 'Research', confidence: 1 } },
  ])('rejects missing, invalid or invented answers before grouping', async answers => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ answers })));
    await expect(classifyTabs(tabs, settings)).rejects.toThrow(/Jev/);
  });

  it('bounds parallel requests, drains failures and does not start later batches', async () => {
    const manyTabs = Array.from({ length: 130 }, (_, i) => ({ ...tabs[0], id: i + 1 }));
    let finishSecond: (res: Response) => void = () => { throw new Error('Request not started'); };
    let finishThird: (res: Response) => void = () => { throw new Error('Request not started'); };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('secret-provider-error', { status: 429 }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishThird = resolve; }));
    let settled = false;
    const run = classifyTabs(manyTabs, settings).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    finishSecond(response(manyTabs.slice(40, 80)));
    finishThird(response(manyTabs.slice(80, 120)));
    expect(await run).toMatchObject({ message: 'LLM error 429. Check your provider settings.' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('merges large batches into the same categories and accounts for every tab and token', async () => {
    const manyTabs = Array.from({ length: 130 }, (_, i) => ({ ...tabs[0], id: i + 1 }));
    for (let i = 0; i < manyTabs.length; i += 40) vi.mocked(fetch).mockResolvedValueOnce(response(manyTabs.slice(i, i + 40)));
    const result = await classifyTabs(manyTabs, settings);
    expect(result.suggestions).toEqual([{ name: 'Development', color: 'blue', tabs: manyTabs }]);
    expect(result.inputTokens).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('tests the classification API instead of requesting generated text', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ answers: { category: { type: 'choice', choice: 'development', confidence: 1 } } })));
    await expect(testConnection(settings)).resolves.toBe('OK');
    expect(fetch).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', expect.any(Object));
  });

  it('times out and rejects without leaking response bodies or keys', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('test-key')));
      }));
      const result = classifyTabs(tabs, settings).catch(error => error);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await result).toMatchObject({ message: 'LLM request timed out after 25s' });
    } finally { vi.useRealTimers(); }
  });
});

describe('category settings', () => {
  it('ships 30 valid, distinct presets and bounds category count and sync size', () => {
    expect(parseCategories(DEFAULT_SETTINGS.classificationCategories)).toHaveLength(30);
    expect(() => parseCategories(Array.from({ length: 41 }, (_, i) => ({ name: `Category ${i}`, description: 'Description' })))).toThrow('40 categories');
    expect(() => parseCategories(Array.from({ length: 40 }, (_, i) => ({ name: `Category ${i}`, description: 'x'.repeat(200) })))).toThrow('too long to sync');
  });

  it.each([[], [{ name: 'Other', description: 'Reserved' }], [{ name: 'Work', description: '' }], [{ name: 'Work', description: 'A' }, { name: ' work ', description: 'B' }]])('rejects invalid category lists', value => {
    expect(() => parseCategories(value)).toThrow();
  });

  it('keeps category settings across reloads, migrates old settings, and bounds confidence', async () => {
    await chrome.storage.sync.set({ settings: { provider: 'custom', model: 'old-model' } });
    expect((await getSettings()).classificationCategories).toEqual(DEFAULT_SETTINGS.classificationCategories);
    const custom = [{ name: ' Medicine ', description: ' Clinical references ' }];
    await saveSettings({ ...settings, classificationCategories: custom, classificationConfidence: 2 });
    expect(await getSettings()).toMatchObject({ classificationCategories: [{ name: 'Medicine', description: 'Clinical references' }], classificationConfidence: 1 });
    expect(JSON.stringify(await chrome.storage.sync.get('settings'))).not.toContain('test-key');
  });
});
