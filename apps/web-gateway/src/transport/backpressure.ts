import { Buffer } from 'node:buffer';
import type { ManagedConnection } from './connection-registry.ts';
import { serializeServerMessage, type ServerMessage } from './ws-protocol.ts';

export const DEFAULT_BUFFER_HIGH_WATER_MARK = 1_048_576;

function createOverflowMessage(conversationId?: string): ServerMessage {
  return {
    type: 'error',
    ok: false as const,
    code: 'WS_BUFFER_OVERFLOW',
    category: 'daemon',
    message: 'WebSocket send buffer exceeded the configured backpressure limit',
    ...(conversationId !== undefined && { conversationId }),
  };
}

export function wouldOverflowConnectionBuffer(
  connection: ManagedConnection,
  message: ServerMessage,
  highWaterMark: number,
): boolean {
  const serialized = serializeServerMessage(message);
  return (
    connection.bufferedAmount > highWaterMark ||
    connection.bufferedAmount + Buffer.byteLength(serialized, 'utf8') > highWaterMark
  );
}

export function sendWithBackpressureProtection(
  connection: ManagedConnection,
  message: ServerMessage,
  highWaterMark: number,
): boolean {
  if (connection.isClosed) {
    return false;
  }

  if (!wouldOverflowConnectionBuffer(connection, message, highWaterMark)) {
    connection.send(message);
    return true;
  }

  const conversationId = message.type === 'stream-event' ? message.conversationId : undefined;
  connection.send(createOverflowMessage(conversationId));
  connection.close(1008, 'WS_BUFFER_OVERFLOW');
  return false;
}
