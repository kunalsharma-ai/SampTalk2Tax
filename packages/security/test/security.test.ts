import { describe, expect, it } from 'vitest';
import { canAssignRole, hasPermission, hashPassword, passwordPolicyErrors, verifyPassword } from '../src';

describe('permissions', () => {
  it('gives viewers read-only access', () => {
    expect(hasPermission('VIEWER', 'reports.read')).toBe(true);
    expect(hasPermission('VIEWER', 'journals.post')).toBe(false);
    expect(hasPermission('VIEWER', 'accounts.manage')).toBe(false);
  });
  it('only lets owners and admins lock periods or manage members', () => {
    expect(hasPermission('ACCOUNTANT', 'periods.lock')).toBe(false);
    expect(hasPermission('ADMIN', 'periods.lock')).toBe(true);
    expect(hasPermission('APPROVER', 'members.manage')).toBe(false);
  });
  it('lets accountants prepare sales and purchases, approvers only post, viewers only read', () => {
    expect(hasPermission('ACCOUNTANT', 'sales.manage')).toBe(true);
    expect(hasPermission('ACCOUNTANT', 'purchases.manage')).toBe(true);
    expect(hasPermission('APPROVER', 'sales.manage')).toBe(false);
    expect(hasPermission('APPROVER', 'journals.post')).toBe(true);
    expect(hasPermission('VIEWER', 'sales.read')).toBe(true);
    expect(hasPermission('VIEWER', 'contacts.manage')).toBe(false);
  });
  it('lets accountants match and reconcile bank lines, everyone else only read them', () => {
    expect(hasPermission('ACCOUNTANT', 'banking.manage')).toBe(true);
    expect(hasPermission('ACCOUNTANT', 'banking.reconcile')).toBe(true);
    expect(hasPermission('APPROVER', 'banking.manage')).toBe(false);
    expect(hasPermission('VIEWER', 'banking.read')).toBe(true);
    expect(hasPermission('VIEWER', 'banking.reconcile')).toBe(false);
  });
  it('lets approvers, owners and admins decide approvals, but not accountants', () => {
    expect(hasPermission('APPROVER', 'approvals.decide')).toBe(true);
    expect(hasPermission('OWNER', 'approvals.decide')).toBe(true);
    expect(hasPermission('ACCOUNTANT', 'approvals.decide')).toBe(false);
    expect(hasPermission('VIEWER', 'approvals.decide')).toBe(false);
  });
  it('lets employees claim expenses and nothing else', () => {
    expect(hasPermission('EMPLOYEE', 'expenses.submit')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'expenses.read')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'reports.read')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'accounts.read')).toBe(false);
    expect(hasPermission('ACCOUNTANT', 'expenses.reimburse')).toBe(true);
    expect(hasPermission('APPROVER', 'expenses.reimburse')).toBe(false);
    expect(hasPermission('VIEWER', 'expenses.submit')).toBe(false);
  });
  it('keeps salaries from viewers, approvers and employees', () => {
    expect(hasPermission('ACCOUNTANT', 'payroll.manage')).toBe(true);
    expect(hasPermission('ADMIN', 'payroll.read')).toBe(true);
    expect(hasPermission('VIEWER', 'payroll.read')).toBe(false);
    expect(hasPermission('APPROVER', 'payroll.read')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'payroll.read')).toBe(false);
  });
  it('leaves automations to owners and admins, and gives tasks to everyone but employees', () => {
    expect(hasPermission('OWNER', 'workflows.manage')).toBe(true);
    expect(hasPermission('ADMIN', 'workflows.manage')).toBe(true);
    expect(hasPermission('ACCOUNTANT', 'workflows.manage')).toBe(false);
    expect(hasPermission('VIEWER', 'workflows.manage')).toBe(false);
    for (const role of ['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'] as const) expect(hasPermission(role, 'tasks.use')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'tasks.use')).toBe(false);
  });
  it('restricts role assignment', () => {
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ACCOUNTANT')).toBe(true);
    expect(canAssignRole('ACCOUNTANT', 'VIEWER')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same password 123')).not.toBe(await hashPassword('same password 123'));
  });
  it('enforces a minimum length', () => {
    expect(passwordPolicyErrors('short')).toHaveLength(1);
    expect(passwordPolicyErrors('long enough password')).toHaveLength(0);
  });
});
