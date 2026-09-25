'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

import { SOCKET_URL } from '@/lib/env';

const TICKET_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.assigned',
  'ticket.status_changed',
  'message.created',
] as const;

/**
 * Keeps the workspace live. The server only sends events for tickets this user may
 * read, and each event invalidates the matching queries rather than patching caches by
 * hand — the API stays the single source of truth.
 */
export function useRealtime(): void {
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);

  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }
    if (!getAccessToken()) {
      return;
    }

    // The callback form is re-evaluated on every (re)connection attempt, so a socket
    // always presents the latest access token rather than the one it was opened with.
    const socket: Socket = io(`${SOCKET_URL}/rt`, {
      auth: (cb) => cb({ token: getAccessToken() }),
      transports: ['websocket'],
      withCredentials: true,
    });

    // The server drops a socket when its access token expires — announcing it with
    // `session.expired` first — and refuses handshakes with a stale token. Socket.IO does
    // not reconnect after a server-side disconnect or rejection on its own, so refresh
    // the agent token through the same path the HTTP client uses and reconnect. Bounded
    // and backed off, so a revoked session cannot spin in a loop: when the refresh fails
    // the socket stays down and the next API call's 401 signs the user out as usual.
    let closed = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    const reconnectWithFreshToken = () => {
      // `session.expired` and the disconnect that follows it ask for the same retry.
      if (closed || retryTimer !== undefined || attempts >= 3) {
        return;
      }
      attempts += 1;
      const delay = 500 * 2 ** (attempts - 1);
      retryTimer = setTimeout(() => {
        void refreshAccessToken({ portalSlug: null }).then((fresh) => {
          retryTimer = undefined;
          if (fresh && !closed && !socket.connected) {
            socket.connect();
          }
        });
      }, delay);
    };

    // The server also accepts and then immediately drops a socket it will not serve (a
    // foreign origin, an unresolvable user), so the budget is only restored once a
    // connection has actually held.
    socket.on('connect', () => {
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        attempts = 0;
      }, 10_000);
    });
    socket.on('session.expired', reconnectWithFreshToken);
    socket.on('connect_error', () => {
      // `active` is false when the server (auth middleware) rejected the handshake;
      // transport-level failures keep retrying on socket.io's own backoff.
      if (!socket.active) {
        reconnectWithFreshToken();
      }
    });
    socket.on('disconnect', (reason) => {
      clearTimeout(stableTimer);
      if (reason === 'io server disconnect') {
        reconnectWithFreshToken();
      }
    });

    for (const event of TICKET_EVENTS) {
      socket.on(event, (payload: { id?: string; ticketId?: string }) => {
        const ticketId = payload?.ticketId ?? payload?.id;
        void queryClient.invalidateQueries({ queryKey: ['tickets'] });
        if (ticketId) {
          void queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
        }
      });
    }

    socket.on('notification.created', () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    socket.on('chat.started', () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    });

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      socket.close();
    };
  }, [status, queryClient]);
}
