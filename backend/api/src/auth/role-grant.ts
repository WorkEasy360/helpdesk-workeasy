import { ALL_PERMISSIONS, type AuthenticatedUser } from '@digisoft/shared';
import { AppError } from '../common/errors/app-error';

export interface GrantableRole {
  name: string;
  permissions: { permission: { key: string } }[];
}

/**
 * Nobody may hand out more access than they hold. Assigning a role to a user, binding
 * one to an API key, or editing which permissions a role carries is allowed only when
 * every permission involved is already one of the caller's own effective permissions.
 * A holder of every permission (the Super Admin role) can therefore grant anything,
 * while an Admin — who lacks organization.update — cannot mint a Super Admin.
 *
 * Checked against the caller's resolved permission set rather than role names, since a
 * custom role can be named anything.
 */
export function assertCanGrantPermissions(actor: AuthenticatedUser, keys: Iterable<string>): void {
  const held = new Set(actor.permissions);
  if (ALL_PERMISSIONS.every((permission) => held.has(permission))) {
    return;
  }
  const missing = [...new Set(keys)].filter((key) => !held.has(key));
  if (missing.length > 0) {
    throw AppError.forbidden(
      `You cannot grant permissions you do not hold: ${missing.sort().join(', ')}`,
      'PERMISSION_DENIED',
    );
  }
}

export function assertCanGrantRoles(actor: AuthenticatedUser, roles: GrantableRole[]): void {
  assertCanGrantPermissions(
    actor,
    roles.flatMap((role) => role.permissions.map((link) => link.permission.key)),
  );
}
