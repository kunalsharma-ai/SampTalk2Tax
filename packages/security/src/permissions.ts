export const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'] as const;
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
  /** Create and submit one's own expense claims. */
  'expenses.submit',
  /** See everyone's expense claims. Claimants always see their own. */
  'expenses.read',
  /** Pay approved claims back from a bank account. */
  'expenses.reimburse',
  /** See employees, salaries and payslips. Salaries are sensitive, so viewers do not get it. */
  'payroll.read',
  /** Add employees, change salaries and prepare pay runs. Posting also needs journals.post. */
  'payroll.manage',
  /** Prepare budget versions and submit them. Approving one needs approvals.decide. */
  'budgets.manage',
  /** Acknowledge and dismiss alerts, run the checks, and change their settings. Everyone who reads reports sees alerts. */
  'alerts.manage',
  /** Ask the AI copilot questions about the books. It only reads; it never changes anything. */
  'copilot.use',
  /** Set up workflow automations (and their webhooks), see every task and retry failed deliveries. */
  'workflows.manage',
  /** See and work on tasks given to oneself or one's role, and give tasks to others. */
  'tasks.use',
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
  'expenses.read',
  'copilot.use',
  'tasks.use',
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
    'expenses.submit',
    'expenses.reimburse',
    'payroll.read',
    'payroll.manage',
    'budgets.manage',
    'alerts.manage',
  ]),
  APPROVER: new Set<Permission>([...READ_ONLY, 'journals.post', 'audit.read', 'approvals.decide', 'expenses.submit']),
  VIEWER: new Set<Permission>(READ_ONLY),
  /** Staff who only claim expenses: their own claims and the organisation's name, nothing else. */
  EMPLOYEE: new Set<Permission>(['org.read', 'expenses.submit']),
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
