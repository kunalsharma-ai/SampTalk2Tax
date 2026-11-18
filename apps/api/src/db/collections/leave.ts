import { defineCollection } from '@talk2tax/document-db';

/**
 * Leave (PAY-011). A leave type says whether it is paid and how many days an employee
 * gets each April-March year. Leave is recorded per employee and month: paid leave comes
 * out of the year's balance; unpaid leave becomes loss-of-pay days on that month's payslip.
 */
export interface LeaveTypeDoc {
  id: string;
  orgId: string;
  /** Short code, unique per organisation (EL, SL, LWP). */
  code: string;
  name: string;
  paid: boolean;
  /** Days a year for paid leave, in half days; 0 for unpaid leave. */
  annualDays: string;
  active: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const leaveTypes = defineCollection<LeaveTypeDoc>({
  name: 'leave_types',
  scope: 'tenant',
  decimals: ['annualDays'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'code', 'name', 'paid', 'annualDays', 'active', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      code: { bsonType: 'string', pattern: '^[A-Z0-9]{1,10}$' },
      name: { bsonType: 'string', minLength: 1, maxLength: 100 },
      paid: { bsonType: 'bool' },
      active: { bsonType: 'bool' },
    },
  },
  indexes: [{ key: { orgId: 1, code: 1 }, name: 'org_code', unique: true }],
});

export interface LeaveEntryDoc {
  id: string;
  orgId: string;
  employeeId: string;
  leaveTypeId: string;
  /** Copied from the type when recorded, so later changes to the type do not rewrite history. */
  paid: boolean;
  /** YYYY-MM: the month the leave falls in (from and to are in it). */
  period: string;
  from: Date;
  to: Date;
  /** Days of leave, in half days, at most the calendar days from `from` to `to`. */
  days: string;
  reason: string | null;
  status: 'RECORDED' | 'CANCELLED';
  createdById: string;
  createdAt: Date;
  cancelledById: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

export const leaveEntries = defineCollection<LeaveEntryDoc>({
  name: 'leave_entries',
  scope: 'tenant',
  decimals: ['days'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'employeeId', 'leaveTypeId', 'paid', 'period', 'from', 'to', 'days', 'reason', 'status', 'createdById', 'createdAt', 'cancelledById', 'cancelledAt', 'cancelReason'],
    properties: {
      period: { bsonType: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
      from: { bsonType: 'date' },
      to: { bsonType: 'date' },
      status: { enum: ['RECORDED', 'CANCELLED'] },
      paid: { bsonType: 'bool' },
    },
  },
  indexes: [
    { key: { orgId: 1, employeeId: 1, period: 1 }, name: 'org_employee_period' },
    { key: { orgId: 1, period: 1 }, name: 'org_period' },
  ],
});
