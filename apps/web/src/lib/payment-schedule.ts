import type { PayableBill } from './payment-batches';

export interface BillPlan {
  payDate: string;
  amount: string;
  partial: boolean;
  note: string | null;
  timing: 'OVERDUE' | 'LATE' | 'ON_TIME';
  late: boolean;
  missed: boolean;
  by: string;
  at: string;
}

export interface ScheduledBill extends Omit<PayableBill, 'dueDate'> {
  dueDate: string;
  plan: BillPlan | null;
  suggested: string;
  overdue: boolean;
}

export interface ScheduleWeek {
  week: string;
  payments: number;
  amount: string;
  balanceAfter: string;
  short: boolean;
}

export interface PaymentSchedule {
  today: string;
  currency: string;
  bills: ScheduledBill[];
  cash: { total: string; accounts: { id: string; code: string; name: string; balance: string }[] };
  weeks: ScheduleWeek[];
  totals: { open: string; planned: string; unplanned: number; overdueUnplanned: number; late: number; missed: number };
  can: { plan: boolean; prepareBatch: boolean };
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
