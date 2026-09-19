import type { MessageType } from './types';

type Response = Extract<MessageType, { type: 'status' }>;

export function sendMessage(message: Exclude<MessageType, Response>): Promise<Response | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: Response | undefined) => {
      if (chrome.runtime.lastError) reject(new Error('Could not contact gTabs. Reload the extension and try again.'));
      else resolve(response);
    });
  });
}
