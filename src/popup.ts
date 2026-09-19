import { sendMessage } from './messages';
import type { OrganizationStatus } from './types';

const organize = document.querySelector<HTMLButtonElement>('#organize')!;
const undo = document.querySelector<HTMLButtonElement>('#undo')!;
const status = document.querySelector<HTMLElement>('#status')!;
let pending = false;

function render(value: OrganizationStatus): void {
  const running = pending || value.state === 'running';
  organize.disabled = running;
  undo.disabled = running || !value.canUndo;
  status.textContent = value.message;
  status.classList.toggle('error', value.state === 'error');
}

function showError(error: unknown): void {
  render({ state: 'error', message: error instanceof Error ? error.message : 'Could not organize tabs.', canUndo: !undo.disabled });
}

async function refresh(): Promise<void> {
  try {
    const response = await sendMessage({ type: 'get-organization-status' });
    if (response?.organization) render(response.organization);
    else throw new Error('No response. Reload the extension and try again.');
  } catch (error) { showError(error); }
}

organize.addEventListener('click', async () => {
  if (pending) return;
  pending = true;
  render({ state: 'running', message: 'Organizing… You can close this popup.', canUndo: false });
  try {
    const window = await chrome.windows.getCurrent();
    if (window.id === undefined) throw new Error('Could not determine this window.');
    const response = await sendMessage({ type: 'organize', windowId: window.id });
    pending = false;
    if (response?.organization) render(response.organization);
    else throw new Error(response?.error || 'No response. Reopen the popup to check progress.');
  } catch (error) { pending = false; showError(error); }
});

undo.addEventListener('click', async () => {
  pending = true;
  render({ state: 'running', message: 'Undoing last grouping…', canUndo: true });
  try {
    const response = await sendMessage({ type: 'undo' });
    pending = false;
    if (!response || response.error) throw new Error(response?.error || 'No response. Try again.');
    await refresh();
  } catch (error) { pending = false; showError(error); }
});

document.querySelector('#open-settings')!.addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.organizationStatus) void refresh();
});
void refresh();
