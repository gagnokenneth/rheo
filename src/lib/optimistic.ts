import type {
  Bill,
  BillPayable,
  Debt,
  DebtScheduleRow,
  DebtStatement,
  FinanceData,
  IncomeEntry,
  IncomeSource,
  SavingsLedgerEntry,
  SavingsMovementKind,
  SavingsRefType,
  Task,
  Note,
  NoteItem,
} from '../types.ts'
import type {
  BillPatch,
  BillPayablePatch,
  NewBill,
  NewDebt,
  NewScheduleRow,
  NewStatement,
  PayBillInput,
  ScheduleRowPatch,
  StatementPatch,
  NewIncome,
  IncomePatch,
  NewIncomeSource,
  IncomeSourcePatch,
  NewSavingsEntry,
  SavingsEntryPatch,
  NewTask,
  TaskPatch,
  MoveTaskInput,
  TaskColumnPatch,
  NewNote,
  NotePatch,
  NewNoteItem,
  NoteItemPatch,
} from '../api/FinanceApi.ts'
import { tempId } from './tempId.ts'
import { signedAmount } from './savings.ts'
import { nextSortOrder } from './notes.ts'
import { firstColumn } from './taskColumns.ts'

/**
 * Client-side predictions of what a write does to the dataset, used to show the
 * result before the backend confirms it.
 *
 * Every function here must produce exactly what the backend would return for the
 * same call — both backends, Code.gs and MockApi. A row the backend has not seen
 * yet carries a temp id (lib/tempId.ts); the response replaces it with the real
 * row, so nothing here needs to reconcile ids.
 *
 * Money is never invented: a figure the backend derives from other rows must be
 * derived the same way here, or the prediction is a lie that only shows up as a
 * flicker when the truth arrives.
 */

/**
 * Both backends drop the paid fields when a row goes back to unpaid — MockApi
 * via clearPaidFields, Code.gs by blanking them explicitly. A plain merge would
 * leave the old date and amount on the row until the server replied, which is
 * the sort of near-miss this file exists to avoid.
 */
function clearPaidWhenUnpaid<T extends DebtScheduleRow | DebtStatement | BillPayable>(row: T): T {
  if (row.paid) return row
  const next = { ...row }
  delete next.paid_date
  delete next.paid_amount
  return next
}

/*
 * The wire's null becomes the model's undefined. Every clearable field is
 * typed `T | null` on its patch because JSON.stringify drops undefined — see
 * StatementPatch — so each prediction has to undo that here.
 */
function clearNulls<T extends object>(patch: T, keys: readonly (keyof T)[]): T {
  const applied = { ...patch }
  for (const key of keys) {
    if (applied[key] === null) applied[key] = undefined as T[keyof T]
  }
  return applied
}

/** See StatementPatch. */
function clearedAmounts(patch: StatementPatch): Partial<DebtStatement> {
  return clearNulls(patch, ['min_due', 'total_due', 'outstanding']) as Partial<DebtStatement>
}

/**
 * The payable a new bill or a payment starts from — the mirror of newPayable in
 * both backends. A variable bill's payable has no figure yet: undefined means
 * "not set", which is not zero.
 */
function newPayable(bill: Pick<Bill, 'id' | 'type' | 'amount'>, dueDate: string): BillPayable {
  return {
    id: tempId(),
    bill_id: bill.id,
    due_date: dueDate,
    amount: bill.type === 'fixed' ? bill.amount : undefined,
    paid: false,
  }
}

/** The row settleFromSavings writes. Mirrors it in both backends. */
function savingsPaymentRow(
  refType: SavingsRefType,
  refId: number,
  paidDate: string,
  paidAmount: number,
): SavingsLedgerEntry {
  return {
    id: tempId(),
    date: paidDate,
    amount: -Math.abs(paidAmount),
    kind: refType === 'bill_payable' ? 'bill_payment' : 'debt_payment',
    ref_type: refType,
    ref_id: refId,
  }
}

/** The set-wise form, for a cascade that removes many settled rows at once. */
function withoutSavingsPaymentsFor(
  rows: SavingsLedgerEntry[],
  refType: SavingsRefType,
  refIds: number[],
): SavingsLedgerEntry[] {
  const dropped = new Set(refIds)
  return rows.filter((r) => !(r.ref_type === refType && r.ref_id !== undefined && dropped.has(r.ref_id)))
}

function withoutSavingsPayment(
  rows: SavingsLedgerEntry[],
  refType: SavingsRefType,
  refId: number,
): SavingsLedgerEntry[] {
  return rows.filter((r) => !(r.ref_type === refType && r.ref_id === refId))
}

/** Creates the bill and its first payable, as addBill does in one write. */
export function addBillTo(data: FinanceData, vars: NewBill): FinanceData {
  const { first_due_date, ...fields } = vars
  const bill: Bill = { id: tempId(), ...fields, closed: false }
  return {
    ...data,
    bills: [...data.bills, bill],
    bill_payables: [...data.bill_payables, newPayable(bill, first_due_date)],
  }
}

/**
 * Creates the debt and the rows it was given. Which table they land in follows
 * the debt's type, exactly as both backends split them. The rows themselves are
 * computed by the caller, so nothing here is server-derived but the ids.
 */
export function addDebtTo(data: FinanceData, vars: NewDebt): FinanceData {
  const debt: Debt = { id: tempId(), name: vars.name, type: vars.type }
  const withDebt = { ...data, debts: [...data.debts, debt] }
  // Mapped inside each branch so the row type stays narrowed to the table it
  // lands in — a statement must not be appendable to the schedule.
  return vars.type === 'fixed'
    ? {
        ...withDebt,
        debt_schedule: [
          ...data.debt_schedule,
          ...vars.rows.map((row) => ({ id: tempId(), debt_id: debt.id, ...row })),
        ],
      }
    : {
        ...withDebt,
        debt_statements: [
          ...data.debt_statements,
          ...vars.rows.map((row) => ({ id: tempId(), debt_id: debt.id, ...row })),
        ],
      }
}

export function addScheduleRowTo(
  data: FinanceData,
  vars: { debtId: number; input: NewScheduleRow },
): FinanceData {
  return {
    ...data,
    debt_schedule: [...data.debt_schedule, { id: tempId(), debt_id: vars.debtId, ...vars.input }],
  }
}

export function addStatementTo(
  data: FinanceData,
  vars: { debtId: number; input: NewStatement },
): FinanceData {
  return {
    ...data,
    debt_statements: [
      ...data.debt_statements,
      { id: tempId(), debt_id: vars.debtId, ...vars.input },
    ],
  }
}

/**
 * Marks the payable paid and mints the next one, as payBillPayable does in one
 * write. The successor is minted only when nothing else is outstanding, the same
 * guard both backends apply so a double-submitted Pay cannot leave two competing
 * upcoming rows.
 */
export function payBillPayableIn(
  data: FinanceData,
  vars: { id: number; input: PayBillInput },
): FinanceData {
  const row = data.bill_payables.find((r) => r.id === vars.id)
  if (!row) return data
  const bill = data.bills.find((b) => b.id === row.bill_id)
  if (!bill) return data

  const paid = data.bill_payables.map((r) =>
    r.id === vars.id
      ? { ...r, paid: true, paid_date: vars.input.paid_date, paid_amount: vars.input.paid_amount }
      : r,
  )
  // Computed over the patched rows, which is how both backends exclude the row
  // being paid from the guard.
  const stillUnpaid = paid.some((r) => r.bill_id === bill.id && !r.paid)
  return {
    ...data,
    bill_payables: stillUnpaid ? paid : [...paid, newPayable(bill, vars.input.next_due_date)],
    savings_ledger: vars.input.from_savings
      ? [
          ...data.savings_ledger,
          savingsPaymentRow('bill_payable', vars.id, vars.input.paid_date, vars.input.paid_amount),
        ]
      : data.savings_ledger,
  }
}

export function applyScheduleRowPatch(
  data: FinanceData,
  vars: { id: number; patch: ScheduleRowPatch; fromSavings?: boolean },
): FinanceData {
  return {
    ...data,
    debt_schedule: data.debt_schedule.map((row) =>
      row.id === vars.id ? clearPaidWhenUnpaid({ ...row, ...vars.patch }) : row,
    ),
    savings_ledger: savingsLedgerAfterDebtPatch(data.savings_ledger, 'debt_schedule', vars),
  }
}

export function applyStatementPatch(
  data: FinanceData,
  vars: { id: number; patch: StatementPatch; fromSavings?: boolean },
): FinanceData {
  return {
    ...data,
    debt_statements: data.debt_statements.map((row) =>
      row.id === vars.id ? clearPaidWhenUnpaid({ ...row, ...clearedAmounts(vars.patch) }) : row,
    ),
    savings_ledger: savingsLedgerAfterDebtPatch(data.savings_ledger, 'debt_statement', vars),
  }
}

/**
 * The ledger side effect of a debt row's paid patch, shared by the schedule
 * and statement predictions so they cannot drift from each other. Mirrors
 * debtPaySideEffects: append the row on a savings-funded pay, remove it on
 * un-pay, leave it alone on a plain edit.
 */
function savingsLedgerAfterDebtPatch(
  rows: SavingsLedgerEntry[],
  refType: SavingsRefType,
  vars: { id: number; patch: { paid?: boolean; paid_date?: string; paid_amount?: number }; fromSavings?: boolean },
): SavingsLedgerEntry[] {
  if (vars.patch.paid === true && vars.fromSavings) {
    return [
      ...rows,
      savingsPaymentRow(
        refType,
        vars.id,
        vars.patch.paid_date as string,
        vars.patch.paid_amount as number,
      ),
    ]
  }
  if (vars.patch.paid === false) {
    return withoutSavingsPayment(rows, refType, vars.id)
  }
  return rows
}

export function removeScheduleRow(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    debt_schedule: data.debt_schedule.filter((row) => row.id !== id),
    // Both backends drop the ledger row that settled this one; a prediction that
    // kept it would understate the savings balance until the response landed.
    savings_ledger: withoutSavingsPayment(data.savings_ledger, 'debt_schedule', id),
  }
}

export function removeStatement(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    debt_statements: data.debt_statements.filter((row) => row.id !== id),
    savings_ledger: withoutSavingsPayment(data.savings_ledger, 'debt_statement', id),
  }
}

export function renameDebt(data: FinanceData, vars: { id: number; name: string }): FinanceData {
  return {
    ...data,
    debts: data.debts.map((debt) =>
      debt.id === vars.id ? { ...debt, name: vars.name } : debt,
    ),
  }
}

export function applyBillPatch(
  data: FinanceData,
  vars: { id: number; patch: BillPatch },
): FinanceData {
  return {
    ...data,
    bills: data.bills.map((bill) => (bill.id === vars.id ? { ...bill, ...vars.patch } : bill)),
  }
}

/**
 * Closing drops the unpaid payables and freezes the rest — the same two effects
 * the backend applies, both computable here.
 */
export function closeBillIn(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    bills: data.bills.map((bill) => (bill.id === id ? { ...bill, closed: true } : bill)),
    bill_payables: data.bill_payables.filter((row) => row.bill_id !== id || row.paid),
  }
}

/** Deleting a bill takes its payables with it, the same cascade the backend applies. */
export function removeBill(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    bills: data.bills.filter((bill) => bill.id !== id),
    bill_payables: data.bill_payables.filter((row) => row.bill_id !== id),
    // The cascade drops every payable, so it drops every ledger row settling one.
    savings_ledger: withoutSavingsPaymentsFor(
      data.savings_ledger,
      'bill_payable',
      data.bill_payables.filter((row) => row.bill_id === id).map((row) => row.id),
    ),
  }
}

export function applyBillPayablePatch(
  data: FinanceData,
  vars: { id: number; patch: BillPayablePatch },
): FinanceData {
  const before = data.bill_payables.find((row) => row.id === vars.id)
  const rows = data.bill_payables.map((row) =>
    row.id === vars.id ? clearPaidWhenUnpaid({ ...row, ...vars.patch }) : row,
  )
  /*
   * Undoing a payment un-mints the payable that payment created — the inverse of
   * payBillPayableIn, applied by both backends.
   *
   * Only the latest paid payable has one to un-mint: an older payment's successor
   * has since been paid itself, so undoing it must leave the open payable alone.
   * Deleting it would discard a figure the user entered, and would let the
   * re-payment mint a duplicate of a month already paid.
   *
   * Also guarded on the stored row having been paid, so editing an already-unpaid
   * payable's amount deletes nothing.
   */
  const unmint =
    before !== undefined &&
    before.paid &&
    vars.patch.paid === false &&
    !data.bill_payables.some(
      (row) =>
        row.bill_id === before.bill_id &&
        row.id !== vars.id &&
        row.paid &&
        row.due_date > before.due_date,
    )
  return {
    ...data,
    bill_payables: unmint
      ? rows.filter((row) => row.id === vars.id || row.bill_id !== before.bill_id || row.paid)
      : rows,
    savings_ledger:
      vars.patch.paid === false
        ? withoutSavingsPayment(data.savings_ledger, 'bill_payable', vars.id)
        : data.savings_ledger,
  }
}

export function removeBillPayable(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    bill_payables: data.bill_payables.filter((row) => row.id !== id),
    savings_ledger: withoutSavingsPayment(data.savings_ledger, 'bill_payable', id),
  }
}

/** Deleting a debt takes its rows with it, the same cascade the backend applies. */
export function removeDebt(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    debts: data.debts.filter((debt) => debt.id !== id),
    debt_schedule: data.debt_schedule.filter((row) => row.debt_id !== id),
    debt_statements: data.debt_statements.filter((row) => row.debt_id !== id),
    savings_ledger: withoutSavingsPaymentsFor(
      withoutSavingsPaymentsFor(
        data.savings_ledger,
        'debt_schedule',
        data.debt_schedule.filter((row) => row.debt_id === id).map((row) => row.id),
      ),
      'debt_statement',
      data.debt_statements.filter((row) => row.debt_id === id).map((row) => row.id),
    ),
  }
}

export function addIncomeTo(data: FinanceData, vars: NewIncome): FinanceData {
  const entry: IncomeEntry = { id: tempId(), ...vars }
  return { ...data, income: [...data.income, entry] }
}

/** See IncomePatch. */
function clearedNotes(patch: IncomePatch): Partial<IncomeEntry> {
  return clearNulls(patch, ['notes']) as Partial<IncomeEntry>
}

export function applyIncomePatch(
  data: FinanceData,
  vars: { id: number; patch: IncomePatch },
): FinanceData {
  return {
    ...data,
    income: data.income.map((row) =>
      row.id === vars.id ? { ...row, ...clearedNotes(vars.patch) } : row,
    ),
  }
}

export function removeIncome(data: FinanceData, id: number): FinanceData {
  return { ...data, income: data.income.filter((row) => row.id !== id) }
}

export function addIncomeSourceTo(data: FinanceData, vars: NewIncomeSource): FinanceData {
  // archived: false mirrors what both backends assign — a prediction that left
  // it undefined would flicker when the response arrived.
  const source: IncomeSource = { id: tempId(), name: vars.name, archived: false }
  return { ...data, income_sources: [...data.income_sources, source] }
}

export function applyIncomeSourcePatch(
  data: FinanceData,
  vars: { id: number; patch: IncomeSourcePatch },
): FinanceData {
  return {
    ...data,
    income_sources: data.income_sources.map((s) =>
      s.id === vars.id ? { ...s, ...vars.patch } : s,
    ),
  }
}

/**
 * Only ever called for a source with no entries — both backends refuse
 * otherwise — so no entry needs re-pointing here.
 */
export function removeIncomeSource(data: FinanceData, id: number): FinanceData {
  return { ...data, income_sources: data.income_sources.filter((s) => s.id !== id) }
}

export function addSavingsEntryTo(data: FinanceData, vars: NewSavingsEntry): FinanceData {
  // signedAmount, not the raw magnitude: a prediction storing the magnitude
  // unsigned would show a withdrawal INCREASING the balance until the response
  // arrived. Both backends convert the same way.
  const entry: SavingsLedgerEntry = {
    id: tempId(),
    date: vars.date,
    amount: signedAmount(vars.kind, vars.amount),
    kind: vars.kind,
    notes: vars.notes,
  }
  return { ...data, savings_ledger: [...data.savings_ledger, entry] }
}

export function applySavingsEntryPatch(
  data: FinanceData,
  vars: { id: number; patch: SavingsEntryPatch },
): FinanceData {
  return {
    ...data,
    savings_ledger: data.savings_ledger.map((row) => {
      if (row.id !== vars.id) return row
      const patch = vars.patch
      const next: SavingsLedgerEntry = { ...row }
      if (patch.date !== undefined) next.date = patch.date
      if (patch.notes !== undefined) next.notes = patch.notes === null ? undefined : patch.notes
      // Kind and amount are predicted together, matching the backend: either one
      // changes the signed value the balance is summed from.
      if (patch.kind !== undefined || patch.amount !== undefined) {
        const kind = (patch.kind ?? row.kind) as SavingsMovementKind
        const magnitude = patch.amount ?? Math.abs(row.amount)
        next.kind = kind
        next.amount = signedAmount(kind, magnitude)
      }
      return next
    }),
  }
}

export function removeSavingsEntry(data: FinanceData, id: number): FinanceData {
  return { ...data, savings_ledger: data.savings_ledger.filter((row) => row.id !== id) }
}

export function addTaskTo(data: FinanceData, vars: NewTask): FinanceData {
  const task: Task = { id: tempId(), ...vars }
  return { ...data, tasks: [...data.tasks, task] }
}

/** See TaskPatch — the wire's null becomes the model's undefined. */
function clearedTaskFields(patch: TaskPatch): Partial<Task> {
  return clearNulls(patch, ['notes', 'recurrence', 'note_id']) as Partial<Task>
}

export function applyTaskPatch(
  data: FinanceData,
  vars: { id: number; patch: TaskPatch },
): FinanceData {
  return {
    ...data,
    tasks: data.tasks.map((t) => (t.id === vars.id ? { ...t, ...clearedTaskFields(vars.patch) } : t)),
  }
}

export function removeTask(data: FinanceData, id: number): FinanceData {
  return { ...data, tasks: data.tasks.filter((t) => t.id !== id) }
}

/**
 * Predicts moveTask — mirrors payBillPayableIn/the old completeTaskIn: when
 * the target column is done and the task recurs, predicts the minted next
 * occurrence using the ORIGINAL task's fields, not the patched one.
 */
export function moveTaskIn(
  data: FinanceData,
  vars: { id: number; input: MoveTaskInput },
): FinanceData {
  const task = data.tasks.find((t) => t.id === vars.id)
  const target = data.task_columns.find((c) => c.id === vars.input.column_id)
  if (!task || !target) return data
  // A move that neither changes the column nor assigns a date is a true
  // no-op — matches both backends' moveTask (a duplicate/retried move must
  // never predict a second minted next occurrence, and a Backlog task
  // dropped onto its own nominal column must still predict its new date).
  const dateChanging = vars.input.date !== undefined && vars.input.date !== task.date
  if (task.column_id === target.id && !dateChanging) return data
  // Mirrors both backends' moveTask: recurred, once true, is never cleared —
  // cycling a recurring task out of Done and back in must not predict a
  // second minted successor for what is still the same occurrence.
  const willMint = target.is_done && !!task.recurrence && !!vars.input.next_date && !task.recurred
  const moved = data.tasks.map((t) =>
    t.id === vars.id
      ? {
          ...t,
          column_id: target.id,
          date: vars.input.date ?? t.date,
          completed_date: target.is_done ? vars.input.completed_date : undefined,
          recurred: willMint ? true : t.recurred,
        }
      : t,
  )
  if (!willMint) return { ...data, tasks: moved }
  const next: Task = {
    id: tempId(),
    title: task.title,
    notes: task.notes,
    date: vars.input.next_date,
    recurrence: task.recurrence,
    column_id: firstColumn(data.task_columns).id,
    note_id: task.note_id,
  }
  return { ...data, tasks: [...moved, next] }
}

export function applyTaskColumnPatch(
  data: FinanceData,
  vars: { id: number; patch: TaskColumnPatch },
): FinanceData {
  return {
    ...data,
    task_columns: data.task_columns.map((c) => (c.id === vars.id ? { ...c, ...vars.patch } : c)),
  }
}

/** See NotePatch — the wire's null becomes the model's undefined. */
function clearedNoteFields(patch: NotePatch): Partial<Note> {
  return clearNulls(patch, ['title', 'body']) as Partial<Note>
}

export function addNoteTo(data: FinanceData, vars: NewNote): FinanceData {
  const note: Note = { id: tempId(), ...vars }
  return { ...data, notes: [...data.notes, note] }
}

export function applyNotePatch(
  data: FinanceData,
  vars: { id: number; patch: NotePatch },
): FinanceData {
  return {
    ...data,
    notes: data.notes.map((n) => (n.id === vars.id ? { ...n, ...clearedNoteFields(vars.patch) } : n)),
  }
}

export function removeNote(data: FinanceData, id: number): FinanceData {
  return {
    ...data,
    notes: data.notes.filter((n) => n.id !== id),
    note_items: data.note_items.filter((i) => i.note_id !== id),
  }
}

export function addNoteItemTo(
  data: FinanceData,
  vars: { noteId: number; input: NewNoteItem },
): FinanceData {
  const sortOrder = nextSortOrder(data.note_items, vars.noteId)
  const item: NoteItem = {
    id: tempId(),
    note_id: vars.noteId,
    text: vars.input.text,
    done: false,
    sort_order: sortOrder,
  }
  return { ...data, note_items: [...data.note_items, item] }
}

export function applyNoteItemPatch(
  data: FinanceData,
  vars: { id: number; patch: NoteItemPatch },
): FinanceData {
  return {
    ...data,
    note_items: data.note_items.map((i) => (i.id === vars.id ? { ...i, ...vars.patch } : i)),
  }
}

export function removeNoteItem(data: FinanceData, id: number): FinanceData {
  return { ...data, note_items: data.note_items.filter((i) => i.id !== id) }
}
