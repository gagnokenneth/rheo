export type DebtType = 'fixed' | 'revolving'
export type BillType = 'fixed' | 'variable'
export type BillFrequency = 'bimonthly' | 'monthly' | 'quarterly' | 'annually'
export type Currency = 'PHP' | 'USD'

/**
 * A recurring bill. Holds the recurrence rule; the due instances live in
 * bill_payables, and only one unpaid payable exists at a time — paying it mints
 * the next.
 */
export interface Bill {
  id: number
  name: string
  type: BillType
  frequency: BillFrequency
  /** The figure each payable starts from. Required for fixed, unset for variable. */
  amount?: number
  /** Day of the month; for bimonthly, the first-half day. */
  day: number
  /** Bimonthly only: the second-half day. */
  second_day?: number
  /** Annually only: 1-12. */
  month?: number
  /** Closed bills are read-only: no edits, no payments, no row deletes. */
  closed: boolean
}

/** One due instance of a bill. */
export interface BillPayable {
  id: number
  bill_id: number
  due_date: string // ISO yyyy-mm-dd
  /** Undefined means not set yet — a variable bill's figure before the statement arrives. */
  amount?: number
  paid: boolean
  paid_date?: string
  paid_amount?: number
}

export interface Debt {
  id: number
  name: string
  type: DebtType
}

/** One installment of a fixed debt. */
export interface DebtScheduleRow {
  id: number
  debt_id: number
  due_date: string // ISO yyyy-mm-dd
  amount: number
  paid: boolean
  paid_date?: string
  paid_amount?: number
}

/** One statement of a revolving debt. */
export interface DebtStatement {
  id: number
  debt_id: number
  due_date: string
  /** Undefined means not set yet — an auto-generated statement starts empty. */
  min_due?: number
  total_due?: number
  outstanding?: number
  paid: boolean
  paid_date?: string
  paid_amount?: number
}

export type SavingsLedgerKind = 'deposit' | 'withdrawal' | 'bill_payment' | 'debt_payment'
/** The two kinds a user creates directly. The payment kinds are written by FT-4. */
export type SavingsMovementKind = Extract<SavingsLedgerKind, 'deposit' | 'withdrawal'>
export type SavingsRefType = 'bill_payable' | 'debt_schedule' | 'debt_statement'

/** A named place money comes from. Archived ones leave the picker but still resolve. */
export interface IncomeSource {
  id: number
  name: string
  /** Hidden from the picker; historical entries still render its name. */
  archived: boolean
}

/** Money in. Flat entries; no recurrence by design. */
export interface IncomeEntry {
  id: number
  /** References IncomeSource.id. Renaming a source renames it everywhere. */
  source_id: number
  amount: number
  date: string // ISO yyyy-mm-dd
  notes?: string
}

/**
 * One movement of the savings balance. Signed: positive is a deposit,
 * negative a withdrawal or a bill/debt payment. The balance is the sum of
 * these and is never stored — the retired running-total field was computed
 * at write time, which every later row silently contradicted once an
 * earlier one was edited or deleted.
 */
export interface SavingsLedgerEntry {
  id: number
  date: string
  amount: number
  kind: SavingsLedgerKind
  /** Set for the payment kinds: what this payment settled. */
  ref_type?: SavingsRefType
  ref_id?: number
  notes?: string
}

export type TaskRecurrence = 'daily' | 'weekly' | 'monthly'

/** A column on the task board — its own row so a user can add/rename/reorder. */
export interface TaskColumn {
  id: number
  name: string
  sort_order: number
  /** Exactly one column per user has this true, always — enforced in
   *  lib/taskColumns.ts and Code.gs. */
  is_done: boolean
}

/**
 * A scheduled item — one-off or recurring. Unlike Bills, a recurring task
 * has no separate template row: each occurrence is its own independent row,
 * chained only by moving one into the done column minting the next (see
 * moveTask in FinanceApi.ts) — there is no stable id grouping a series the
 * way bill_id groups a bill's payables.
 *
 * A task's status is its column, not a boolean: column_id points at a
 * TaskColumn, and moving into whichever one is flagged is_done is what
 * "done" means now.
 */
export interface Task {
  id: number
  title: string
  /** HTML from the WYSIWYG description editor. */
  notes?: string
  /**
   * Unset means the task is in the Backlog — no week, no calendar presence.
   * Not a form field a user edits freely: it's set by whichever specific
   * action put the task on the board — dragging it there from the Backlog
   * (see MoveTaskInput.date), the Dashboard calendar's "add a task on this
   * day" click, or a board column's own "+" (both via AddTaskModal's
   * initialDate/initialColumnId) — never a bare "change the date" control.
   */
  date?: string
  /** Unset for a one-off task. */
  recurrence?: TaskRecurrence
  column_id: number
  completed_date?: string
  /**
   * True once this row has minted its recurring successor (see moveTask in
   * FinanceApi.ts) — set the first time it moves into the done column and
   * never cleared afterward, even once the task later leaves Done and
   * re-enters. Without this, cycling a recurring task out of Done and back
   * in would mint a second successor for what is still the same occurrence.
   * Meaningless for a non-recurring task.
   */
  recurred?: boolean
  note_id?: number
  /**
   * Full ISO 8601 datetime (unlike every other date field in this app,
   * which is a bare yyyy-mm-dd calendar day) — an audit timestamp needs the
   * time, a business date doesn't. Server-set at insert time, never patched
   * afterward. Unset on rows created before this field existed.
   */
  created_at?: string
}

/**
 * A note: an optional title plus an optional WYSIWYG body, and optionally a checklist
 * (its items live in NoteItem — present only once "Add checklist" has been
 * used on this note). Deliberately dateless — the moment something needs a
 * due date it is a Task, not a Note (see the design spec's Notes/Task
 * boundary).
 */
export interface Note {
  id: number
  /** Optional — a note can be just a body or just a checklist. */
  title?: string
  /** HTML from the WYSIWYG editor. */
  body?: string
}

/** One row of a checklist note. */
export interface NoteItem {
  id: number
  note_id: number
  text: string
  done: boolean
  /** Insertion order today — no reorder UI in this ticket, see the plan. */
  sort_order: number
}

export interface Settings {
  /** Per-user: comes from the caller's own row, not a global setting. */
  currency: Currency
}

/** All sheets, as the frontend holds them in memory. */
export interface FinanceData {
  bills: Bill[]
  bill_payables: BillPayable[]
  debts: Debt[]
  debt_schedule: DebtScheduleRow[]
  debt_statements: DebtStatement[]
  income: IncomeEntry[]
  income_sources: IncomeSource[]
  savings_ledger: SavingsLedgerEntry[]
  tasks: Task[]
  task_columns: TaskColumn[]
  notes: Note[]
  note_items: NoteItem[]
  settings: Settings
}
