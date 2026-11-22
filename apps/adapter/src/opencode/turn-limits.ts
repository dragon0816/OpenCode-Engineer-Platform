import type { RelayScope } from './scoped-completion.ts';

export const turnLimitFields = {
  recentMessages: { min: 0, max: 100, initial: 40 },
  historyBytes: { min: 0, max: 1_048_576, initial: 262_144 },
  toolCalls: { min: 0, max: 100, initial: 24 },
  timeoutSeconds: { min: 5, max: 180, initial: 105 },
};

export type TurnLimits = Record<keyof typeof turnLimitFields, number>;
export const turnLimitDefaults = Object.fromEntries(
  Object.entries(turnLimitFields).map(([key, field]) => [key, field.initial]),
) as TurnLimits;

export function parseTurnLimits(input: Record<string, unknown>) {
  const fields = Object.entries(turnLimitFields);
  if (Object.keys(input).length !== fields.length || fields.some(([key, field]) => {
    const value = input[key];
    return typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.min || value > field.max;
  })) return;
  return input as TurnLimits;
}

export const turnMarker = (id: string) => `\n\n[OEP attachment and output instructions for ${id}]\n`;
type Message = { role?: string; content?: unknown };

function hasMarker(message: Message, marker: string): boolean {
  if (typeof message.content === 'string') return message.content.includes(marker.trim());
  return Array.isArray(message.content) && message.content.some((part) =>
    typeof part?.text === 'string' && part.text.includes(marker.trim()));
}

export function limitHistory(messages: Message[], marker: string, limits: TurnLimits) {
  const current = messages.findLastIndex((message) => message.role === 'user' && hasMarker(message, marker));
  if (current < 0) return;
  let start = current;
  let bytes = 0;
  while (start > 0) {
    let prior = start - 1;
    while (prior >= 0 && messages[prior].role !== 'user') prior--;
    if (prior < 0) break;
    const group = messages.slice(prior, start);
    bytes += Buffer.byteLength(JSON.stringify(group));
    if (current - prior > limits.recentMessages || bytes > limits.historyBytes) break;
    start = prior;
  }
  return messages.filter((message, index) => index >= start || message.role === 'system' || message.role === 'developer');
}

export function countModelTools(frames: unknown[]) {
  const calls = new Set<string>();
  type Call = { index?: number };
  type Choice = { index?: number; delta?: { tool_calls?: Call[] }; message?: { tool_calls?: Call[] } };
  for (const value of frames) {
    const frame = value as { choices?: Choice[] };
    for (const [choiceIndex, choice] of (frame.choices ?? []).entries()) {
      const tools = (choice.delta ?? choice.message)?.tool_calls ?? [];
      for (const [toolIndex, tool] of tools.entries()) calls.add(`${choice.index ?? choiceIndex}:${tool.index ?? toolIndex}`);
    }
  }
  return calls.size;
}

export type TurnBoundary = {
  marker: string;
  limits: TurnLimits;
  signal: AbortSignal;
  addTools: (count: number) => void;
  scope?: RelayScope;
};
