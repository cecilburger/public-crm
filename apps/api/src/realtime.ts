import { EventEmitter } from 'node:events';

/**
 * The only thing a console needs to know: something in this conversation
 * changed, go refetch it. Carrying the actual message would mean re-deriving
 * decryption, autopilot drafts and formatting on the client — the same work
 * the server component already does on every navigation — for a channel that
 * exists purely to avoid polling.
 */
export interface RealtimeMessageEvent {
  type: 'message';
  conversationId: string;
}

export type RealtimeEvent = RealtimeMessageEvent;

/**
 * Fan-out for one API process. `publish` is called directly by whatever is
 * in the same process (dev-stack's inline worker); a deployed instance also
 * feeds it from a Redis subscription (see `server.ts`) so an event published
 * by the separate worker process reaches every replica's own connections.
 */
export interface RealtimeHub {
  publish(tenantId: string, event: RealtimeEvent): void;
  subscribe(tenantId: string, handler: (event: RealtimeEvent) => void): () => void;
}

export function createRealtimeHub(): RealtimeHub {
  const bus = new EventEmitter();
  // One listener per open console connection — routinely more than Node's
  // default warning threshold of 10 on a busy tenant.
  bus.setMaxListeners(0);

  return {
    publish(tenantId, event) {
      bus.emit(tenantId, event);
    },
    subscribe(tenantId, handler) {
      bus.on(tenantId, handler);
      return () => bus.off(tenantId, handler);
    },
  };
}
