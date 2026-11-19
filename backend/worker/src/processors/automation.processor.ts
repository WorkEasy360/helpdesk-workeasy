import type { Job } from 'bullmq';
import { runTrigger, type EngineDeps, type TriggerJob } from '@digisoft/engine';
import type { AccessGate } from '../access-gate';

/**
 * Evaluates automation and escalation rules for one ticket event.
 *
 * Class A (requires active access): rules change tickets, notify people and send messages,
 * so an organization whose Workeasy360 access ended is skipped - logged, not retried - and
 * the work resumes with the next event after renewal.
 */
export async function handleAutomation(job: Job<TriggerJob>, deps: EngineDeps, gate: AccessGate) {
  if (!(await gate.allows(job.data.organizationId, 'automation', { jobId: job.id, trigger: job.data.trigger }))) {
    return { evaluated: 0, fired: 0, skipped: true as const };
  }
  const result = await runTrigger(deps, job.data);
  deps.log('info', `Automation ${job.data.trigger} on ${job.data.ticketId}: ${result.fired}/${result.evaluated} fired`, {
    organizationId: job.data.organizationId,
  });
  return result;
}
