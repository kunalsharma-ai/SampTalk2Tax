import { Logger } from '@nestjs/common';
import type { PrismaService, Tx } from './prisma.service';

/**
 * Some changes are made straight on a collection (a session, a user) and then recorded in a
 * transaction (the audit trail). If the record cannot be written, `undo` reverses the change, so
 * nothing is kept that was not recorded.
 */
export async function thenOrUndo<T>(result: T, record: () => Promise<void>, undo: () => Promise<void>): Promise<T> {
  try {
    await record();
    return result;
  } catch (e) {
    try {
      await undo();
    } catch (undoError) {
      new Logger('Undo').error(`Could not undo a change after its record was refused: ${String(undoError)}`);
    }
    throw e;
  }
}

/**
 * A transaction that also makes changes straight on collections part-way through (a period's
 * status, while its lock is held). Each such change registers how to reverse it with `undoLater`;
 * if the transaction fails, the reversals run, newest first.
 */
export async function transactionWithUndo<T>(
  prisma: PrismaService,
  fn: (tx: Tx, undoLater: (undo: () => Promise<unknown>) => void) => Promise<T>,
  opts?: { timeout?: number },
): Promise<T> {
  const undos: (() => Promise<unknown>)[] = [];
  try {
    return await prisma.$transaction((tx) => fn(tx, (u) => void undos.push(u)), opts);
  } catch (e) {
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch (undoError) {
        new Logger('Undo').error(`Could not undo a change after its transaction failed: ${String(undoError)}`);
      }
    }
    throw e;
  }
}
