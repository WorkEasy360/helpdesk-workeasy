import type { BackgroundGate } from '@digisoft/workeasy360';

/**
 * What the processors need to know before they produce a business effect: has the
 * organization's Workeasy360 access ended? See BackgroundGate (packages/workeasy360) for the
 * rules, and docs/workeasy360-sso.md for which job belongs to which class.
 */
export type AccessGate = Pick<BackgroundGate, 'allows' | 'sweep' | 'deniedOrganizations'>;

/** A gate that allows everything: Workeasy360 is not configured. */
export const OPEN_GATE: AccessGate = {
  allows: async () => true,
  sweep: () => async () => true,
  deniedOrganizations: () => [],
};
