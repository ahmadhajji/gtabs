import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetAllMocks, emit } from './setup';
import type { OrganizationStatus } from '../src/types';

const html = readFileSync(resolve(__dirname, '../src/popup.html'), 'utf8');
let current: OrganizationStatus;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;

beforeEach(async () => {
  vi.resetModules();
  resetAllMocks();
  document.body.innerHTML = html;
  current = { state: 'idle', message: 'Ready', canUndo: false };
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((message, callback) => {
    if (typeof callback !== 'function') throw new Error('Missing callback');
    callback({ type: 'status', status: current.state, organization: current });
  });
  await import('../src/popup');
  await vi.waitFor(() => expect(button('organize').disabled).toBe(false));
});

describe('compact popup', () => {
  it('organizes the captured window with no Apply step and opens full settings', async () => {
    current = { state: 'done', message: 'Tabs organized.', canUndo: true };
    button('organize').click();
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent).toBe('Tabs organized.'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'organize', windowId: 1 }, expect.any(Function));
    expect(document.querySelector('#apply-all')).toBeNull();
    expect(button('undo').disabled).toBe(false);
    button('open-settings').click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('disables duplicate actions and reflects background progress', async () => {
    current = { state: 'running', message: 'Organizing…', canUndo: true };
    button('organize').click();
    button('organize').click();
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent).toBe('Organizing…'));
    expect(button('organize').disabled).toBe(true);
    expect(button('undo').disabled).toBe(true);
    current = { state: 'done', message: 'Tabs organized.', canUndo: true };
    await emit(chrome.storage.onChanged, { organizationStatus: { newValue: current } }, 'session');
    await vi.waitFor(() => expect(button('organize').disabled).toBe(false));
  });

  it('reports background and transport errors without getting stuck', async () => {
    current = { state: 'error', message: 'API host access is missing.', canUndo: false };
    button('organize').click();
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent).toContain('host access'));
    expect(button('organize').disabled).toBe(false);
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce((_message, callback) => {
      if (typeof callback === 'function') callback(undefined);
    });
    button('organize').click();
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent).toContain('No response'));
    expect(button('organize').disabled).toBe(false);
  });
});
