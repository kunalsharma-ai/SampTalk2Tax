export const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'] as const;
export type RoleName = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read',
  'org.manage',
  'members.read',
  'members.manage',
  'accounts.read',
  'accounts.manage',
  'periods.read',
  'periods.manage',
  'periods.lock',
  'journals.read',
  'journals.create',
  'journals.post',
  'journals.reverse',
  'reports.read',
  'audit.read',
  'contacts.read',
  'contacts.manage',
  'sales.read',
  'sales.manage',
  'purchases.read',
  'purchases.manage',
  'banking.read',
  'banking.manage',
  'banking.reconcile',
  'approvals.decide',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = [
  'org.read',
  'members.read',
  'accounts.read',
  'periods.read',
  'journals.read',
  'reports.read',
  'contacts.read',
  'sales.read',
  'purchases.read',
  'banking.read',
];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, ReadonlySet<Permission>>> = Object.freeze({
  OWNER: new Set<Permission>(PERMISSIONS),
  ADMIN: new Set<Permission>(PERMISSIONS),
  ACCOUNTANT: new Set<Permission>([
    ...READ_ONLY,
    'accounts.manage',
    'periods.manage',
    'journals.create',
    'journals.post',
    'journals.reverse',
    'audit.read',
    'contacts.manage',
    'sales.manage',
    'purchases.manage',
    'banking.manage',
    'banking.reconcile',
  ]),
  APPROVER: new Set<Permission>([...READ_ONLY, 'journals.post', 'audit.read', 'approvals.decide']),
  VIEWER: new Set<Permission>(READ_ONLY),
});

export function hasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Only owners can grant OWNER; admins can grant anything below OWNER. */
export function canAssignRole(actor: RoleName, target: RoleName): boolean {
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return target !== 'OWNER';
  return false;
}
