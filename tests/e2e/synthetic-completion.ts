export type WireMessage = { role: string; content: unknown; tool_call_id?: string };
export type WireRequest = { model: string; messages: WireMessage[]; tools?: { function?: { name?: string } }[] };

export function completion(model: string, deltas: object[], finish: string) {
  const data = (delta: object, finish_reason: string | null) => JSON.stringify({
    id: 'chatcmpl-oep-native-contract', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  return new Response(deltas.map((delta) => `data: ${data(delta, null)}\n\n`).join('') +
    `data: ${data({}, finish)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

export function toolCall(index: number, id: string, name: string, params: object) {
  const args = JSON.stringify(params);
  const split = Math.floor(args.length / 2);
  return [
    { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args.slice(0, split) } }] },
    { tool_calls: [{ index, function: { arguments: args.slice(split) } }] },
  ];
}
