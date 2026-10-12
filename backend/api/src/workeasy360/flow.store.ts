import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Time allowed at Workeasy360 (sign-in, second factor, organization choice) before the flow is abandoned. */
export const FLOW_TTL_SECONDS = 600;

export interface PendingFlow {
  state: string;
  nonce: string;
  verifier: string;
  /** The Workeasy360 organization the launcher named, or ''. */
  organization: string;
  /** Validated same-site path to land on. */
  next: string;
  /** Epoch milliseconds when the flow started. */
  at: number;
}

const keyFor = (flowId: string): string =>
  `w360:flow:${createHash('sha256').update(flowId).digest('hex')}`;

/**
 * Pending sign-ins, kept server-side and single use. The browser holds only a random flow id
 * in an httpOnly cookie; the state, nonce and PKCE verifier never leave the server, and the
 * record is addressed by a hash of the id. A callback consumes it with GETDEL first, whatever
 * happens next, so a flow is good for exactly one callback.
 */
export class FlowStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  newFlowId(): string {
    return randomBytes(32).toString('base64url');
  }

  async save(flowId: string, flow: Omit<PendingFlow, 'at'>): Promise<void> {
    const record: PendingFlow = { ...flow, at: this.now() };
    await this.redis.set(keyFor(flowId), JSON.stringify(record), 'EX', FLOW_TTL_SECONDS);
  }

  /** Atomically removes and returns the flow; null when unknown, already used, or too old. */
  async consume(flowId: string): Promise<PendingFlow | null> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(flowId)) return null;
    const raw = await this.redis.getdel(keyFor(flowId));
    if (!raw) return null;
    try {
      const flow = JSON.parse(raw) as PendingFlow;
      if (this.now() - flow.at >= FLOW_TTL_SECONDS * 1000) return null;
      return flow;
    } catch {
      return null;
    }
  }
}
