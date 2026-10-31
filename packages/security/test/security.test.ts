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
