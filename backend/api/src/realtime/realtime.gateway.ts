import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PERMISSIONS } from '@digisoft/shared';
import { TokenService } from '../auth/token.service';
import { AccessControlService } from '../auth/access-control.service';
import { AppConfig } from '../config/config.module';
import { SessionAccessService } from '../workeasy360/session-access.service';

export const RT_EVENTS = {
  NOTIFICATION_CREATED: 'notification.created',
  AGENT_ONLINE: 'agent.online',
  AGENT_OFFLINE: 'agent.offline',
  /** Sent just before the server drops a socket whose access token has expired. */
  SESSION_EXPIRED: 'session.expired',
  /**
   * Sent just before the server drops a socket whose person no longer has access
   * (`{ code, reason? }`: WORKEASY360_ACCESS_ENDED, _ACCESS_UNVERIFIED or _SIGN_IN_REQUIRED).
   */
  ACCESS_ENDED: 'access.ended',
} as const;

/** setTimeout's ceiling; a longer-lived token is simply re-checked by reconnecting sooner. */
const MAX_TIMER_MS = 2_147_483_647;

interface SocketIdentity {
  userId: string;
  organizationId: string;
}

export interface TicketAudienceRooms {
  departmentId: string | null;
  assignedAgentId: string | null;
}

/**
 * Authenticated realtime channel. Every socket joins only its own organization and
 * user rooms, so a broadcast can never cross a tenant boundary.
 *
 * A socket lives no longer than the access token it connected with: it is dropped when
 * the token expires, so revoked access or changed permissions cannot outlive the token
 * on an open connection. The client reconnects with a fresh token.
 *
 * Only agents connect (a customer's token is refused), and Workeasy360 access is part of
 * the handshake and re-checked on a timer (REALTIME_ACCESS_RECHECK_SECONDS, default 60 s)
 * through the same cached decision HTTP requests use, so it costs no extra question: a
 * person whose access ended is disconnected within one re-check even though `/auth/refresh`
 * keeps minting tokens for them (so they can reach the access-ended screen and sign out).
 */
@WebSocketGateway({ namespace: '/rt' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly accessControl: AccessControlService,
    private readonly config: AppConfig,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Transport CORS is open for the chat widget (see RedisIoAdapter); the agent app is
    // only ever served from FRONTEND_URL, so a browser handshake from anywhere else is
    // refused. Non-browser clients send no Origin.
    const origin = client.handshake.headers.origin;
    if (origin && origin !== new URL(this.config.get('FRONTEND_URL')).origin) {
      client.disconnect(true);
      return;
    }

    const token =
      (client.handshake.auth as { token?: string } | undefined)?.token ??
      (typeof client.handshake.query.token === 'string' ? client.handshake.query.token : undefined);

    if (!token) {
      client.disconnect(true);
      return;
    }

    const result = this.tokens.verifyAccessToken(token);
    if (!result.ok) {
      client.disconnect(true);
      return;
    }

    const identity: SocketIdentity = {
      userId: result.payload.sub,
      organizationId: result.payload.org,
    };
    client.data.identity = identity;

    const w360 = result.payload.w360;
    const exp = (result.payload as { exp?: number }).exp;
    if (exp) {
      const expiry = setTimeout(
        () => {
          client.emit(RT_EVENTS.SESSION_EXPIRED, {});
          client.disconnect(true);
        },
        Math.min(Math.max(exp * 1000 - Date.now(), 0), MAX_TIMER_MS),
      );
      client.data.expiry = expiry;
    }

    // Room membership mirrors the API's read scope, so a socket can only ever be sent
    // events for tickets its user is allowed to open.
    let user;
    try {
      user = await this.accessControl.resolveUser(result.payload);
    } catch {
      client.disconnect(true);
      return;
    }

    if (user.type !== 'AGENT') {
      // The agent channel is for agents: a help center customer's token is not welcome here.
      client.disconnect(true);
      return;
    }
    try {
      if (!(await this.stillAllowed(client, w360))) {
        return;
      }
    } catch {
      client.disconnect(true);
      return;
    }
    const recheck = setInterval(() => {
      void this.stillAllowed(client, w360).catch(() => undefined);
    }, this.config.get('REALTIME_ACCESS_RECHECK_SECONDS') * 1000);
    recheck.unref();
    client.data.recheck = recheck;

    const rooms = [
      orgRoom(identity.organizationId),
      userRoom(identity.organizationId, identity.userId),
      ...user.departmentIds.map((departmentId) =>
        departmentRoom(identity.organizationId, departmentId),
      ),
    ];
    if (user.permissions.includes(PERMISSIONS.TICKET_READ_ALL)) {
      rooms.push(allTicketsRoom(identity.organizationId));
    }

    if (client.disconnected) {
      return;
    }
    await client.join(rooms);
    this.server
      .to(orgRoom(identity.organizationId))
      .emit(RT_EVENTS.AGENT_ONLINE, { userId: identity.userId });
  }

  /**
   * Whether this socket's person may still receive events. A refusal tells the client why and
   * drops the socket; an outage of Workeasy360 is never a refusal (the cache keeps its last
   * answer), so only a known denial, a refusal of our own client or a missing sign-in ends it.
   */
  private async stillAllowed(client: Socket, w360: { org: string; sub?: string } | undefined): Promise<boolean> {
    const decision = await this.sessionAccess.evaluate({ kind: 'token', w360 });
    if (decision.ok) {
      return true;
    }
    client.emit(RT_EVENTS.ACCESS_ENDED, {
      code: decision.code,
      ...(decision.reason ? { reason: decision.reason } : {}),
    });
    client.disconnect(true);
    return false;
  }

  handleDisconnect(client: Socket): void {
    clearTimeout(client.data.expiry as NodeJS.Timeout | undefined);
    clearInterval(client.data.recheck as NodeJS.Timeout | undefined);
    const identity = client.data.identity as SocketIdentity | undefined;
    if (!identity) {
      return;
    }
    this.server
      .to(orgRoom(identity.organizationId))
      .emit(RT_EVENTS.AGENT_OFFLINE, { userId: identity.userId });
  }

  emitToUser(organizationId: string, userId: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(`Realtime server not ready; dropped ${event}`);
      return;
    }
    this.server.to(userRoom(organizationId, userId)).emit(event, payload);
  }

  /** Fans an event out to everyone entitled to see the ticket, and no one else. */
  emitToTicketAudience(
    organizationId: string,
    audience: TicketAudienceRooms,
    event: string,
    payload: unknown,
  ): void {
    if (!this.server) {
      this.logger.warn(`Realtime server not ready; dropped ${event}`);
      return;
    }
    const rooms = [allTicketsRoom(organizationId)];
    if (audience.departmentId) {
      rooms.push(departmentRoom(organizationId, audience.departmentId));
    }
    if (audience.assignedAgentId) {
      rooms.push(userRoom(organizationId, audience.assignedAgentId));
    }
    // Socket.IO de-duplicates a socket that belongs to more than one of these rooms.
    this.server.to(rooms).emit(event, payload);
  }

  emitToOrganization(organizationId: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(`Realtime server not ready; dropped ${event}`);
      return;
    }
    this.server.to(orgRoom(organizationId)).emit(event, payload);
  }
}

export const orgRoom = (organizationId: string): string => `org:${organizationId}`;
export const userRoom = (organizationId: string, userId: string): string =>
  `org:${organizationId}:user:${userId}`;
export const departmentRoom = (organizationId: string, departmentId: string): string =>
  `org:${organizationId}:dept:${departmentId}`;
/** Joined only by users who may read every ticket in the organization. */
export const allTicketsRoom = (organizationId: string): string =>
  `org:${organizationId}:tickets:all`;
