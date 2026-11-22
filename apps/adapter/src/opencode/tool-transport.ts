export const transportField = '_oep_transport_token';
export const nonceMarker = (nonce: string) => `\n[OEP policy_nonce: ${nonce}]`;
export const ticketPattern = /^oep-ticket-[a-f0-9]{64}$/;

export function stripTransportText(value: string) {
  return value.replace(/\n?\[OEP policy_nonce: [a-f0-9]{64}\]/gi, '')
    .replace(/oep-ticket-[a-f0-9]{64}/gi, '[redacted]')
    .replaceAll(transportField, '[redacted]');
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function stripTransport(value: unknown): unknown {
  if (typeof value === 'string') return stripTransportText(value);
  if (Array.isArray(value)) return value.map(stripTransport);
  const object = objectRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).flatMap(([key, item]) => {
    if (key === transportField) return [];
    if (key === 'required' && Array.isArray(item)) return [[key, stripTransport(item.filter((entry) => entry !== transportField))]];
    if (key === 'arguments' && typeof item === 'string') {
      try {
        const parsed = JSON.parse(item);
        const clean = JSON.stringify(stripTransport(parsed));
        return [[key, clean === JSON.stringify(parsed) ? item : clean]];
      } catch { return [[key, stripTransportText(item)]]; }
    }
    return [[stripTransportText(key), stripTransport(item)]];
  }));
}

export function containsTransport(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(transportField) || stripTransportText(value) !== value;
  if (Array.isArray(value)) return value.some(containsTransport);
  return Object.entries(objectRecord(value) ?? {}).some(([key, item]) => containsTransport(key) || containsTransport(item));
}
