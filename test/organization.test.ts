import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllMocks, emit } from './setup';
import { browserState, tab } from './browser-state';
import { DEFAULT_SETTINGS, type Settings } from '../src/types';
import { getSettings, getUndoSnapshot, saveSettings } from '../src/storage';
import * as storage from '../src/storage';
import { organizeAndApply, getOrganizationStatus, setupReorgAlarm, undoLastGrouping } from '../src/background';

const configured: Settings = { ...DEFAULT_SETTINGS, provider: 'custom', baseUrl: 'http://127.0.0.1:9876/v1', model: 'user/model' };
function response(ids: number[], name = 'Work'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ name, color: 'blue', tabIds: ids }]) } }] }));
}

beforeEach(async () => {
  resetAllMocks();
  await saveSettings(configured);
  await setupReorgAlarm();
  vi.mocked(chrome.alarms.create).mockClear();
});

describe('background organize and apply', () => {
  it('applies immediately, keeps manual/protected/pinned/private tabs, and reuses the group', async () => {
    const state = browserState([tab(1), tab(2, { groupId: 8 }), tab(3, { pinned: true }), tab(4, { incognito: true }), tab(5, { groupId: 9 })], [
      { id: 8, title: 'Work', color: 'red', collapsed: true, windowId: 1 },
      { id: 9, title: 'Protected', color: 'green', collapsed: true, windowId: 1 },
    ]);
    await saveSettings({ ...configured, pinnedGroups: ['Protected'] });
    vi.mocked(fetch).mockResolvedValue(response([1]));
    const result = await organizeAndApply(1);
    expect(result.state).toBe('done');
    expect(state.tabs.map(t => t.groupId)).toEqual([8, 8, -1, -1, 9]);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.messages[1].content).toContain('site1.example');
    for (const id of [2, 3, 4, 5]) expect(body.messages[1].content).not.toContain(`site${id}.example`);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
  });

  it('holds one lock for manual, scheduled, and undo work, and keeps the captured window', async () => {
    const state = browserState([tab(1), tab(2), tab(3, { windowId: 2 })]);
    let finish: (value: Response) => void = () => { throw new Error('Request not started'); };
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = organizeAndApply(1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 2 });
    expect((await organizeAndApply(2)).state).toBe('running');
    expect((await organizeAndApply(undefined, true)).state).toBe('running');
    expect((await undoLastGrouping()).error).toContain('Wait');
    expect((await getOrganizationStatus()).state).toBe('running');
    finish(response([1, 2]));
    await first;
    expect(state.tabs[2].groupId).toBe(-1);
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2], createProperties: { windowId: 1 } });
  });

  it('skips closed, navigated, moved, newly pinned and manually grouped tabs while an API request is pending', async () => {
    const state = browserState([1, 2, 3, 4, 5, 6].map(id => tab(id)));
    vi.mocked(fetch).mockImplementation(async () => {
      state.tabs = state.tabs.filter(t => t.id !== 1);
      state.tabs[0].url = 'https://changed.example';
      state.tabs[1].windowId = 2;
      state.tabs[2].pinned = true;
      state.tabs[3].groupId = 42;
      return response([1, 2, 3, 4, 5, 6]);
    });
    await organizeAndApply(1);
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [6], createProperties: { windowId: 1 } });
    expect((await getUndoSnapshot())?.ungrouped).toEqual([6]);
  });

  it('skips unchanged automatic runs and processes each normal window without crossing boundaries', async () => {
    const state = browserState([tab(1), tab(2, { windowId: 2 }), tab(3, { windowId: 3, incognito: true })]);
    vi.mocked(chrome.windows.getAll).mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3, incognito: true }]);
    vi.mocked(fetch).mockResolvedValueOnce(response([1])).mockResolvedValueOnce(response([2]));
    await organizeAndApply(undefined, true);
    await organizeAndApply(undefined, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.tabs[0].groupId).not.toBe(state.tabs[1].groupId);
    expect(state.tabs[2].groupId).toBe(-1);
    state.tabs.push(tab(4));
    vi.mocked(fetch).mockResolvedValueOnce(response([4]));
    await organizeAndApply(undefined, true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(state.tabs[3].groupId).toBe(state.tabs[0].groupId);
  });

  it('does not mark newly opened tabs as processed during a pending request', async () => {
    const state = browserState([tab(1)]);
    vi.mocked(fetch).mockImplementationOnce(async () => { state.tabs.push(tab(2)); return response([1]); }).mockResolvedValueOnce(response([2]));
    await organizeAndApply(undefined, true);
    await organizeAndApply(undefined, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.tabs[1].groupId).toBe(state.tabs[0].groupId);
  });

  it.each(['not JSON', '[]', '[{"name":"Work","color":"blue","tabIds":[999]}]', '[{"name":"Work","color":"blue","tabIds":[1,1]}]'])('keeps the arrangement on invalid model output: %s', async content => {
    const state = browserState([tab(1)]);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content } }] })));
    expect((await organizeAndApply(1)).state).toBe('error');
    expect(state.tabs[0].groupId).toBe(-1);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(await getUndoSnapshot()).toBeNull();
  });

  it('rolls back and reports application errors rather than reporting success', async () => {
    const state = browserState([tab(1)]);
    vi.mocked(fetch).mockResolvedValue(response([1]));
    vi.mocked(chrome.tabGroups.update).mockRejectedValueOnce(new Error('Browser rejected update'));
    const result = await organizeAndApply(1);
    expect(result.state).toBe('error');
    expect(result.message).toContain('restored');
    expect(state.tabs[0].groupId).toBe(-1);
  });

  it('undo restores only affected tabs in their original window', async () => {
    const state = browserState([tab(1), tab(2, { groupId: 12 }), tab(3, { windowId: 2, groupId: 22 })]);
    vi.mocked(fetch).mockResolvedValue(response([1]));
    await organizeAndApply(1);
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 2 });
    expect(await undoLastGrouping()).toEqual({});
    expect(state.tabs.map(t => t.groupId)).toEqual([-1, 12, 22]);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1]);
  });

  it('cancels application if the provider or schedule changes during a request', async () => {
    browserState([tab(1)]);
    vi.mocked(fetch).mockImplementation(async () => {
      await saveSettings({ ...configured, reorgSchedule: 'off' });
      return response([1]);
    });
    expect((await organizeAndApply(1)).state).toBe('error');
    expect(chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('does not call an unconfigured or unpermitted provider', async () => {
    browserState([tab(1)]);
    await saveSettings(DEFAULT_SETTINGS);
    expect((await organizeAndApply(1)).state).toBe('error');
    await saveSettings(configured);
    vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
    expect((await organizeAndApply(1)).message).toContain('host access');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('persistent alarms', () => {
  it('creates five-minute alarms, preserves their next fire time, and recreates missing alarms', async () => {
    await setupReorgAlarm();
    expect(chrome.alarms.create).toHaveBeenCalledWith('gtabs-reorg', { delayInMinutes: 5, periodInMinutes: 5 });
    vi.mocked(chrome.alarms.create).mockClear();
    vi.mocked(chrome.alarms.get).mockResolvedValue({ name: 'gtabs-reorg', scheduledTime: Date.now() + 1000, periodInMinutes: 5 });
    await setupReorgAlarm();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    vi.mocked(chrome.alarms.get).mockResolvedValue(undefined);
    await emit(chrome.runtime.onStartup);
    await setupReorgAlarm();
    expect(chrome.alarms.create).toHaveBeenCalled();
  });

  it('clears alarms when disabled or not configured', async () => {
    await saveSettings({ ...configured, reorgSchedule: 'off' });
    await setupReorgAlarm();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('gtabs-reorg');
    expect(chrome.alarms.clear).toHaveBeenCalledWith('gtabs-check');
    vi.mocked(chrome.alarms.create).mockClear();
    await saveSettings(DEFAULT_SETTINGS);
    await setupReorgAlarm();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  it.each([['daily', 1440], ['weekly', 10080]] as const)('preserves %s schedules', async (reorgSchedule, periodInMinutes) => {
    await saveSettings({ ...configured, reorgSchedule });
    await setupReorgAlarm();
    expect(chrome.alarms.create).toHaveBeenCalledWith('gtabs-reorg', expect.objectContaining({ periodInMinutes }));
  });

  it('suppresses threshold automation while a schedule is enabled', async () => {
    browserState([tab(1), tab(2)]);
    await saveSettings({ ...configured, autoTrigger: true, threshold: 2 });
    await emit(chrome.alarms.onAlarm, { name: 'gtabs-check' });
    await setupReorgAlarm();
    expect(fetch).not.toHaveBeenCalled();
    expect((await getSettings()).reorgSchedule).toBe('five-minutes');
  });
});

describe('application interleavings', () => {
  it('undo leaves a tab alone when the user regroups it during an earlier group application', async () => {
    const state = browserState([tab(1), tab(2)]);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content:
      '[{"name":"First","color":"blue","tabIds":[1]},{"name":"Second","color":"red","tabIds":[2]}]'
    } }] })));
    const update = vi.mocked(chrome.tabGroups.update).getMockImplementation()!;
    vi.mocked(chrome.tabGroups.update).mockImplementation(async (id, changes) => {
      state.tabs[1].groupId = 77;
      return update(id, changes);
    });
    await organizeAndApply(1);
    expect((await getUndoSnapshot())?.positions?.map(p => p.tabId)).toEqual([1]);
    await undoLastGrouping();
    expect(state.tabs.map(t => t.groupId)).toEqual([-1, 77]);
  });

  it('protects matching group names consistently before sending titles to the model', async () => {
    browserState([tab(1, { groupId: 12 }), tab(2)], [{ id: 12, windowId: 1, title: 'Work', color: 'red', collapsed: false }]);
    await saveSettings({ ...configured, mergeMode: false, pinnedGroups: ['work'] });
    vi.mocked(fetch).mockResolvedValue(response([2], 'New'));
    await organizeAndApply(1);
    expect(String(vi.mocked(fetch).mock.calls[0][1]?.body)).not.toContain('site1.example');
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [2], createProperties: { windowId: 1 } });
  });
});

it('holds the shared lock while fast routing awaits settings', async () => {
  const state = browserState([tab(1)], [{ id: 8, windowId: 1, title: 'Work', color: 'blue', collapsed: false }]);
  await chrome.storage.local.set({ affinity: { 'site1.example': 'Work' } });
  let release: (settings: Settings) => void = () => { throw new Error('Routing not started'); };
  const spy = vi.spyOn(storage, 'getSettings').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const routing = emit(chrome.tabs.onUpdated, 1, { status: 'complete' }, state.tabs[0]);
  expect((await organizeAndApply(1)).state).toBe('running');
  expect((await undoLastGrouping()).error).toContain('Wait');
  release({ ...configured, silentAutoAdd: true });
  await routing;
  spy.mockRestore();
  expect(state.tabs[0].groupId).toBe(8);
  expect(fetch).not.toHaveBeenCalled();
});
