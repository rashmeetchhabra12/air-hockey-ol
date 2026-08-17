/**
 * Matchmaking protocol.
 *
 * Deliberately plain JSON rather than the binary codec. The binary format earns
 * its complexity on the snapshot stream — twenty messages a second, forever.
 * Matchmaking is a handful of messages per player per session, so the bytes do
 * not matter and legibility does.
 */

export type LobbyClientMessage =
  /** Join the queue. */
  | { t: 'find' }
  /** Leave the queue without disconnecting. */
  | { t: 'cancel' };

export type LobbyServerMessage =
  /** Waiting for an opponent. `ahead` is how many are queued in front. */
  | { t: 'queued'; ahead: number }
  /** Paired. Both sides receive the same room name and connect to it directly. */
  | { t: 'matched'; room: string; opponent: string }
  /** Removed from the queue at the client's request. */
  | { t: 'cancelled' };

export function encodeLobbyClient(msg: LobbyClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeLobbyClient(data: unknown): LobbyClientMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const t = (parsed as { t?: unknown }).t;
    return t === 'find' || t === 'cancel' ? ({ t } as LobbyClientMessage) : null;
  } catch {
    return null;
  }
}

export function encodeLobbyServer(msg: LobbyServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeLobbyServer(data: unknown): LobbyServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;

    if (o['t'] === 'queued' && typeof o['ahead'] === 'number') {
      return { t: 'queued', ahead: o['ahead'] };
    }
    if (o['t'] === 'matched' && typeof o['room'] === 'string' && typeof o['opponent'] === 'string') {
      return { t: 'matched', room: o['room'], opponent: o['opponent'] };
    }
    if (o['t'] === 'cancelled') return { t: 'cancelled' };
    return null;
  } catch {
    return null;
  }
}
