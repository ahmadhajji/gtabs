import { vi } from 'vitest';

export function tab(id: number, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id, windowId: 1, index: id - 1, url: `https://site${id}.example/`, title: `Site ${id}`,
    groupId: -1, pinned: false, incognito: false, active: false, highlighted: false,
    selected: false, discarded: false, autoDiscardable: true, ...overrides,
  };
}

export function browserState(initialTabs: chrome.tabs.Tab[], initialGroups: chrome.tabGroups.TabGroup[] = []) {
  const state = { tabs: initialTabs, groups: initialGroups, nextGroup: 100 };
  vi.mocked(chrome.tabs.query).mockImplementation(async query => state.tabs.filter(t =>
    (query.windowId === undefined || t.windowId === query.windowId) &&
    (query.groupId === undefined || t.groupId === query.groupId) &&
    (!query.currentWindow || t.windowId === 1)).map(t => ({ ...t })));
  vi.mocked(chrome.tabs.get).mockImplementation(async id => {
    const result = state.tabs.find(t => t.id === id);
    if (!result) throw new Error('No tab');
    return { ...result };
  });
  vi.mocked(chrome.tabGroups.query).mockImplementation(async query => state.groups.filter(g =>
    (query.windowId === undefined || g.windowId === query.windowId) &&
    (query.title === undefined || g.title === query.title)).map(g => ({ ...g })));
  vi.mocked(chrome.tabs.group).mockImplementation(async options => {
    const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
    const id = options.groupId ?? state.nextGroup++;
    if (options.groupId === undefined) state.groups.push({ id, windowId: options.createProperties?.windowId ?? 1, title: '', color: 'grey', collapsed: false });
    for (const t of state.tabs) if (ids.includes(t.id)) t.groupId = id;
    return id;
  });
  vi.mocked(chrome.tabs.ungroup).mockImplementation(async ids => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const t of state.tabs) if (t.id !== undefined && list.includes(t.id)) t.groupId = -1;
  });
  vi.mocked(chrome.tabGroups.update).mockImplementation(async (id, update) => {
    const group = state.groups.find(g => g.id === id);
    if (!group) throw new Error('No group');
    Object.assign(group, update);
    return { ...group };
  });
  return state;
}
