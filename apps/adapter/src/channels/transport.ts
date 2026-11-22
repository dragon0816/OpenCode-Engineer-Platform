export type Binding = { accountId: string; agentId: string; bindingRevision: number };
export type Destination = Binding & { conversationKey: string };
export type ChannelLocale = 'zh-TW' | 'en';
export type Lane = 'work' | 'command';

export type InboundEnvelope = {
  eventKey: string;
  conversationKey: string;
  receivedAt: number;
  lane: Lane;
} & ({ payload: object; reasonCode?: never } | { reasonCode: string; payload?: never });

export type OutboundMessage = Destination & { effectKey: string; locale: ChannelLocale; text: string };
export type Delivery =
  | { state: 'sent'; receipt?: string }
  | { state: 'pending'; retryAt: number }
  | { state: 'indeterminate' | 'failed'; reasonCode: string };

export interface ChannelTransport {
  verifyAccount(signal: AbortSignal): Promise<{ identity: string; capabilities: readonly ('receive' | 'text' | 'attachment')[] }>;
  receive(checkpoint: string, signal: AbortSignal, clock: () => number): Promise<{
    events: InboundEnvelope[]; nextCheckpoint: string;
  }>;
  fetchAttachment(reference: string, limit: number, signal: AbortSignal): Promise<Uint8Array>;
  deliver(message: OutboundMessage, signal: AbortSignal, attempts: number, clock: () => number): Promise<Delivery>;
}
