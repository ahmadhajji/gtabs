import type {
  Color,
  GroupSuggestion,
  MessageType,
  MergeSplitResult,
  TabInfo,
  UndoSnapshot,
  Workspace,
  WorkspaceTab,
  CorrectionEntry,
  RejectionEntry,
  SnoozedTab,
  Settings,
  OrganizationStatus,
} from './types';
import { MODEL_PRICING, SECONDARY_TLDS } from './types';
import {
  addCost,
  addCorrections,
  addHistory,
  addRejections,
  exportAll,
  getAffinity,
  getCorrections,
  getCosts,
  getDomainRules,
  getHistory,
  getRejections,
  getSettings,
  getStats,
  getUndoSnapshot,
  getWeightedAffinity,
  importAll,
  incrementStats,
  formatWeightedAffinityHints,
  saveSuggestions,
  saveUndoSnapshot,
  summarizeCorrections,
  summarizeCoOccurrence,
  summarizeHistory,
  summarizeRejections,
  updateAffinity,
  updateCoOccurrence,
  updateWeightedAffinity,
  getGroupColorPrefs,
  saveGroupColorPref,
  getSnoozedTabs,
  addSnoozedTab,
  removeSnoozedTab,
  getWorkspaces,
  saveWorkspace,
  removeWorkspace,
} from './storage';
import { suggest, findDuplicates, inferTargetGroup, matchTabsToExistingGroups, truncateTitle } from './grouper';
import type { ExtraHints } from './grouper';
import { completeWithUsage, fetchOllamaModels, isChromeAIAvailable, testConnection } from './llm';

import { classificationEndpoint, requireProvider } from './provider';

function protectedGroupNames(settings: Settings): Set<string> {
  return new Set(settings.pinnedGroups.map(name => name.toLowerCase()));
}

const ALARM_NAME = 'gtabs-check';
const REORG_ALARM_NAME = 'gtabs-reorg';
const SNOOZE_ALARM_PREFIX = 'gtabs-snooze-';
const CTX_ADD_TO_GROUP_ID = 'gtabs-add-to-group';
const ACTION_CONTEXT_MENUS: chrome.contextMenus.CreateProperties[] = [
  { id: 'gtabs-organize', title: 'Organize all tabs', contexts: ['action'] },
  { id: 'gtabs-organize-ungrouped', title: 'Organize ungrouped tabs only', contexts: ['action'] },
  { id: 'gtabs-undo', title: 'Undo last grouping', contexts: ['action'] },
  { id: 'gtabs-duplicates', title: 'Find duplicate tabs', contexts: ['action'] },
];

// In-memory state (session-only, not persisted)
const openerMap = new Map<number, number>();
const tabActivationTimes = new Map<number, number>();

const IMPORTANT_APP_PATTERNS = [
  'mail.google.com',
  'calendar.google.com',
  'docs.google.com',
  'drive.google.com',
  'notion.so',
  'notion.site',
  'figma.com',
  'linear.app',
  'atlassian.net',
  'slack.com',
  'discord.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'airtable.com',
  'spotify.com',
] as const;
const MAX_TRACKED_TAB_RELATIONS = 5000;

let autoCheckInFlight = false;
let lastAutoCheckTime = 0;
let contextMenuRebuildQueue: Promise<void> = Promise.resolve();
const AUTO_CHECK_COOLDOWN_MS = 60_000; // 60s minimum between auto-organize
const MAX_CONTEXT_GROUP_ID = 1_000_000_000;

/** Reset cooldown — exported for testing only */
export function _resetAutoCheckCooldown() { lastAutoCheckTime = 0; }

export function isTabUrlAllowed(url?: string | null): url is string {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  // Block internal browser URLs and privacy-sensitive schemes
  if (/^(chrome|edge|about|chrome-extension):\/\//.test(url)) return false;
  if (/^(file|data|blob|about):/.test(url)) return false;
  return true;
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isImportantAppUrl(url: string): boolean {
  const hostname = hostnameFromUrl(url);
  return IMPORTANT_APP_PATTERNS.some(pattern =>
    hostname === pattern || hostname.endsWith(`.${pattern}`),
  );
}

export function isGroupedTab(tab: { groupId?: number | undefined }): boolean {
  return tab.groupId !== undefined && tab.groupId !== -1;
}

async function getExistingTabIds(tabIds: number[]): Promise<number[]> {
  const existing: number[] = [];
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id !== undefined) existing.push(id);
    } catch {
      // stale tab id - skip
    }
  }
  return existing;
}

async function ungroupTabsSafe(tabIds: number[]): Promise<void> {
  const existing = await getExistingTabIds(tabIds);
  if (existing.length > 0) {
    await chrome.tabs.ungroup(existing as [number, ...number[]]);
  }
}

async function groupTabsSafe(tabIds: number[], groupId?: number, windowId?: number): Promise<number | null> {
  const existing = await getExistingTabIds(tabIds);
  if (existing.length === 0) return null;
  if (groupId !== undefined) {
    await chrome.tabs.group({ tabIds: existing as [number, ...number[]], groupId });
    return groupId;
  }
  const createProperties = windowId !== undefined ? { windowId } : undefined;
  return await chrome.tabs.group({ tabIds: existing as [number, ...number[]], createProperties }) as number;
}

function toWorkspaceTab(
  tab: chrome.tabs.Tab,
  groupsById: Map<number, chrome.tabGroups.TabGroup>,
): WorkspaceTab | null {
  if (!tab.title || !isTabUrlAllowed(tab.url)) return null;
  const group = isGroupedTab(tab) ? groupsById.get(tab.groupId) : null;
  return {
    url: tab.url,
    title: tab.title,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    groupName: group?.title || undefined,
    groupColor: (group?.color as Color | undefined) || undefined,
  };
}

async function getCurrentWindowId(): Promise<number> {
  let win: chrome.windows.Window | undefined;
  try {
    win = await chrome.windows.getCurrent();
  } catch { /* service worker may not have a current window */ }
  if (win?.id === undefined) {
    try {
      win = await chrome.windows.getLastFocused({ populate: false });
    } catch { /* ignore */ }
  }
  if (win?.id === undefined) throw new Error('Could not determine current window');
  return win.id;
}

export async function saveCurrentWorkspace(name: string): Promise<void> {
  const windowId = await getCurrentWindowId();
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  const groupsById = new Map(groups.map(g => [g.id, g]));
  const wsTabs = tabs
    .map(t => toWorkspaceTab(t, groupsById))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  await saveWorkspace(name, { name, savedAt: Date.now(), tabs: wsTabs });
}

export async function restoreWorkspaceByName(name: string): Promise<void> {
  const workspaces = await getWorkspaces();
  const ws = workspaces[name];
  if (!ws) throw new Error(`Workspace "${name}" not found`);

  const newWin = await chrome.windows.create({ focused: true });
  if (newWin === undefined) throw new Error('Could not create window');
  const windowId = newWin.id;
  if (windowId === undefined) throw new Error('Could not create window');

  const groupTabIds = new Map<string, { tabIds: number[]; color?: Color }>();

  for (const wt of ws.tabs) {
    const tab = await chrome.tabs.create({
      windowId,
      url: wt.url,
      pinned: wt.pinned,
      active: wt.active,
    });
    if (tab.id !== undefined && wt.groupName) {
      if (!groupTabIds.has(wt.groupName)) {
        groupTabIds.set(wt.groupName, { tabIds: [], color: wt.groupColor });
      }
      groupTabIds.get(wt.groupName)!.tabIds.push(tab.id);
    }
  }

  for (const [groupName, { tabIds, color }] of groupTabIds) {
    if (tabIds.length === 0) continue;
    const groupId = await groupTabsSafe(tabIds, undefined, windowId);
    if (groupId === null) continue;
    await chrome.tabGroups.update(groupId, { title: groupName, color: color || 'grey', collapsed: false });
  }

  // Close the initial blank tab Chrome opens with new windows
  try {
    const blankTabs = await chrome.tabs.query({ windowId, url: 'chrome://newtab/' });
    const blankIds = blankTabs.map(t => t.id!).filter(Boolean);
    if (blankIds.length > 0) await chrome.tabs.remove(blankIds);
  } catch { /* best-effort */ }
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;
}

async function recordModelUsage(inputTokens: number, outputTokens: number): Promise<void> {
  if (inputTokens <= 0 && outputTokens <= 0) return;
  const settings = await getSettings();
  const cost = calculateCost(settings.model, inputTokens, outputTokens);
  await addCost(settings.provider, inputTokens, outputTokens, cost);
}

export async function getTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.id !== undefined && !t.incognito && isTabUrlAllowed(t.url))
    .map(t => ({ id: t.id!, title: t.title || '', url: t.url! }));
}

export async function snapshotCurrentState(windowId?: number): Promise<UndoSnapshot> {
  const target = windowId ?? await getCurrentWindowId();
  const [tabs, groupDetails] = await Promise.all([
    chrome.tabs.query({ windowId: target }), chrome.tabGroups.query({ windowId: target }),
  ]);
  return {
    timestamp: Date.now(), windowId: target, groupDetails,
    groups: tabs.filter(t => t.id !== undefined && isGroupedTab(t)).map(t => ({ tabId: t.id!, groupId: t.groupId })),
    ungrouped: tabs.filter(t => t.id !== undefined && !isGroupedTab(t)).map(t => t.id!),
    positions: tabs.filter(t => t.id !== undefined).map(t => ({ tabId: t.id!, index: t.index, url: t.url || '' })),
  };
}

export async function restoreSnapshot(snapshot: UndoSnapshot): Promise<void> {
  if (snapshot.windowId === undefined) throw new Error('This undo history predates window-safe undo. Organize again to create a new snapshot.');
  const live = await chrome.tabs.query({ windowId: snapshot.windowId });
  const eligible = new Set(live.filter(t => {
    const position = snapshot.positions?.find(p => p.tabId === t.id);
    return t.id !== undefined && !t.pinned && !t.incognito && position && t.url === position.url &&
      (position.appliedGroupId === undefined || t.groupId === position.appliedGroupId);
  }).map(t => t.id!));
  const ungrouped = snapshot.ungrouped.filter(id => eligible.has(id));
  if (ungrouped.length) await chrome.tabs.ungroup([ungrouped[0], ...ungrouped.slice(1)]);
  const existing = await chrome.tabGroups.query({ windowId: snapshot.windowId });
  const byGroup = new Map<number, number[]>();
  for (const { tabId, groupId } of snapshot.groups) {
    if (!eligible.has(tabId)) continue;
    const ids = byGroup.get(groupId) ?? [];
    ids.push(tabId);
    byGroup.set(groupId, ids);
  }
  for (const [originalId, tabIds] of byGroup) {
    const original = snapshot.groupDetails?.find(g => g.id === originalId);
    const stillExists = existing.some(g => g.id === originalId);
    const id = await chrome.tabs.group({ tabIds: [tabIds[0], ...tabIds.slice(1)], ...(stillExists
      ? { groupId: originalId } : { createProperties: { windowId: snapshot.windowId } }) });
    if (original && !stillExists) {
      await chrome.tabGroups.update(id, { title: original.title, color: original.color, collapsed: original.collapsed });
    }
  }
  for (const position of [...(snapshot.positions ?? [])].sort((a, b) => a.index - b.index)) {
    if (eligible.has(position.tabId)) await chrome.tabs.move(position.tabId, { index: position.index });
  }
}

function consumeLastError(): string | undefined {
  return chrome.runtime.lastError?.message;
}

function removeAllContextMenus(): Promise<void> {
  return new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      consumeLastError();
      resolve();
    });
  });
}

function createContextMenu(props: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise(resolve => {
    chrome.contextMenus.create(props, () => {
      const error = consumeLastError();
      if (error && !error.includes('duplicate id')) {
        console.warn('[gTabs] Failed to create context menu:', props.id, error);
      }
      resolve();
    });
  });
}

async function rebuildContextMenusNow(): Promise<void> {
  await removeAllContextMenus();

  for (const item of ACTION_CONTEXT_MENUS) {
    await createContextMenu(item);
  }

  await createContextMenu({
    id: CTX_ADD_TO_GROUP_ID,
    title: 'Add tab to group...',
    contexts: ['page'],
  });

  let groups: chrome.tabGroups.TabGroup[] = [];
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win.id !== undefined) {
      groups = await chrome.tabGroups.query({ windowId: win.id });
    }
  } catch { /* no focused window */ }

  for (const group of groups) {
    await createContextMenu({
      id: `${CTX_ADD_TO_GROUP_ID}-${group.id}`,
      parentId: CTX_ADD_TO_GROUP_ID,
      title: group.title || `Group ${group.id}`,
      contexts: ['page'],
    });
  }

  await createContextMenu({
    id: `${CTX_ADD_TO_GROUP_ID}-new`,
    parentId: CTX_ADD_TO_GROUP_ID,
    title: '+ New group',
    contexts: ['page'],
  });
}

function rebuildContextMenus(): Promise<void> {
  const rebuild = contextMenuRebuildQueue.then(rebuildContextMenusNow, rebuildContextMenusNow);
  contextMenuRebuildQueue = rebuild.catch(err => {
    console.warn('[gTabs] Failed to rebuild context menus:', err instanceof Error ? err.message : err);
  });
  return rebuild;
}

export async function organize(ungroupedOnly = false, targetWindowId?: number, capturedTabs?: chrome.tabs.Tab[]): Promise<{ suggestions?: GroupSuggestion[]; error?: string }> {
  try {
    const [settings, affinity, domainRules, history, weightedAffinity, corrections, rejections] = await Promise.all([
      getSettings(),
      getAffinity(),
      getDomainRules(),
      getHistory(),
      getWeightedAffinity(),
      getCorrections(),
      getRejections(),
    ]);

    await requireProvider(settings);
    const windowId = targetWindowId ?? await getCurrentWindowId();
    const allTabs = capturedTabs ?? await chrome.tabs.query({ windowId });
    const existingGroups = await chrome.tabGroups.query({ windowId });
    const protectedNames = protectedGroupNames(settings);
    const protectedIds = new Set(existingGroups.filter(g => protectedNames.has((g.title || '').toLowerCase())).map(g => g.id));
    let tabs: TabInfo[] = allTabs.filter(t => t.id !== undefined && !t.pinned && !t.incognito &&
      isTabUrlAllowed(t.url) && !protectedIds.has(t.groupId))
      .map(t => ({ id: t.id!, title: t.title || '', url: t.url! }));
    let existingGroupNames: string[] = [];

    if (ungroupedOnly || settings.mergeMode) {
      const groupedIds = new Set(allTabs.filter(isGroupedTab).map(t => t.id).filter((id): id is number => id !== undefined));
      tabs = tabs.filter(t => !groupedIds.has(t.id));

      existingGroupNames = existingGroups.filter(g => !protectedIds.has(g.id)).map(g => g.title || '').filter(Boolean);
    }

    if (!tabs.length) return { suggestions: [] };

    // Check spending cap before any LLM calls
    if (settings.spendingCapUSD > 0) {
      const costs = await getCosts();
      if (costs.totalCost >= settings.spendingCapUSD) {
        return { error: `Spending cap of $${settings.spendingCapUSD.toFixed(2)} reached. Increase or disable in Settings.` };
      }
    }

    // Build extra hints from learning data
    const extraHints: ExtraHints = {};
    extraHints.affinityHint = formatWeightedAffinityHints(weightedAffinity);

    if (settings.enableCorrectionTracking) {
      extraHints.corrections = await summarizeCorrections(corrections);
    }
    if (settings.enableRejectionMemory) {
      extraHints.rejections = await summarizeRejections(rejections);
    }
    if (settings.enablePatternMining) {
      await updateCoOccurrence(history);
      extraHints.coOccurrence = await summarizeCoOccurrence();
    }

    // Build opener hints
    const openerLines: string[] = [];
    for (const tab of tabs) {
      const openerId = openerMap.get(tab.id);
      if (openerId !== undefined) {
        const openerTab = tabs.find(t => t.id === openerId);
        if (openerTab) {
          openerLines.push(`  Tab ${tab.id} was opened from Tab ${openerId} (likely related)`);
        }
      }
    }
    if (openerLines.length > 0) {
      if (openerLines.length > 15) openerLines.length = 15;
      extraHints.openers = `\nTab relationships (opened from same parent):\n${openerLines.join('\n')}\n`;
    }

    // Smart merge: pre-assign tabs matching existing group names by title
    let preMatched: GroupSuggestion[] = [];
    let tabsForLLM = tabs;
    if (!classificationEndpoint(settings) && existingGroupNames.length > 0) {
      const { matched, remaining } = matchTabsToExistingGroups(tabs, existingGroupNames);
      const colorPrefs = await getGroupColorPrefs();
      preMatched = Array.from(matched.entries()).map(([name, matchedTabs]) => ({
        name,
        color: colorPrefs[name] ?? 'grey',
        tabs: matchedTabs,
      }));
      tabsForLLM = remaining;
    }

    if (tabsForLLM.length === 0 && preMatched.length > 0) {
      const suggestions = preMatched;
      await saveSuggestions(suggestions);
      await chrome.action.setBadgeText({ text: String(suggestions.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });
      return { suggestions };
    }

    const historyHint = summarizeHistory(history) + (existingGroupNames.length ? `\nReuse these existing group names when appropriate: ${JSON.stringify(existingGroupNames)}\n` : '');
    const result = tabsForLLM.length >= 1
      ? await suggest(tabsForLLM, settings, affinity, domainRules, historyHint, extraHints)
      : { suggestions: [] as GroupSuggestion[], inputTokens: 0, outputTokens: 0 };

    const allSuggestions = [...preMatched, ...result.suggestions];

    await recordModelUsage(result.inputTokens, result.outputTokens);
    await saveSuggestions(allSuggestions);
    await chrome.action.setBadgeText({ text: String(allSuggestions.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });

    return { suggestions: allSuggestions };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export async function applyGroups(suggestions: GroupSuggestion[], targetWindowId?: number, capturedTabs?: chrome.tabs.Tab[]): Promise<number> {
  const windowId = targetWindowId ?? await getCurrentWindowId();
  const settings = await getSettings();
  const live = await chrome.tabs.query({ windowId });
  const before = capturedTabs ?? live;
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const protectedNames = protectedGroupNames(settings);
  const protectedIds = new Set(existingGroups.filter(g => protectedNames.has((g.title || '').toLowerCase())).map(g => g.id));
  const seen = new Set<number>();
  const filtered = suggestions.filter(g => !protectedNames.has(g.name.toLowerCase())).map(g => ({
    ...g, tabs: g.tabs.filter(t => {
      const current = live.find(l => l.id === t.id);
      const original = before.find(l => l.id === t.id);
      if (!current || !original || seen.has(t.id) || current.windowId !== windowId ||
        current.incognito || current.pinned || protectedIds.has(current.groupId) ||
        !isTabUrlAllowed(current.url) || current.url !== t.url || (current.title || '') !== t.title ||
        current.groupId !== original.groupId || (settings.mergeMode && isGroupedTab(current))) return false;
      seen.add(t.id);
      return true;
    }),
  })).filter(g => g.tabs.length);
  if (!filtered.length) return 0;

  const snapshot = await snapshotCurrentState(windowId);
  snapshot.groups = snapshot.groups.filter(t => seen.has(t.tabId));
  snapshot.ungrouped = snapshot.ungrouped.filter(id => seen.has(id));
  snapshot.positions = snapshot.positions?.filter(t => seen.has(t.tabId));
  const colorPrefs = await getGroupColorPrefs();
  try {
    for (const group of filtered) {
      // Recheck immediately before each mutation, including navigation/group changes during earlier applies.
      const tabIds: number[] = [];
      for (const tab of group.tabs) {
        let current: chrome.tabs.Tab;
        try { current = await chrome.tabs.get(tab.id); } catch { continue; }
        const original = before.find(t => t.id === tab.id);
        if (current.windowId === windowId && !current.pinned && !current.incognito &&
          current.url === tab.url && (current.title || '') === tab.title && current.groupId === original?.groupId) tabIds.push(tab.id);
      }
      if (!tabIds.length) continue;
      const groups = await chrome.tabGroups.query({ windowId });
      const existing = groups.find(g => g.title?.toLowerCase() === group.name.toLowerCase());
      const id = await chrome.tabs.group({ tabIds: [tabIds[0], ...tabIds.slice(1)], ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }) });
      for (const pos of snapshot.positions ?? []) if (tabIds.includes(pos.tabId)) pos.appliedGroupId = id;
      await saveUndoSnapshot(appliedSnapshot(snapshot));
      if (!existing) await chrome.tabGroups.update(id, { title: group.name, color: colorPrefs[group.name] || group.color, collapsed: false });
    }
  } catch {
    const applied = appliedSnapshot(snapshot);
    if (!applied.positions?.length) throw new Error('Could not apply groups. No tabs were changed.');
    try {
      await restoreSnapshot(applied);
      await saveUndoSnapshot(null);
    } catch {
      throw new Error('Could not apply all groups. Use Undo to recover the previous arrangement.');
    }
    throw new Error('Could not apply groups. The previous arrangement was restored.');
  }
  const appliedIds = new Set(snapshot.positions?.filter(p => p.appliedGroupId !== undefined).map(p => p.tabId));
  const applied = filtered.map(g => ({ ...g, tabs: g.tabs.filter(t => appliedIds.has(t.id)) })).filter(g => g.tabs.length);
  if (!appliedIds.size) return 0;
  await updateAffinity(applied);
  await addHistory(applied);
  await incrementStats(appliedIds.size);
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });
  return appliedIds.size;
}

function appliedSnapshot(snapshot: UndoSnapshot): UndoSnapshot {
  const positions = snapshot.positions?.filter(p => p.appliedGroupId !== undefined) ?? [];
  const ids = new Set(positions.map(p => p.tabId));
  return { ...snapshot, positions, groups: snapshot.groups.filter(t => ids.has(t.tabId)), ungrouped: snapshot.ungrouped.filter(id => ids.has(id)) };
}

let organizationInFlight = false;
let organizationStatus: OrganizationStatus = { state: 'idle', message: 'Organize tabs in this window.', canUndo: false };

async function setOrganizationStatus(state: OrganizationStatus['state'], message: string): Promise<void> {
  organizationStatus = { state, message, canUndo: Boolean(await getUndoSnapshot()) };
  await chrome.storage.session.set({ organizationStatus });
}

export async function getOrganizationStatus(): Promise<OrganizationStatus> {
  if (organizationInFlight) return { ...organizationStatus, state: 'running' };
  const saved = await chrome.storage.session.get('organizationStatus');
  const previous: unknown = saved.organizationStatus;
  if (previous && typeof previous === 'object' && 'state' in previous && 'message' in previous && typeof previous.message === 'string') {
    const state = previous.state;
    if (state === 'running') return { state: 'error', message: 'Organization was interrupted. Try again; Undo is available if changes were applied.', canUndo: Boolean(await getUndoSnapshot()) };
    if (state === 'idle' || state === 'done' || state === 'error') return { state, message: previous.message, canUndo: Boolean(await getUndoSnapshot()) };
  }
  return { ...organizationStatus, canUndo: Boolean(await getUndoSnapshot()) };
}

async function tabFingerprint(tabs: chrome.tabs.Tab[], settings: Settings): Promise<string> {
  const { apiKey: _key, ...safeSettings } = settings;
  const text = JSON.stringify([safeSettings, tabs.filter(t => !t.incognito && !t.pinned && isTabUrlAllowed(t.url))
    .map(t => [t.id, t.url, t.title, t.groupId]).sort((a, b) => Number(a[0]) - Number(b[0]))]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function organizeAndApply(windowId?: number, automatic = false, ungroupedOnly = false): Promise<OrganizationStatus> {
  if (organizationInFlight) return { ...organizationStatus, state: 'running', message: 'Organization is already running.' };
  organizationInFlight = true;
  // Extension API calls keep a long, multi-chunk run alive after the popup closes.
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
  try {
    await setOrganizationStatus('running', 'Organizing… You can close this popup.');
    const settings = await getSettings();
    await requireProvider(settings);
    const windows = automatic ? await chrome.windows.getAll({ windowTypes: ['normal'] }) : [{ id: windowId ?? await getCurrentWindowId(), incognito: false }];
    let changed = false;
    for (const win of windows) {
      if (win.id === undefined || win.incognito) continue;
      const tabs = await chrome.tabs.query({ windowId: win.id });
      const key = `organizedWindow:${win.id}`;
      const fingerprint = await tabFingerprint(tabs, settings);
      if (automatic) {
        const saved = await chrome.storage.session.get(key);
        if (saved[key] === fingerprint) continue;
        if (settings.reorgSchedule === 'off' && tabs.filter(t => !isGroupedTab(t) && !t.pinned && !t.incognito && isTabUrlAllowed(t.url)).length < settings.threshold) continue;
      }
      const result = await organize(ungroupedOnly || automatic, win.id, tabs);
      if (result.error) throw new Error(result.error);
      if (JSON.stringify(await getSettings()) !== JSON.stringify(settings)) throw new Error('Settings changed during organization. Try again.');
      if (result.suggestions?.length) {
        const count = await applyGroups(result.suggestions, win.id, tabs);
        changed = changed || count > 0;
      }
      // Store the captured input, not tabs added/navigated while the request was pending.
      const current = await chrome.tabs.query({ windowId: win.id });
      const applied = new Map(current.map(t => [t.id, t]));
      const processed = tabs.map(t => ({ ...t, groupId: applied.get(t.id)?.groupId ?? t.groupId }));
      await chrome.storage.session.set({ [key]: await tabFingerprint(processed, settings) });
    }
    await setOrganizationStatus('done', changed ? 'Tabs organized.' : 'No new tabs to organize.');
  } catch (error) {
    await setOrganizationStatus('error', error instanceof Error ? error.message : 'Organization failed.');
  } finally {
    clearInterval(keepAlive);
    organizationInFlight = false;
  }
  return organizationStatus;
}

export async function undoLastGrouping(): Promise<{ error?: string }> {
  if (organizationInFlight) return { error: 'Wait for organization to finish before undoing.' };
  organizationInFlight = true;
  try {
    const snapshot = await getUndoSnapshot();
    if (!snapshot) return { error: 'No undo history available' };
    await restoreSnapshot(snapshot);
    await saveUndoSnapshot(null);
    await setOrganizationStatus('done', 'Last grouping undone.');
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Undo failed' };
  } finally { organizationInFlight = false; }
}

export async function findDuplicateTabs(): Promise<TabInfo[][]> {
  return findDuplicates(await getTabs());
}

export async function consolidateWindows(): Promise<number> {
  const currentWindowId = await getCurrentWindowId();
  const windows = await chrome.windows.getAll({ populate: true });
  let moved = 0;

  for (const win of windows) {
    if (win.id === undefined || win.id === currentWindowId) continue;
    const tabIds = (win.tabs || [])
      .filter(tab => tab.id !== undefined && isTabUrlAllowed(tab.url) && !tab.pinned)
      .map(tab => tab.id!);

    if (tabIds.length === 0) continue;
    await chrome.tabs.move(tabIds, { windowId: currentWindowId, index: -1 });
    moved += tabIds.length;
  }

  await autoPinImportantApps(currentWindowId);
  return moved;
}



export async function purgeStaleTabs(): Promise<number> {
  const settings = await getSettings();
  const thresholdMs = settings.staleTabThresholdHours * 60 * 60 * 1000;
  const now = Date.now();
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const toRemove = tabs
    .filter(tab =>
      tab.id !== undefined &&
      isTabUrlAllowed(tab.url) &&
      !tab.active &&
      !tab.pinned &&
      tab.lastAccessed != null && tab.lastAccessed > 0 &&
      (now - tab.lastAccessed) > thresholdMs,
    )
    .map(tab => tab.id!);

  if (toRemove.length) {
    try {
      await chrome.tabs.remove(toRemove);
    } catch { /* some tabs may have been closed already */ }
  }

  return toRemove.length;
}



export async function focusCurrentGroup(): Promise<number> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.windowId === undefined) throw new Error('No active tab');
  if (!isGroupedTab(activeTab)) throw new Error('Active tab must be grouped to focus');

  const groups = await chrome.tabGroups.query({ windowId: activeTab.windowId });
  for (const group of groups) {
    await chrome.tabGroups.update(group.id, { collapsed: group.id !== activeTab.groupId });
  }

  return groups.length;
}



export async function sortCurrentGroupsByDomain(): Promise<number> {
  const tabs = (await chrome.tabs.query({ currentWindow: true }))
    .filter(tab => tab.id !== undefined && isTabUrlAllowed(tab.url));
  const buckets = new Map<string, chrome.tabs.Tab[]>();

  for (const tab of tabs) {
    const key = isGroupedTab(tab) ? `group:${tab.groupId}` : 'ungrouped';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(tab);
  }

  const orderedBuckets = Array.from(buckets.values())
    .map(bucket => bucket.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)))
    .sort((a, b) => (a[0]?.index ?? 0) - (b[0]?.index ?? 0));

  for (const bucket of orderedBuckets) {
    const startIndex = bucket[0]?.index ?? 0;
    const sorted = [...bucket].sort((a, b) => {
      const hostDiff = hostnameFromUrl(a.url!).localeCompare(hostnameFromUrl(b.url!));
      if (hostDiff !== 0) return hostDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    for (let i = 0; i < sorted.length; i++) {
      try { await chrome.tabs.move(sorted[i].id!, { index: startIndex + i }); } catch { /* tab may have been closed */ }
    }
  }

  await autoPinImportantApps();
  return orderedBuckets.length;
}

export async function exportGroupsAsMarkdown(): Promise<string> {
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const lines: string[] = ['# Tab Groups', ''];

  const escMd = (s: string) => s.replace(/[[\]]/g, '\\$&');

  for (const group of groups) {
    lines.push(`## ${group.title || 'Unnamed Group'}`);
    const groupTabs = tabs.filter(t => t.groupId === group.id && isTabUrlAllowed(t.url));
    for (const tab of groupTabs) {
      lines.push(`- [${escMd(tab.title || tab.url || '')}](${tab.url})`);
    }
    lines.push('');
  }

  const ungroupedTabs = tabs.filter(t => !isGroupedTab(t) && isTabUrlAllowed(t.url));
  if (ungroupedTabs.length) {
    lines.push('## Ungrouped');
    for (const tab of ungroupedTabs) {
      lines.push(`- [${escMd(tab.title || tab.url || '')}](${tab.url})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function deleteAllTabGroups(): Promise<number> {
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });

  const settings = await getSettings();
  const pinnedSet = new Set(settings.pinnedGroups);

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupedTabs = tabs.filter(tab => tab.id !== undefined && isGroupedTab(tab));
  if (!groupedTabs.length) return 0;

  // Respect pinned groups — find which group IDs are pinned
  const pinnedGroupIds = new Set<number>();
  if (pinnedSet.size > 0) {
    try {
      const windowId = await getCurrentWindowId();
      const groups = await chrome.tabGroups.query({ windowId });
      for (const g of groups) {
        if (g.title && pinnedSet.has(g.title)) pinnedGroupIds.add(g.id);
      }
    } catch { /* ignore */ }
  }

  const tabIds = groupedTabs
    .filter(tab => !pinnedGroupIds.has(tab.groupId))
    .map(tab => tab.id!);
  const uniqueGroups = new Set(
    groupedTabs.filter(tab => !pinnedGroupIds.has(tab.groupId)).map(tab => tab.groupId),
  );

  if (tabIds.length > 0) {
    await ungroupTabsSafe(tabIds);
  }
  return uniqueGroups.size;
}

export async function autoPinImportantApps(windowId?: number): Promise<number> {
  const settings = await getSettings();
  if (!settings.autoPinApps) return 0;

  const tabs = await chrome.tabs.query(windowId ? { windowId } : { currentWindow: true });
  const importantTabs = tabs
    .filter(tab =>
      tab.id !== undefined &&
      isTabUrlAllowed(tab.url) &&
      isImportantAppUrl(tab.url!) &&
      !isGroupedTab(tab),
    )
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let pinnedCount = 0;
  for (let i = 0; i < importantTabs.length; i++) {
    const tab = importantTabs[i];
    try {
      if (!tab.pinned) pinnedCount++;
      await chrome.tabs.update(tab.id!, { pinned: true });
      await chrome.tabs.move(tab.id!, { index: i });
    } catch { /* tab may have been closed during operation */ }
  }

  return pinnedCount;
}



// --- Group Drift Detection ---

export async function checkGroupDrift(): Promise<{ drifted: boolean; driftedGroups: string[] }> {
  const settings = await getSettings();
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const driftedGroups: string[] = [];

  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (tabs.length < 2) continue;

    const domainCounts: Record<string, number> = {};
    for (const tab of tabs) {
      if (!tab.url) continue;
      const domain = hostnameFromUrl(tab.url);
      if (domain) domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
    }

    const counts = Object.values(domainCounts);
    if (counts.length === 0) continue; // skip empty/unresolvable groups
    const maxCount = Math.max(...counts);
    const coherence = (maxCount / tabs.length) * 100;

    if (coherence < settings.groupDriftThreshold) {
      driftedGroups.push(group.title || `Group ${group.id}`);
    }
  }

  return { drifted: driftedGroups.length > 0, driftedGroups };
}

// --- Merge/Split Suggestions ---

export async function getMergeSplitSuggestions(): Promise<MergeSplitResult> {
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const groupDomains: Map<string, Set<string>> = new Map();
  const groupTabCounts: Map<string, number> = new Map();

  for (const group of groups) {
    const name = group.title || `Group ${group.id}`;
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const domains = new Set<string>();
    for (const tab of tabs) {
      if (tab.url) {
        const d = hostnameFromUrl(tab.url);
        if (d) domains.add(d);
      }
    }
    groupDomains.set(name, domains);
    groupTabCounts.set(name, tabs.length);
  }

  const merges: MergeSplitResult['merges'] = [];
  const names = Array.from(groupDomains.keys());

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = groupDomains.get(names[i])!;
      const b = groupDomains.get(names[j])!;
      let intersection = 0;
      for (const d of a) if (b.has(d)) intersection++;
      const union = new Set([...a, ...b]).size;
      const overlap = union > 0 ? intersection / union : 0;
      if (overlap > 0.6) {
        merges.push({ group1: names[i], group2: names[j], overlap: Math.round(overlap * 100) });
      }
    }
  }

  const splits: MergeSplitResult['splits'] = [];
  for (const [name, domains] of groupDomains) {
    const tabCount = groupTabCounts.get(name) ?? 0;
    if (tabCount > 10 && domains.size > 5) {
      splits.push({ group: name, tabCount, domainCount: domains.size });
    }
  }

  return { merges, splits };
}

// --- Scheduled Re-org ---

let alarmSetup: Promise<void> = Promise.resolve();
export function setupReorgAlarm(): Promise<void> {
  alarmSetup = alarmSetup.catch(() => {}).then(async () => {
    const settings = await getSettings();
    let configured = true;
    try { await requireProvider(settings); } catch { configured = false; }
    if (configured && settings.autoTrigger && settings.reorgSchedule === 'off') {
      if (!await chrome.alarms.get(ALARM_NAME)) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 });
    } else await chrome.alarms.clear(ALARM_NAME);
    if (!configured || settings.reorgSchedule === 'off') {
      await chrome.alarms.clear(REORG_ALARM_NAME);
      return;
    }
    const periodInMinutes = settings.reorgSchedule === 'five-minutes' ? 5 : settings.reorgSchedule === 'daily' ? 1440 : 10080;
    const existing = await chrome.alarms.get(REORG_ALARM_NAME);
    const scheduleKey = `${settings.reorgSchedule}:${settings.reorgTime}`;
    const saved = await chrome.storage.local.get('alarmSchedule');
    if (existing?.periodInMinutes === periodInMinutes && (periodInMinutes === 5 || saved.alarmSchedule === scheduleKey)) return;
    const next = new Date();
    const now = new Date(next);
    next.setHours(settings.reorgTime, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + (settings.reorgSchedule === 'weekly' ? 7 : 1));
    const delayInMinutes = periodInMinutes === 5 ? 5 : Math.max(1, (next.getTime() - now.getTime()) / 60000);
    await chrome.alarms.create(REORG_ALARM_NAME, { delayInMinutes, periodInMinutes });
    await chrome.storage.local.set({ alarmSchedule: scheduleKey });
  });
  return alarmSetup;
}

async function checkAutoTrigger(): Promise<void> {
  const settings = await getSettings();
  if (settings.autoTrigger && settings.reorgSchedule === 'off') await organizeAndApply(undefined, true);
}

chrome.runtime.onMessage.addListener((msg: MessageType, _sender, sendResponse) => {
  if (msg.type === 'organize' || msg.type === 'organize-ungrouped') {
    const target = msg.type === 'organize' ? msg.windowId : undefined;
    organizeAndApply(target, false, msg.type === 'organize-ungrouped').then(organization =>
      sendResponse({ type: 'status', status: organization.state, organization }));
    return true;
  }
  if (msg.type === 'get-organization-status') {
    getOrganizationStatus().then(organization => sendResponse({ type: 'status', status: organization.state, organization }));
    return true;
  }
  if (msg.type === 'apply') {
    sendResponse({ type: 'status', status: 'error', error: 'Use Organize to generate and apply fresh groups.' });
    return false;
  }

  if (msg.type === 'undo') {
    undoLastGrouping().then(r => sendResponse({ type: 'status', status: r.error ? 'error' : 'undone', error: r.error }));
    return true;
  }

  if (msg.type === 'find-duplicates') {
    findDuplicateTabs().then(duplicates => sendResponse({ type: 'status', status: 'done', duplicates }));
    return true;
  }

  if (msg.type === 'consolidate-windows') {
    consolidateWindows()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'purge-stale') {
    purgeStaleTabs()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'focus-group') {
    focusCurrentGroup()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'sort-groups') {
    sortCurrentGroupsByDomain()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'delete-all-groups') {
    deleteAllTabGroups()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'get-stats') {
    getStats().then(stats => sendResponse({ type: 'status', status: 'done', stats }));
    return true;
  }

  if (msg.type === 'get-costs') {
    getCosts().then(costs => sendResponse({ type: 'status', status: 'done', costs }));
    return true;
  }

  if (msg.type === 'export-data') {
    exportAll().then(data => sendResponse({ type: 'status', status: 'done', data }));
    return true;
  }

  if (msg.type === 'import-data') {
    importAll(msg.data)
      .then(() => sendResponse({ type: 'status', status: 'imported' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'test-connection') {
    getSettings()
      .then(async settings => { await requireProvider(settings); return testConnection(settings); })
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'check-chrome-ai') {
    sendResponse({ type: 'status', status: 'done', available: isChromeAIAvailable() });
    return false;
  }

  if (msg.type === 'fetch-ollama-models') {
    getSettings()
      .then(settings => fetchOllamaModels(settings.baseUrl))
      .then(models => sendResponse({ type: 'status', status: 'done', models }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error), models: [] }));
    return true;
  }

  if (msg.type === 'record-corrections') {
    (async () => {
      await addCorrections(msg.corrections);
      // Apply correction weight (3x) to weighted affinity
      const correctedSuggestions: GroupSuggestion[] = [];
      for (const c of msg.corrections.corrections) {
        correctedSuggestions.push({
          name: c.correctedGroup,
          color: 'grey',
          tabs: [{ id: -1, title: '', url: `https://${c.domain}` }],
        });
      }
      if (correctedSuggestions.length > 0) {
        await updateWeightedAffinity(correctedSuggestions, 3);
      }
      sendResponse({ type: 'status', status: 'done' });
    })();
    return true;
  }

  if (msg.type === 'record-rejections') {
    addRejections(msg.rejections)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'check-group-drift') {
    checkGroupDrift()
      .then(result => sendResponse({ type: 'status', status: 'done', ...result }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'merge-split-suggestions') {
    getMergeSplitSuggestions()
      .then(mergeSplit => sendResponse({ type: 'status', status: 'done', mergeSplit }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'export-markdown') {
    exportGroupsAsMarkdown()
      .then(markdown => sendResponse({ type: 'status', status: 'done', markdown }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'search-tabs') {
    (async () => {
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        const groupMap = new Map(groups.map(g => [g.id, g.title || `Group ${g.id}`]));
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const q = (msg.query || '').toLowerCase();
        const tabResults = tabs
          .filter(t => t.id !== undefined && isTabUrlAllowed(t.url) && (
            !q || (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)
          ))
          .map(t => ({
            id: t.id!,
            title: t.title || t.url || '',
            url: t.url!,
            groupName: isGroupedTab(t) ? (groupMap.get(t.groupId) || '') : '',
            groupId: isGroupedTab(t) ? t.groupId : -1,
          }));
        sendResponse({ type: 'status', status: 'done', tabResults });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Search failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'get-group-stats') {
    (async () => {
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        const groupStats = [];
        for (const group of groups) {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          const domains = [...new Set(
            tabs.filter(t => t.url).map(t => hostnameFromUrl(t.url!)).filter(Boolean)
          )];
          groupStats.push({
            name: group.title || `Group ${group.id}`,
            color: group.color,
            tabCount: tabs.length,
            domains,
          });
        }
        sendResponse({ type: 'status', status: 'done', groupStats });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'snooze-tabs') {
    (async () => {
      try {
        let count = 0;
        for (const tabId of msg.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab.url || !isTabUrlAllowed(tab.url)) continue;
            const snoozeId = `${Date.now()}-${tabId}`;
            const entry: SnoozedTab = {
              id: snoozeId,
              url: tab.url,
              title: tab.title || tab.url,
              wakeAt: msg.wakeAt,
            };
            await addSnoozedTab(entry);
            const delayMs = Math.max(60000, msg.wakeAt - Date.now());
            chrome.alarms.create(`${SNOOZE_ALARM_PREFIX}${snoozeId}`, { delayInMinutes: Math.ceil(delayMs / 60000) });
            await chrome.tabs.remove(tabId);
            count++;
          } catch { /* skip tabs that no longer exist */ }
        }
        sendResponse({ type: 'status', status: 'done', count });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Snooze failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'list-workspaces') {
    getWorkspaces()
      .then(ws => sendResponse({ type: 'status', status: 'done', workspaceNames: Object.keys(ws) }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'save-workspace') {
    saveCurrentWorkspace(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'restore-workspace') {
    restoreWorkspaceByName(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'delete-workspace') {
    removeWorkspace(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }
});

let commandInFlight = false;
let commandInFlightTimer: ReturnType<typeof setTimeout> | null = null;
chrome.commands?.onCommand?.addListener((command: string) => {
  if (commandInFlight) return;
  commandInFlight = true;
  // Safety timeout: reset flag after 60s in case command hangs
  commandInFlightTimer = setTimeout(() => { commandInFlight = false; }, 60_000);
  const p = command === 'organize-tabs' ? organizeAndApply() : command === 'undo-grouping' ? undoLastGrouping() : null;
  (p || Promise.resolve()).finally(() => { commandInFlight = false; if (commandInFlightTimer) clearTimeout(commandInFlightTimer); });
});

chrome.runtime.onInstalled.addListener(() => {
  void setupReorgAlarm();
  return rebuildContextMenus();
});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === 'gtabs-organize') void organizeAndApply(tab?.windowId);
  if (info.menuItemId === 'gtabs-organize-ungrouped') void organizeAndApply(tab?.windowId, false, true);
  if (info.menuItemId === 'gtabs-undo') void undoLastGrouping().catch(() => {});
  if (info.menuItemId === 'gtabs-duplicates') void findDuplicateTabs().catch(() => {});

  const menuId = String(info.menuItemId);
  if (menuId === `${CTX_ADD_TO_GROUP_ID}-new` && tab?.id !== undefined) {
    const tabId = tab.id;
    (async () => {
      const newGroupId = await groupTabsSafe([tabId]);
      if (newGroupId === null) return;
      await chrome.tabGroups.update(newGroupId, { title: 'New Group', collapsed: false });
      await rebuildContextMenus();
    })();
  } else if (menuId.startsWith(`${CTX_ADD_TO_GROUP_ID}-`) && tab?.id !== undefined) {
    const groupId = Number(menuId.slice(CTX_ADD_TO_GROUP_ID.length + 1));
    if (Number.isInteger(groupId) && groupId > 0 && groupId < MAX_CONTEXT_GROUP_ID) {
      void groupTabsSafe([tab.id], groupId);
    }
  }
});

chrome.tabGroups?.onCreated?.addListener(() => rebuildContextMenus());
chrome.tabGroups?.onRemoved?.addListener(() => rebuildContextMenus());
chrome.tabGroups?.onUpdated?.addListener((group) => {
  rebuildContextMenus();
  if (group.title && group.color) {
    saveGroupColorPref(group.title, group.color as Color).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) triggerAutoCheck();
  if (alarm.name === REORG_ALARM_NAME) {
    return getSettings().then(async settings => {
      if (settings.reorgSchedule !== 'off') await organizeAndApply(undefined, true);
    });
  }
  if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
    const snoozeId = alarm.name.slice(SNOOZE_ALARM_PREFIX.length);
    (async () => {
      try {
        const tabs = await getSnoozedTabs();
        const entry = tabs.find(t => t.id === snoozeId);
        if (!entry) return;
        let windowId: number | undefined;
        try {
          const win = await chrome.windows.getLastFocused({ populate: false });
          if (win.id !== undefined) windowId = win.id;
        } catch { /* best-effort fallback */ }
        await chrome.tabs.create({ url: entry.url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
        await removeSnoozedTab(snoozeId);
      } catch (err) {
        console.warn('[gTabs] Failed to restore snoozed tab:', err instanceof Error ? err.message : err);
      }
    })();
  }
});

function triggerAutoCheck() {
  if (autoCheckInFlight) return;
  const now = Date.now();
  if (now - lastAutoCheckTime < AUTO_CHECK_COOLDOWN_MS) return;

  autoCheckInFlight = true;
  lastAutoCheckTime = now;
  checkAutoTrigger()
    .catch(() => {
      // Keep auto-trigger best-effort and never break the event loop on runtime failures.
    })
    .finally(() => {
      autoCheckInFlight = false;
    });
}

chrome.tabs.onCreated?.addListener((tab: chrome.tabs.Tab) => {
  // Track opener relationship
  if (tab?.id !== undefined && tab?.openerTabId !== undefined) {
    openerMap.set(tab.id, tab.openerTabId);
    if (openerMap.size > MAX_TRACKED_TAB_RELATIONS) {
      const oldest = openerMap.keys().next().value;
      if (oldest !== undefined) openerMap.delete(oldest);
    }
  }
  triggerAutoCheck();
});

chrome.tabs.onRemoved?.addListener((tabId: number) => {
  // Clean up in-memory maps — no auto-check needed on removal
  if (tabId !== undefined) {
    openerMap.delete(tabId);
    tabActivationTimes.delete(tabId);
  }
});

chrome.tabs.onActivated?.addListener((activeInfo: { tabId: number }) => {
  if (activeInfo?.tabId !== undefined) {
    tabActivationTimes.set(activeInfo.tabId, Date.now());
    if (tabActivationTimes.size > MAX_TRACKED_TAB_RELATIONS) {
      const oldest = tabActivationTimes.keys().next().value;
      if (oldest !== undefined) tabActivationTimes.delete(oldest);
    }
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if ((areaName === 'sync' && changes.settings) || (areaName === 'local' && changes.apiKeyLocal)) {
    void setupReorgAlarm();
  }
});

chrome.tabs.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (organizationInFlight || tab.incognito || tab.pinned) return;
  if (changeInfo.status !== 'complete' || !tab.url || tab.windowId === undefined) return;
  if (!isTabUrlAllowed(tab.url)) return;

  organizationInFlight = true;
  const previousStatus = organizationStatus;
  try {
    await setOrganizationStatus('running', 'Checking tab routing…');

    if (isGroupedTab(tab)) {
      const settings = await getSettings();
      if (settings.smartUngroup) {
        try {
          const groupTabs = await chrome.tabs.query({ groupId: tab.groupId, windowId: tab.windowId });
          const otherTabs = groupTabs.filter(t => t.id !== tabId && isTabUrlAllowed(t.url));
          const newDomain = hostnameFromUrl(tab.url);
          if (otherTabs.length > 0 && newDomain) {
            const groupDomains = otherTabs.map(t => hostnameFromUrl(t.url!)).filter(Boolean);
            // Handle ccTLDs like .co.uk, .com.au
            const baseDomain = (d: string) => {
              const parts = d.split('.');
              if (parts.length >= 3) {
                const tld = parts[parts.length - 1];
                const sld = parts[parts.length - 2];
                if (tld.length === 2 && SECONDARY_TLDS.has(sld)) return parts.slice(-3).join('.');
              }
              return parts.slice(-2).join('.');
            };
            const isRelated = groupDomains.some(d => baseDomain(d) === baseDomain(newDomain));
            if (!isRelated) {
              await ungroupTabsSafe([tabId]);
            }
          }
        } catch { /* ignore */ }
      }
      return;
    }

    const settings = await getSettings();
    if (!settings.silentAutoAdd) return;

    // 1. Check opener — if opener is in a group, prefer that group
    const openerId = openerMap.get(tabId);
    if (openerId !== undefined) {
      try {
        const openerTab = await chrome.tabs.get(openerId);
        if (isGroupedTab(openerTab) && openerTab.windowId === tab.windowId) {
          await groupTabsSafe([tabId], openerTab.groupId);
          return;
        }
      } catch { /* opener may have been closed */ }
    }

    // 2. Use enhanced inferTargetGroup with weighted affinity and rejections
    const [rules, affinity, weightedAffinity, rejections] = await Promise.all([
      getDomainRules(), getAffinity(), getWeightedAffinity(), getRejections(),
    ]);
    const inferred = inferTargetGroup(tab.url, rules, affinity, weightedAffinity, rejections);
    if (!inferred) return;

    try {
      const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: inferred.name });
      if (groups.length > 0) {
        await groupTabsSafe([tabId], groups[0].id);
      } else {
        const newGroupId = await groupTabsSafe([tabId]);
        if (newGroupId === null) return;
        await chrome.tabGroups.update(newGroupId, {
          title: inferred.name,
          color: inferred.color || 'grey',
          collapsed: false,
        });
      }
    } catch {
      // Ignored if grouping fails while the window is changing.
    }
  } finally {
    const restoredStatus = { ...previousStatus, canUndo: Boolean(await getUndoSnapshot()) };
    organizationStatus = restoredStatus;
    organizationInFlight = false;
    await chrome.storage.session.set({ organizationStatus: restoredStatus });
    triggerAutoCheck();
  }
});

chrome.runtime.onStartup.addListener(() => { void setupReorgAlarm(); });
chrome.permissions.onRemoved.addListener(() => { void setupReorgAlarm(); });
void setupReorgAlarm();
