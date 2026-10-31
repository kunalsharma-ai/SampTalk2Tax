import { assertIsoDate } from '@talk2tax/accounting-engine';

export function toDbDate(iso: string): Date {
  assertIsoDate(iso);
  return new Date(`${iso}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
