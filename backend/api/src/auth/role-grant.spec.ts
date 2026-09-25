import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  type AuthenticatedUser,
} from '@digisoft/shared';
import { AppError } from '../common/errors/app-error';
import { assertCanGrantPermissions, assertCanGrantRoles, type GrantableRole } from './role-grant';

const actor = (permissions: string[]): AuthenticatedUser => ({
  id: 'u1',
  organizationId: 'o1',
  email: 'a@example.test',
  firstName: 'A',
  lastName: 'B',
  type: 'AGENT',
  roles: [],
  permissions,
  departmentIds: [],
  contactId: null,
});

const role = (name: string, keys: readonly string[]): GrantableRole => ({
  name,
  permissions: keys.map((key) => ({ permission: { key } })),
});

describe('role grant check', () => {
  const superAdmin = actor([...ALL_PERMISSIONS]);
  const admin = actor([...SYSTEM_ROLE_PERMISSIONS.ADMIN]);
  const agent = actor([...SYSTEM_ROLE_PERMISSIONS.AGENT]);

  it('lets a holder of every permission grant anything', () => {
    expect(() =>
      assertCanGrantRoles(superAdmin, [role('SUPER_ADMIN', ALL_PERMISSIONS)]),
    ).not.toThrow();
  });

  it('stops an admin from minting a super admin', () => {
    expect(() => assertCanGrantRoles(admin, [role('SUPER_ADMIN', ALL_PERMISSIONS)])).toThrow(
      AppError,
    );
  });

  it('allows granting a subset of your own permissions', () => {
    expect(() =>
      assertCanGrantRoles(admin, [role('AGENT', SYSTEM_ROLE_PERMISSIONS.AGENT)]),
    ).not.toThrow();
  });

  it('names the permissions the caller lacks', () => {
    expect(() => assertCanGrantPermissions(agent, [PERMISSIONS.ROLE_MANAGE])).toThrow(
      /role\.manage/,
    );
  });

  it('judges by permissions, not by role name', () => {
    // A custom role called SUPER_ADMIN carrying only agent permissions is harmless.
    expect(() =>
      assertCanGrantRoles(agent, [role('SUPER_ADMIN', SYSTEM_ROLE_PERMISSIONS.AGENT)]),
    ).not.toThrow();
  });
});
