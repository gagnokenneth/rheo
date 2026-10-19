import type {
  FinanceData,
  Bill,
  BillPayable,
  DebtScheduleRow,
  DebtStatement,
  Currency,
  IncomeEntry,
  IncomeSource,
  SavingsMovementKind,
  Task,
  TaskColumn,
  Note,
  NoteItem,
} from '../types.ts'

/** The keys of T that may be absent — the ones a Patch has to rule on. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T]

/**
 * A sparse patch: the keys present are the fields to change.
 *
 * `Clearable` names the fields a caller may also set to null, and null is the
 * ONLY way to unset one. undefined cannot do it — JSON.stringify drops the key
 * on the way out, so Apps Script sees "leave this alone" and keeps the old
 * value, while the optimistic prediction and the mock never serialise and
 * clear it. So: every optional field a form can leave empty belongs in
 * Clearable. The exceptions are fields only the backend writes — paid_date
 * and paid_amount are cleared server-side when a row goes unpaid, never by a
 * client patch.
 *
 * Bills take the other road: BillPatch carries the whole object, so an absent
 * field unambiguously means cleared. Either convention works. Mixing them
 * inside one patch type does not, which is what this helper prevents.
 */
type Patch<T, Clearable extends OptionalKeys<T> = never> = Partial<Omit<T, Clearable>> & {
  [K in Clearable]?: T[K] | null
}

/**
 * A new bill and its first payable, in one call. The client computes
 * first_due_date because all four recurrence rules live in lib/billSchedule.ts;
 * the backend derives the payable's amount from the bill's own type.
 */
export type NewBill = Omit<Bill, 'id' | 'closed'> & { first_due_date: string }

/**
 * Whole-object, not sparse: a bill's editor always submits every field, and
 * normalizeBillPatch in Code.gs blanks the optional ones it does not find. A
 * sparse bill patch would clear fields it never mentioned on the real backend
 * while the mock and the prediction kept them, so the type does not allow one.
 *
 * Never carries id or closed — closing goes through closeBill.
 */
export type BillPatch = Omit<Bill, 'id' | 'closed'>
export type BillPayablePatch = Patch<Omit<BillPayable, 'id' | 'bill_id'>>

/** Paying also mints the next payable, so the next due date comes with it. */
export interface PayBillInput {
  paid_date: string
  paid_amount: number
  next_due_date: string
  /** Draws the amount from the savings balance, recording one ledger row. */
  from_savings: boolean
}
export type NewScheduleRow = Omit<DebtScheduleRow, 'id' | 'debt_id'>
export type NewStatement = Omit<DebtStatement, 'id' | 'debt_id'>

/** A debt is created together with its initial rows, in one call. */
export type NewDebt =
  | { name: string; type: 'fixed'; rows: NewScheduleRow[] }
  | { name: string; type: 'revolving'; rows: NewStatement[] }

/** Patches never carry id or debt_id — a row cannot be renumbered or moved. */
export type ScheduleRowPatch = Patch<NewScheduleRow>
export type StatementPatch = Patch<NewStatement, 'min_due' | 'total_due' | 'outstanding'>

export type NewIncome = Omit<IncomeEntry, 'id'>
export type IncomePatch = Patch<NewIncome, 'notes'>
export type NewIncomeSource = Pick<IncomeSource, 'name'>
export type IncomeSourcePatch = Patch<Omit<IncomeSource, 'id'>>

/** amount is a POSITIVE magnitude; the backend derives the stored sign from kind. */
export interface NewSavingsEntry {
  date: string
  kind: SavingsMovementKind
  amount: number
  notes?: string
}
export type SavingsEntryPatch = Patch<NewSavingsEntry, 'notes'>

/** created_at is server-set at insert time (like users.created), never
 *  client-supplied — matches how completed_date and recurred are
 *  server-managed too. */
export type NewTask = Omit<Task, 'id' | 'completed_date' | 'created_at' | 'recurred'>
/**
 * column_id, completed_date, date, created_at, and recurred are excluded
 * entirely. column_id/date only ever change via moveTask (which also
 * handles minting a recurring task's next occurrence, and stamping
 * recurred so it happens only once per occurrence); created_at is set once
 * at creation and never patched.
 */
export type TaskPatch = Patch<
  Omit<Task, 'id' | 'column_id' | 'completed_date' | 'date' | 'created_at' | 'recurred'>,
  'notes' | 'recurrence' | 'note_id'
>

export interface MoveTaskInput {
  column_id: number
  /** Set only when dragging an undated (Backlog) task onto the board — the
   *  one way an EXISTING task's date is ever changed. (A task can also be
   *  given a date at creation — see AddTaskModal's initialDate — but that's
   *  a separate, deliberate entry point, not this one.) */
  date?: string
  /** Required only when column_id resolves to the user's is_done column. */
  completed_date?: string
  /** Only when moving into is_done AND the task recurs — computed by nextTaskDate in lib/tasks.ts. */
  next_date?: string
}

/** is_done is never patchable — only ever true for the seeded Done column. */
export type TaskColumnPatch = Patch<Pick<TaskColumn, 'name' | 'sort_order'>>

export type NewNote = Omit<Note, 'id'>
export type NotePatch = Patch<Omit<Note, 'id'>, 'title' | 'body'>

export type NewNoteItem = Omit<NoteItem, 'id' | 'note_id' | 'done' | 'sort_order'>
/** Neither field is ever cleared to null — text is always required,
 *  done is a plain boolean like Task's own completed field. */
export type NoteItemPatch = Patch<Omit<NoteItem, 'id' | 'note_id' | 'sort_order'>>

export interface AuthResult {
  token: string
  user: { id: number; username: string }
}

export interface SignupInput {
  username: string
  derived: string
  invite_code: string
}

export interface LoginInput {
  username: string
  derived: string
}

export interface FinanceApi {
  /** Unauthenticated. Creates an account and returns a session. */
  signup(input: SignupInput): Promise<AuthResult>
  /** Unauthenticated. Returns a session for valid credentials. */
  login(input: LoginInput): Promise<AuthResult>

  /** Read every sheet at once (all module views derive from this). */
  getAll(): Promise<FinanceData>

  /*
   * Debt and currency writes return the whole updated dataset rather than the
   * affected row.
   *
   * Two reasons. It halves the work: the caller can drop the response straight
   * into its cache instead of firing a second read, and on Apps Script each
   * request costs over a second of fixed overhead. And it removes a race — a
   * follow-up read runs as a separate Apps Script execution, which can observe
   * state from before the write it is meant to reflect.
   */
  addDebt(input: NewDebt): Promise<FinanceData>
  updateDebt(id: number, patch: { name: string }): Promise<FinanceData>
  /** Deletes the debt and every row belonging to it. */
  deleteDebt(id: number): Promise<FinanceData>

  addScheduleRow(debtId: number, input: NewScheduleRow): Promise<FinanceData>
  /** Paying is an update: { paid: true, paid_date, paid_amount }. */
  updateScheduleRow(
    id: number,
    patch: ScheduleRowPatch,
    fromSavings?: boolean,
  ): Promise<FinanceData>
  deleteScheduleRow(id: number): Promise<FinanceData>

  addStatement(debtId: number, input: NewStatement): Promise<FinanceData>
  updateStatement(
    id: number,
    patch: StatementPatch,
    fromSavings?: boolean,
  ): Promise<FinanceData>
  deleteStatement(id: number): Promise<FinanceData>

  /* Bill writes return the whole updated dataset, for the same reasons above. */

  /** Creates the bill and its first payable. */
  addBill(input: NewBill): Promise<FinanceData>
  updateBill(id: number, patch: BillPatch): Promise<FinanceData>
  /** One-way. Removes the bill's unpaid payables and freezes the rest. */
  closeBill(id: number): Promise<FinanceData>
  /** Deletes the bill and every payable belonging to it. */
  deleteBill(id: number): Promise<FinanceData>

  /** Serves both Edit and Set amount. */
  updateBillPayable(id: number, patch: BillPayablePatch): Promise<FinanceData>
  deleteBillPayable(id: number): Promise<FinanceData>
  /** Marks the payable paid AND mints the next one, in one write. */
  payBillPayable(id: number, input: PayBillInput): Promise<FinanceData>

  setCurrency(currency: Currency): Promise<FinanceData>

  /* Income writes return the whole updated dataset, for the same reasons above. */

  addIncome(input: NewIncome): Promise<FinanceData>
  updateIncome(id: number, patch: IncomePatch): Promise<FinanceData>
  deleteIncome(id: number): Promise<FinanceData>

  addIncomeSource(input: NewIncomeSource): Promise<FinanceData>
  updateIncomeSource(id: number, patch: IncomeSourcePatch): Promise<FinanceData>
  /** Refused when any entry uses it — archive instead. */
  deleteIncomeSource(id: number): Promise<FinanceData>

  /* Savings writes return the whole updated dataset, for the same reasons above. */

  addSavingsEntry(input: NewSavingsEntry): Promise<FinanceData>
  updateSavingsEntry(id: number, patch: SavingsEntryPatch): Promise<FinanceData>
  /** Refused when it would take the balance below zero, or on a payment row. */
  deleteSavingsEntry(id: number): Promise<FinanceData>

  /* Task writes return the whole updated dataset, for the same reasons above. */

  addTask(input: NewTask): Promise<FinanceData>
  updateTask(id: number, patch: TaskPatch): Promise<FinanceData>
  deleteTask(id: number): Promise<FinanceData>
  /** The one mutation for every column change — drag or button, done or not. */
  moveTask(id: number, input: MoveTaskInput): Promise<FinanceData>

  /** is_done can never be patched — see TaskColumnPatch. */
  updateTaskColumn(id: number, patch: TaskColumnPatch): Promise<FinanceData>

  /* Note writes return the whole updated dataset, for the same reasons above. */

  addNote(input: NewNote): Promise<FinanceData>
  updateNote(id: number, patch: NotePatch): Promise<FinanceData>
  /** Cascades its items. */
  deleteNote(id: number): Promise<FinanceData>

  addNoteItem(noteId: number, input: NewNoteItem): Promise<FinanceData>
  updateNoteItem(id: number, patch: NoteItemPatch): Promise<FinanceData>
  deleteNoteItem(id: number): Promise<FinanceData>

}
