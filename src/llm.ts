import type { LLMConfig } from './types';
import { classificationEndpoint } from './provider';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
}

const LLM_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 4096;

function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function normalizeBaseUrl(baseUrl: string): string { return baseUrl.trim().replace(/\/+$/, ''); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function tokenCount(value: unknown, text: string): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : estimateTokens(text);
}

async function fetchJSON(url: string, init: RequestInit, timeoutMs = LLM_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!res.ok) throw new Error(`LLM error ${res.status}. Check your provider settings.`);
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`LLM request timed out after ${timeoutMs / 1000}s`);
    if (error instanceof Error && error.message.startsWith('LLM error')) throw error;
    throw new Error('Could not read a valid response from the API. Check the endpoint and connection.');
  } finally { clearTimeout(timer); }
}

export function isChromeAIAvailable(): boolean { return typeof globalThis.LanguageModel !== 'undefined'; }

async function completeChromeAI(messages: Message[]): Promise<CompletionResult> {
  const LM = globalThis.LanguageModel;
  if (!LM) throw new Error('Chrome AI not available. Choose another provider in Settings.');
  const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userContent = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n');
  const session = await LM.create(systemPrompt ? { systemPrompt } : {});
  try {
    const content = await session.prompt(userContent);
    return { content, inputTokens: estimateTokens(systemPrompt + userContent), outputTokens: estimateTokens(content) };
  } finally { session.destroy(); }
}

async function completeAnthropic(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('API key is required for Anthropic');
  const inputText = messages.map(m => m.content).join('');
  const data = await fetchJSON(`${normalizeBaseUrl(config.baseUrl)}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: config.model, max_tokens: MAX_TOKENS, temperature: 0.2, ...(system ? { system } : {}), messages: messages.filter(m => m.role !== 'system') }),
  });
  if (!isRecord(data) || !Array.isArray(data.content) || !isRecord(data.content[0]) || typeof data.content[0].text !== 'string' || !data.content[0].text.trim()) {
    throw new Error('Empty or malformed response from Anthropic');
  }
  const content = data.content[0].text;
  const usage = isRecord(data.usage) ? data.usage : {};
  return { content, inputTokens: tokenCount(usage.input_tokens, inputText), outputTokens: tokenCount(usage.output_tokens, content) };
}

async function completeOpenAI(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = config.apiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const inputText = messages.map(m => m.content).join('');
  const data = await fetchJSON(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: MAX_TOKENS }),
  });
  if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0]) || !isRecord(data.choices[0].message) ||
    typeof data.choices[0].message.content !== 'string' || !data.choices[0].message.content.trim()) {
    throw new Error('Empty or malformed response from LLM');
  }
  const content = data.choices[0].message.content;
  const usage = isRecord(data.usage) ? data.usage : {};
  return { content, inputTokens: tokenCount(usage.prompt_tokens, inputText), outputTokens: tokenCount(usage.completion_tokens, content) };
}

export async function complete(config: LLMConfig, messages: Message[]): Promise<string> {
  return (await completeWithUsage(config, messages)).content;
}

export async function completeWithUsage(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  if (!config.baseUrl && config.model === 'gemini-nano') return completeChromeAI(messages);
  if (new URL(config.baseUrl).hostname === 'api.anthropic.com') return completeAnthropic(config, messages);
  return completeOpenAI(config, messages);
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = normalizeBaseUrl(baseUrl).replace(/\/v1$/, '');
  const data = await fetchJSON(`${base}/api/tags`, { method: 'GET' }, 5000);
  if (!isRecord(data) || !Array.isArray(data.models)) throw new Error('Could not read Ollama models');
  return data.models.flatMap((m: unknown) => isRecord(m) && typeof m.name === 'string' ? [m.name] : isRecord(m) && typeof m.model === 'string' ? [m.model] : []);
}

export async function evaluateChoices(
  config: LLMConfig & { provider?: string },
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
): Promise<{ answers: Map<string, ChoiceAnswer>; inputTokens: number; outputTokens: number }> {
  const endpoint = classificationEndpoint(config);
  if (!endpoint) throw new Error('Choose Jev or an OpenRouter Jev model in Settings.');
  const body = JSON.stringify({ model: config.model.trim(), state, questions });
  const data = await fetchJSON(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey.trim()}` },
    body,
  });
  if (!isRecord(data) || !isRecord(data.answers) || Object.keys(data.answers).length !== Object.keys(questions).length) {
    throw new Error('Incomplete or malformed response from Jev.');
  }
  const answers = new Map<string, ChoiceAnswer>();
  for (const [id, question] of Object.entries(questions)) {
    const answer = data.answers[id];
    if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' ||
      !Object.hasOwn(question.criteria, answer.choice) || typeof answer.confidence !== 'number' ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
      throw new Error('Invalid category or confidence in Jev response.');
    }
    answers.set(id, { choice: answer.choice, confidence: answer.confidence });
  }
  const usage = isRecord(data.usage) ? data.usage : {};
  return { answers, inputTokens: tokenCount(usage.input_tokens, body), outputTokens: tokenCount(usage.output_tokens, '') };
}

export async function testConnection(config: LLMConfig & { provider?: string }): Promise<string> {
  if (classificationEndpoint(config)) {
    await evaluateChoices(config, 'A browser tab showing a programming tutorial.', {
      category: { type: 'choice', instructions: 'What is this tab about?', criteria: { development: 'Programming', other: 'Other topics' } },
    });
    return 'OK';
  }
  return (await completeWithUsage(config, [{ role: 'user', content: 'Reply with exactly: OK' }])).content;
}
