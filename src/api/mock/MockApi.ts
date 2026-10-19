import type {
  FinanceApi,
  NewBill,
  BillPatch,
  BillPayablePatch,
  PayBillInput,
  NewDebt,
  NewScheduleRow,
  NewStatement,
  ScheduleRowPatch,
  StatementPatch,
  AuthResult,
  SignupInput,
  LoginInput,
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
} from '../FinanceApi.ts'
import type {
  FinanceData,
  Bill,
  BillPayable,
  Debt,
  DebtScheduleRow,
  DebtStatement,
  Currency,
  SavingsLedgerEntry,
  SavingsLedgerKind,
  SavingsMovementKind,
  SavingsRefType,
  Task,
  TaskColumn,
  Note,
  NoteItem,
} from '../../types.ts'
import { createSeed } from './seed.ts'
import { backfillArrays } from '../../lib/financeShape.ts'
import { readToken, decodeSession } from '../../auth/session.ts'
import { normalizeUsername, isValidUsername, USERNAME_RULE } from '../../auth/password.ts'
import { signedAmount, isPaymentKind } from '../../lib/savings.ts'
import { isoDate, isoDateTime } from '../../lib/currentMonth.ts'
import { nextSortOrder } from '../../lib/notes.ts'
import { DEFAULT_TASK_COLUMNS, firstColumn } from '../../lib/taskColumns.ts'

const KEY = 'finance-mock-db'

/*
 * Mirrors assertIncomeDate / assertIncomeAmount in Code.gs. The two backends
 * must agree on what fails and with what message, or predictions in
 * lib/optimistic.ts cannot match both — the rule stated at the top of that file.
 *
 * A blank date is the one worth guarding: it writes a row no month window
 * matches, invisible on every screen and so unreachable for edit or delete.
 */
function assertIncomeDate(date: string | undefined): void {
  if (!date) throw new Error('An income entry needs a date')
}

function assertIncomeAmount(amount: number | undefined): void {
  if (amount === undefined || Number.isNaN(Number(amount))) {
    throw new Error('An income entry needs an amount')
  }
  if (Number(amount) < 0) throw new Error('An income amount cannot be negative')
}

function assertMovementKind(kind: string): void {
  if (kind !== 'deposit' && kind !== 'withdrawal') {
    throw new Error('A savings movement must be a deposit or a withdrawal')
  }
}

function assertSavingsDate(date: string | undefined): void {
  if (!date) throw new Error('A savings movement needs a date')
}

function assertSavingsAmount(amount: number | undefined): void {
  if (amount === undefined || Number.isNaN(Number(amount))) {
    throw new Error('A savings movement needs an amount')
  }
  if (Number(amount) <= 0) {
    throw new Error('Enter a positive amount and pick deposit or withdrawal')
  }
}

/*
 * Compared in CENTS, mirroring Code.gs. 0.70 + 0.10 sums to 0.7999999999999999,
 * so withdrawing the full 0.80 lands at -1.1e-16 and a raw `< 0` refuses a write
 * the user can see is valid. Both the guard and the formatted balance must match
 * Code.gs exactly — optimistic.ts requires predictions to hold for both backends.
 */
/*
 * The as-of-today balance after optionally replacing one row, mirroring
 * savingsBalanceAfter in Code.gs. A movement dated for a future payday is stored
 * but not counted, so it cannot fund a withdrawal now.
 */
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

function savingsBalanceAfter(
  rows: SavingsLedgerEntry[],
  excludeId: number | null,
  replacement: { date: string; amount: number } | null,
): number {
  const today = isoDate()
  let total = 0
  for (const row of rows) {
    if (excludeId !== null && row.id === excludeId) continue
    if (row.date <= today) total += row.amount
  }
  if (replacement && replacement.date <= today) total += replacement.amount
  return total
}

function assertNotBelowZero(balance: number): void {
  if (Math.round(balance * 100) < 0) {
    throw new Error(`That would put savings below zero. The balance as of today is ${balance.toFixed(2)}.`)
  }
}

function assertNotPaymentRow(row: SavingsLedgerEntry): void {
  if (isPaymentKind(row.kind)) {
    throw new Error('That movement settled a bill or debt. Change it there instead.')
  }
}

/*
 * The kind a settled row's payment is recorded under. Keyed by ref_type, whose
 * statement value is SINGULAR (debt_statement) while its sheet is plural
 * (debt_statements) — SavingsRefType in src/types.ts is the authority.
 */
const PAYMENT_KIND: Record<SavingsRefType, SavingsLedgerKind> = {
  bill_payable: 'bill_payment',
  debt_schedule: 'debt_payment',
  debt_statement: 'debt_payment',
}

function refRow(
  rows: SavingsLedgerEntry[],
  refType: SavingsRefType,
  refId: number,
): SavingsLedgerEntry | undefined {
  return rows.find((r) => r.ref_type === refType && r.ref_id === refId)
}

/*
 * Refuses a change that would leave a savings-funded payment disagreeing with
 * its ledger row. Un-paying is the sanctioned way out, so this fires only for
 * a re-pay or an amount edit. Mirrors assertNotSavingsFunded in Code.gs.
 */
function assertNotSavingsFunded(
  rows: SavingsLedgerEntry[],
  refType: SavingsRefType,
  refId: number,
): void {
  const row = refRow(rows, refType, refId)
  if (row) {
    throw new Error(
      `That payment came from savings (${Math.abs(row.amount).toFixed(2)}). Un-pay it first, then pay again.`,
    )
  }
}

/*
 * Validates a savings-funded payment and returns the signed amount the write
 * will use — the already-settled check, the date/amount checks, and the
 * below-zero guard, all in one place. Mirrors prepareSettleFromSavings in
 * Code.gs: called BEFORE anything is written, so the common refusals leave
 * the data untouched instead of writing the row first and discovering the
 * settle would have failed.
 */
function prepareSettleFromSavings(
  data: FinanceData,
  refType: SavingsRefType,
  refId: number,
  paidDate: string,
  paidAmount: number,
): number {
  const found = refRow(data.savings_ledger, refType, refId)
  if (found) {
    throw new Error(
      `That payment came from savings (${Math.abs(found.amount).toFixed(2)}). Un-pay it first, then pay again.`,
    )
  }
  assertSavingsDate(paidDate)
  assertSavingsAmount(paidAmount)
  const signed = -Math.abs(paidAmount)
  assertNotBelowZero(
    savingsBalanceAfter(data.savings_ledger, null, { date: paidDate, amount: signed }),
  )
  return signed
}

/*
 * Writes the row prepareSettleFromSavings validated. No checks: mirrors
 * appendSavingsPayment in Code.gs.
 */
function appendSavingsPayment(
  data: FinanceData,
  refType: SavingsRefType,
  refId: number,
  paidDate: string,
  signed: number,
): void {
  data.savings_ledger.push({
    id: nextId(data.savings_ledger),
    date: paidDate,
    amount: signed,
    kind: PAYMENT_KIND[refType],
    ref_type: refType,
    ref_id: refId,
  })
}

/**
 * Whether patch actually changes paid_amount / paid_date, compared by VALUE
 * rather than by key presence — mirrors paidAmountChanged / paidDateChanged in
 * Code.gs. A caller re-sending the identical figure must not trip a refusal
 * meant for an actual change.
 */
function paidAmountChanged(
  patch: { paid_amount?: number | null },
  previous: { paid_amount?: number },
): boolean {
  if (!hasOwn(patch, 'paid_amount')) return false
  const newVal = patch.paid_amount
  const oldVal = previous.paid_amount
  const newBlank = newVal === null || newVal === undefined
  const oldBlank = oldVal === undefined
  if (newBlank && oldBlank) return false
  if (newBlank !== oldBlank) return true
  return Number(newVal) !== Number(oldVal)
}

function paidDateChanged(
  patch: { paid_date?: string | null },
  previous: { paid_date?: string },
): boolean {
  if (!hasOwn(patch, 'paid_date')) return false
  const newVal = patch.paid_date
  const oldVal = previous.paid_date
  const newBlank = newVal === null || newVal === undefined
  const oldBlank = oldVal === undefined
  if (newBlank && oldBlank) return false
  if (newBlank !== oldBlank) return true
  return String(newVal) !== String(oldVal)
}

/** Returns the money. A no-op when the payment was not savings-funded. */
function unsettleFromSavings(
  data: FinanceData,
  refType: SavingsRefType,
  refId: number,
): void {
  data.savings_ledger = data.savings_ledger.filter(
    (r) => !(r.ref_type === refType && r.ref_id === refId),
  )
}

/*
 * Drops every ledger row settling one of `refIds`, in one pass. Mirrors
 * unsettleManyFromSavings in Code.gs — MockApi has no sheet reads to save, but
 * the two backends must still agree function-for-function on what is checked
 * and when.
 */
function unsettleManyFromSavings(
  data: FinanceData,
  refType: SavingsRefType,
  refIds: number[],
): void {
  if (!refIds.length) return
  const wanted = new Set(refIds)
  data.savings_ledger = data.savings_ledger.filter(
    (r) => !(r.ref_type === refType && r.ref_id !== undefined && wanted.has(r.ref_id)),
  )
}

/*
 * The paying/unpaying classification a debt row's payment transition boils
 * down to — shared by prepareDebtPaySideEffects and applyDebtPaySideEffects so
 * the two agree on what happened without recomputing it differently.
 * Classification is by TRANSITION, not by payload, since the two form modals
 * always re-send paid/paid_date/paid_amount on an already-paid row.
 */
function classifyDebtPayTransition(
  patch: { paid?: boolean },
  previous: { paid: boolean },
): { paying: boolean; unpaying: boolean } {
  const hasPaid = Object.prototype.hasOwnProperty.call(patch, 'paid')
  return {
    paying: hasPaid && patch.paid === true && !previous.paid,
    unpaying: hasPaid && patch.paid === false && previous.paid,
  }
}

/*
 * Mirrors updateDebtRow's pre-patch refusals in Code.gs. Called BEFORE the row
 * is mutated, so a bad amount/date, an insufficient balance, or a re-pay of a
 * row already funded from savings leaves the data untouched. Returns the
 * signed amount for a savings-funded pay, so applyDebtPaySideEffects can
 * append it with no further checks — or null when there is nothing to append.
 */
function prepareDebtPaySideEffects(
  data: FinanceData,
  refType: SavingsRefType,
  refId: number,
  patch: { paid?: boolean; paid_date?: string | null; paid_amount?: number | null },
  previous: { paid: boolean; paid_date?: string; paid_amount?: number },
  fromSavings: boolean | undefined,
): number | null {
  const { paying, unpaying } = classifyDebtPayTransition(patch, previous)
  if (paying) {
    if (fromSavings === true) {
      return prepareSettleFromSavings(
        data,
        refType,
        refId,
        patch.paid_date as string,
        patch.paid_amount as number,
      )
    }
    assertNotSavingsFunded(data.savings_ledger, refType, refId)
    return null
  }
  if (!unpaying && (paidAmountChanged(patch, previous) || paidDateChanged(patch, previous))) {
    assertNotSavingsFunded(data.savings_ledger, refType, refId)
  }
  return null
}

/*
 * Mirrors updateDebtRow's post-patch effects in Code.gs: the reversal for an
 * un-pay, or the ledger append for a savings-funded pay, using the signed
 * amount prepareDebtPaySideEffects already validated.
 */
function applyDebtPaySideEffects(
  data: FinanceData,
  refType: SavingsRefType,
  refId: number,
  patch: { paid?: boolean; paid_date?: string | null },
  signed: number | null,
): void {
  /*
   * The reversal fires on the PAYLOAD, not the transition. A row left unpaid with
   * its ledger row still present — an un-pay that failed after the patch — would
   * otherwise be unrecoverable: paying is refused because the ref is settled, and
   * a transition-based un-pay does nothing. unsettleFromSavings is a no-op when
   * there is no row, so this is safe on an ordinary edit.
   */
  if (Object.prototype.hasOwnProperty.call(patch, 'paid') && patch.paid === false) {
    unsettleFromSavings(data, refType, refId)
  }
  else if (signed !== null) {
    appendSavingsPayment(data, refType, refId, patch.paid_date as string, signed)
  }
}

interface MockUser {
  id: number
  username: string
  /** The client-derived value, stored as-is. Mock only — no server pepper here. */
  pw_hash: string
}

/** One FinanceData blob per user id, so isolation comes for free. */
interface MockDb {
  users: MockUser[]
  data: Record<string, FinanceData>
}

function nextId<T extends { id: number }>(rows: T[]): number {
  return rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
}

/**
 * An unpaid row must not keep a payment date. Cleared explicitly rather than
 * relying on JSON dropping undefined, so both adapters behave the same way.
 */
function clearPaidFields(row: DebtScheduleRow | DebtStatement | BillPayable): void {
  if (!row.paid) {
    delete row.paid_date
    delete row.paid_amount
  }
}

function mockToken(user: MockUser): string {
  // Same two-part shape the real backend produces, so decodeSession works
  // unchanged. The signature part is a placeholder: mock does not verify.
  const payload = btoa(JSON.stringify({ uid: user.id, username: user.username }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${payload}.mock`
}

export class MockApi implements FinanceApi {
  private loadDb(): MockDb {
    const raw = localStorage.getItem(KEY)
    // Fields are backfilled rather than trusted: this database is persisted JSON
    // that outlives code changes, so a browser holding an older shape must not
    // crash on a field added later.
    const stored = raw ? (JSON.parse(raw) as Partial<MockDb>) : null
    const db: MockDb = { users: stored?.users ?? [], data: stored?.data ?? {} }
    if (!raw) this.saveDb(db)
    return db
  }

  private saveDb(db: MockDb): void {
    localStorage.setItem(KEY, JSON.stringify(db))
  }

  /** The signed-in user's id, from the same token store the real adapter uses. */
  private uid(): string {
    const session = decodeSession(readToken())
    if (!session) throw new Error('unauthorized')
    return String(session.id)
  }

  private load(): FinanceData {
    const db = this.loadDb()
    const key = this.uid()
    const data = db.data[key]
    if (!data) throw new Error('unauthorized')
    // Backfilled for the same reason loadDb backfills its own fields: this blob
    // is persisted JSON that outlives code changes, and a browser holding a
    // shape from before a field existed must not take every page down with it.
    // Driven by financeShape's own list rather than naming fields here, so a
    // schema change cannot be applied to the check and forgotten here.
    backfillArrays(data)
    // Self-heal: every user gets the three default columns the first time
    // their data is read, the same way Settings' currency falls back to a
    // default rather than being seeded at signup — there is no signup hook
    // to hang this off of, and every existing user needs it once too.
    // A plain .map with nextId(data.task_columns) would hand every seeded
    // row the same id — data.task_columns is still [] for the whole map
    // call, since the reassignment only happens after it returns — so ids
    // are assigned by hand, one higher than the last, instead.
    if (data.task_columns.length === 0) {
      const startId = nextId(data.task_columns)
      data.task_columns = DEFAULT_TASK_COLUMNS.map((c, i) => ({ id: startId + i, ...c }))
      this.save(data)
    }
    return data
  }

  private save(data: FinanceData): void {
    const db = this.loadDb()
    db.data[this.uid()] = data
    this.saveDb(db)
  }

  // Simulate a little latency so loading states are exercised in the UI.
  private async delay<T>(value: T): Promise<T> {
    await new Promise((r) => setTimeout(r, 80))
    return value
  }

  async signup(input: SignupInput): Promise<AuthResult> {
    const db = this.loadDb()
    const username = normalizeUsername(input.username)
    // Mock mode takes no invite code — local development should not need one.
    // The live backend still requires and burns a real code.
    if (!isValidUsername(username)) throw new Error(`Use ${USERNAME_RULE}`)
    if (db.users.some((u) => u.username === username)) throw new Error('That username is taken.')

    const user: MockUser = { id: nextId(db.users), username, pw_hash: input.derived }
    db.users.push(user)
    db.data[String(user.id)] = createSeed()
    this.saveDb(db)
    return this.delay({ token: mockToken(user), user: { id: user.id, username } })
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const db = this.loadDb()
    const username = normalizeUsername(input.username)
    const user = db.users.find((u) => u.username === username)
    // Same message either way, matching the backend.
    if (!user || user.pw_hash !== input.derived) throw new Error('Wrong username or password.')
    return this.delay({ token: mockToken(user), user: { id: user.id, username } })
  }

  async getAll(): Promise<FinanceData> {
    return this.delay(this.load())
  }

  async addBill(input: NewBill): Promise<FinanceData> {
    const data = this.load()
    const { first_due_date, ...fields } = input
    const bill: Bill = { id: nextId(data.bills), ...fields, closed: false }
    data.bills.push(bill)
    data.bill_payables.push(this.newPayable(data, bill, first_due_date))
    this.save(data)
    return this.delay(data)
  }

  /** The payable a new bill or a payment starts from. */
  private newPayable(data: FinanceData, bill: Bill, dueDate: string): BillPayable {
    return {
      id: nextId(data.bill_payables),
      bill_id: bill.id,
      due_date: dueDate,
      // A variable bill's payable has no figure yet; the user sets it when the
      // statement arrives.
      amount: bill.type === 'fixed' ? bill.amount : undefined,
      paid: false,
    }
  }

  /**
   * The bill, refused when closed. Every bill write goes through here: the
   * frontend hides the actions on a closed bill, but a stale tab must not be
   * able to slip one past. Code.gs applies the same rule.
   */
  private openBill(data: FinanceData, id: number): Bill {
    const bill = data.bills.find((b) => b.id === id)
    if (!bill) throw new Error(`Bill ${id} not found`)
    if (bill.closed) throw new Error('That bill is closed.')
    return bill
  }

  private payableBill(data: FinanceData, payableId: number): { bill: Bill; row: BillPayable } {
    const row = data.bill_payables.find((r) => r.id === payableId)
    if (!row) throw new Error(`Bill payable ${payableId} not found`)
    return { bill: this.openBill(data, row.bill_id), row }
  }

  async updateBill(id: number, patch: BillPatch): Promise<FinanceData> {
    const data = this.load()
    Object.assign(this.openBill(data, id), patch)
    this.save(data)
    return this.delay(data)
  }

  async closeBill(id: number): Promise<FinanceData> {
    const data = this.load()
    const bill = this.openBill(data, id)
    // The trailing unpaid payable would otherwise sit at the top of the detail
    // view forever, reading as a bill being neglected.
    //
    // Unsettle first: a payable can be unpaid while still carrying a ledger row
    // (an un-pay that failed after the patch), and dropping it without
    // unsettling would orphan that row with a dangling ref_id.
    unsettleManyFromSavings(
      data,
      'bill_payable',
      data.bill_payables.filter((r) => r.bill_id === id && !r.paid).map((r) => r.id),
    )
    data.bill_payables = data.bill_payables.filter((r) => r.bill_id !== id || r.paid)
    bill.closed = true
    this.save(data)
    return this.delay(data)
  }

  async deleteBill(id: number): Promise<FinanceData> {
    const data = this.load()
    // Unsettle every payable's ledger entry BEFORE the cascade deletes the
    // payables themselves, so a failure here cannot leave the payables gone
    // with the ledger rows still present.
    unsettleManyFromSavings(
      data,
      'bill_payable',
      data.bill_payables.filter((r) => r.bill_id === id).map((r) => r.id),
    )
    data.bills = data.bills.filter((b) => b.id !== id)
    data.bill_payables = data.bill_payables.filter((r) => r.bill_id !== id)
    this.save(data)
    return this.delay(data)
  }

  async updateBillPayable(id: number, patch: BillPayablePatch): Promise<FinanceData> {
    const data = this.load()
    const { bill, row } = this.payableBill(data, id)
    /*
     * Undoing a payment un-mints the payable that payment created — the inverse
     * of the mint in payBillPayable. Code.gs applies the same rule.
     *
     * Decided before the patch, which is what makes "was this row paid"
     * answerable, and limited to the latest paid payable: only that payment has
     * an open payable to un-mint. See isLatestPaidPayable in Code.gs.
     */
    const unmint =
      row.paid &&
      patch.paid === false &&
      !data.bill_payables.some(
        (r) => r.bill_id === bill.id && r.id !== id && r.paid && r.due_date > row.due_date,
      )
    // Classified by TRANSITION, not by payload: `unpaying` requires the row to
    // have BEEN paid, matching Code.gs, so a patch on an already-unpaid row is
    // never misread as an un-pay.
    const unpaying =
      Object.prototype.hasOwnProperty.call(patch, 'paid') && patch.paid === false && row.paid === true
    const previousFigures = { paid_date: row.paid_date, paid_amount: row.paid_amount }
    if (!unpaying && (paidAmountChanged(patch, previousFigures) || paidDateChanged(patch, previousFigures))) {
      assertNotSavingsFunded(data.savings_ledger, 'bill_payable', id)
    }
    Object.assign(row, patch)
    clearPaidFields(row)
    if (unmint) {
      data.bill_payables = data.bill_payables.filter(
        (r) => r.id === id || r.bill_id !== bill.id || r.paid,
      )
    }
    // Reversal on the PAYLOAD, not the transition — see prepareDebtPaySideEffects.
    if (Object.prototype.hasOwnProperty.call(patch, 'paid') && patch.paid === false) {
      unsettleFromSavings(data, 'bill_payable', id)
    }
    this.save(data)
    return this.delay(data)
  }

  async deleteBillPayable(id: number): Promise<FinanceData> {
    const data = this.load()
    this.payableBill(data, id)
    // Before the delete: if unsettling threw, the payable and its ledger row
    // both survive, rather than deleting first and risking an orphan.
    unsettleFromSavings(data, 'bill_payable', id)
    data.bill_payables = data.bill_payables.filter((r) => r.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async payBillPayable(id: number, input: PayBillInput): Promise<FinanceData> {
    const data = this.load()
    const { bill, row } = this.payableBill(data, id)
    // Validate BEFORE anything is written, so a bad amount/date, an
    // insufficient balance, or a re-pay of a row already funded from savings
    // leaves the data completely untouched.
    let signed: number | null = null
    if (input.from_savings) {
      signed = prepareSettleFromSavings(data, 'bill_payable', id, input.paid_date, input.paid_amount)
    } else {
      // A stale tab could re-pay a row already funded from savings; that would
      // desync the amount from the ledger row.
      assertNotSavingsFunded(data.savings_ledger, 'bill_payable', id)
    }
    row.paid = true
    row.paid_date = input.paid_date
    row.paid_amount = input.paid_amount
    // Minted BEFORE the settle: a late failure must not kill the bill's
    // recurrence by leaving the payable paid with no successor. Mint only when
    // nothing else is outstanding, so a double-submitted Pay cannot leave two
    // competing upcoming rows.
    const stillUnpaid = data.bill_payables.some((r) => r.bill_id === bill.id && !r.paid)
    if (!stillUnpaid) {
      data.bill_payables.push(this.newPayable(data, bill, input.next_due_date))
    }
    if (signed !== null) {
      appendSavingsPayment(data, 'bill_payable', id, input.paid_date, signed)
    }
    this.save(data)
    return this.delay(data)
  }

  async addDebt(input: NewDebt): Promise<FinanceData> {
    const data = this.load()
    const debt: Debt = { id: nextId(data.debts), name: input.name, type: input.type }
    data.debts.push(debt)
    if (input.type === 'fixed') {
      for (const row of input.rows) {
        data.debt_schedule.push({ id: nextId(data.debt_schedule), debt_id: debt.id, ...row })
      }
    } else {
      for (const row of input.rows) {
        data.debt_statements.push({ id: nextId(data.debt_statements), debt_id: debt.id, ...row })
      }
    }
    this.save(data)
    return this.delay(data)
  }

  async updateDebt(id: number, patch: { name: string }): Promise<FinanceData> {
    const data = this.load()
    const debt = data.debts.find((d) => d.id === id)
    if (!debt) throw new Error(`Debt ${id} not found`)
    debt.name = patch.name
    this.save(data)
    return this.delay(data)
  }

  async deleteDebt(id: number): Promise<FinanceData> {
    const data = this.load()
    // Unsettle every child row's ledger entry BEFORE the cascade deletes the
    // rows themselves, so a failure here cannot leave the settled rows gone
    // with the ledger rows still present.
    unsettleManyFromSavings(
      data,
      'debt_schedule',
      data.debt_schedule.filter((r) => r.debt_id === id).map((r) => r.id),
    )
    unsettleManyFromSavings(
      data,
      'debt_statement',
      data.debt_statements.filter((r) => r.debt_id === id).map((r) => r.id),
    )
    data.debts = data.debts.filter((d) => d.id !== id)
    data.debt_schedule = data.debt_schedule.filter((r) => r.debt_id !== id)
    data.debt_statements = data.debt_statements.filter((r) => r.debt_id !== id)
    this.save(data)
    return this.delay(data)
  }

  async addScheduleRow(debtId: number, input: NewScheduleRow): Promise<FinanceData> {
    const data = this.load()
    data.debt_schedule.push({ id: nextId(data.debt_schedule), debt_id: debtId, ...input })
    this.save(data)
    return this.delay(data)
  }

  async updateScheduleRow(
    id: number,
    patch: ScheduleRowPatch,
    fromSavings?: boolean,
  ): Promise<FinanceData> {
    const data = this.load()
    const row = data.debt_schedule.find((r) => r.id === id)
    if (!row) throw new Error(`Schedule row ${id} not found`)
    const previous = { paid: row.paid === true, paid_date: row.paid_date, paid_amount: row.paid_amount }
    const signed = prepareDebtPaySideEffects(data, 'debt_schedule', id, patch, previous, fromSavings)
    Object.assign(row, patch)
    clearPaidFields(row)
    applyDebtPaySideEffects(data, 'debt_schedule', id, patch, signed)
    this.save(data)
    return this.delay(data)
  }

  async deleteScheduleRow(id: number): Promise<FinanceData> {
    const data = this.load()
    unsettleFromSavings(data, 'debt_schedule', id)
    data.debt_schedule = data.debt_schedule.filter((r) => r.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async addStatement(debtId: number, input: NewStatement): Promise<FinanceData> {
    const data = this.load()
    data.debt_statements.push({ id: nextId(data.debt_statements), debt_id: debtId, ...input })
    this.save(data)
    return this.delay(data)
  }

  async updateStatement(
    id: number,
    patch: StatementPatch,
    fromSavings?: boolean,
  ): Promise<FinanceData> {
    const data = this.load()
    const row = data.debt_statements.find((r) => r.id === id)
    if (!row) throw new Error(`Statement ${id} not found`)
    const previous = { paid: row.paid === true, paid_date: row.paid_date, paid_amount: row.paid_amount }
    const signed = prepareDebtPaySideEffects(data, 'debt_statement', id, patch, previous, fromSavings)
    Object.assign(row, patch)
    // null is the wire's "clear this"; the stored model uses undefined.
    for (const key of ['min_due', 'total_due', 'outstanding'] as const) {
      if (patch[key] === null) row[key] = undefined
    }
    clearPaidFields(row)
    applyDebtPaySideEffects(data, 'debt_statement', id, patch, signed)
    this.save(data)
    return this.delay(data)
  }

  async deleteStatement(id: number): Promise<FinanceData> {
    const data = this.load()
    unsettleFromSavings(data, 'debt_statement', id)
    data.debt_statements = data.debt_statements.filter((r) => r.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async setCurrency(currency: Currency): Promise<FinanceData> {
    const data = this.load()
    data.settings.currency = currency
    this.save(data)
    return this.delay(data)
  }

  async addIncome(input: NewIncome): Promise<FinanceData> {
    const data = this.load()
    if (!data.income_sources.some((s) => s.id === input.source_id)) {
      throw new Error(`Income source ${input.source_id} not found`)
    }
    assertIncomeDate(input.date)
    assertIncomeAmount(input.amount)
    data.income.push({ id: nextId(data.income), ...input })
    this.save(data)
    return this.delay(data)
  }

  async updateIncome(id: number, patch: IncomePatch): Promise<FinanceData> {
    const data = this.load()
    const row = data.income.find((r) => r.id === id)
    if (!row) throw new Error(`Income ${id} not found`)
    // MockApi has no accounts, so only existence is checked here — Code.gs
    // additionally checks ownership, which this cannot reproduce.
    if (
      Object.prototype.hasOwnProperty.call(patch, 'source_id') &&
      !data.income_sources.some((s) => s.id === patch.source_id)
    ) {
      throw new Error(`Income source ${patch.source_id} not found`)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'date')) assertIncomeDate(patch.date)
    if (Object.prototype.hasOwnProperty.call(patch, 'amount')) assertIncomeAmount(patch.amount)
    Object.assign(row, patch)
    // null is the wire's "clear this"; the stored model uses undefined.
    if (patch.notes === null) row.notes = undefined
    this.save(data)
    return this.delay(data)
  }

  async deleteIncome(id: number): Promise<FinanceData> {
    const data = this.load()
    const row = data.income.find((r) => r.id === id)
    // Throws like ownedRowIndex does, so a missing row fails the same way on
    // both backends instead of silently succeeding here.
    if (!row) throw new Error(`Income ${id} not found`)
    data.income = data.income.filter((r) => r.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async addIncomeSource(input: NewIncomeSource): Promise<FinanceData> {
    const data = this.load()
    data.income_sources.push({ id: nextId(data.income_sources), ...input, archived: false })
    this.save(data)
    return this.delay(data)
  }

  async updateIncomeSource(id: number, patch: IncomeSourcePatch): Promise<FinanceData> {
    const data = this.load()
    const row = data.income_sources.find((s) => s.id === id)
    if (!row) throw new Error(`Income source ${id} not found`)
    Object.assign(row, patch)
    this.save(data)
    return this.delay(data)
  }

  async deleteIncomeSource(id: number): Promise<FinanceData> {
    const data = this.load()
    const row = data.income_sources.find((s) => s.id === id)
    // Throws like ownedRowIndex does, so a missing row fails the same way on
    // both backends instead of silently succeeding here.
    if (!row) throw new Error(`Income source ${id} not found`)
    const used = data.income.filter((r) => r.source_id === id).length
    if (used > 0) {
      throw new Error(
        `${used} ${used === 1 ? 'entry uses' : 'entries use'} that source. Archive it instead.`,
      )
    }
    data.income_sources = data.income_sources.filter((s) => s.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async addSavingsEntry(input: NewSavingsEntry): Promise<FinanceData> {
    const data = this.load()
    assertMovementKind(input.kind)
    assertSavingsDate(input.date)
    assertSavingsAmount(input.amount)
    const signed = signedAmount(input.kind, input.amount)
    assertNotBelowZero(
      savingsBalanceAfter(data.savings_ledger, null, { date: input.date, amount: signed }),
    )
    data.savings_ledger.push({
      id: nextId(data.savings_ledger),
      date: input.date,
      amount: signed,
      kind: input.kind,
      notes: input.notes,
    })
    this.save(data)
    return this.delay(data)
  }

  async updateSavingsEntry(id: number, patch: SavingsEntryPatch): Promise<FinanceData> {
    const data = this.load()
    const row = data.savings_ledger.find((r) => r.id === id)
    if (!row) throw new Error(`Savings movement ${id} not found`)
    assertNotPaymentRow(row)
    if (Object.prototype.hasOwnProperty.call(patch, 'date')) assertSavingsDate(patch.date)

    const hasKind = Object.prototype.hasOwnProperty.call(patch, 'kind')
    const hasAmount = Object.prototype.hasOwnProperty.call(patch, 'amount')
    const kind = hasKind ? (patch.kind as SavingsMovementKind) : (row.kind as SavingsMovementKind)
    const magnitude = hasAmount ? (patch.amount as number) : Math.abs(row.amount)
    if (hasKind || hasAmount) {
      assertMovementKind(kind)
      assertSavingsAmount(magnitude)
    }

    /*
     * Checked on EVERY edit, not only when kind or amount changed: now that the
     * balance counts only rows whose date has arrived, moving a withdrawal from
     * next week to today lowers it without touching its amount.
     */
    const effectiveDate = hasOwn(patch, 'date') ? (patch.date as string) : row.date
    assertNotBelowZero(
      savingsBalanceAfter(data.savings_ledger, id, {
        date: effectiveDate,
        amount: signedAmount(kind, magnitude),
      }),
    )

    if (hasKind || hasAmount) {
      row.kind = kind
      row.amount = signedAmount(kind, magnitude)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'date')) row.date = patch.date as string
    if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
      row.notes = patch.notes === null ? undefined : patch.notes
    }
    this.save(data)
    return this.delay(data)
  }

  async deleteSavingsEntry(id: number): Promise<FinanceData> {
    const data = this.load()
    const row = data.savings_ledger.find((r) => r.id === id)
    if (!row) throw new Error(`Savings movement ${id} not found`)
    assertNotPaymentRow(row)
    assertNotBelowZero(savingsBalanceAfter(data.savings_ledger, id, null))
    data.savings_ledger = data.savings_ledger.filter((r) => r.id !== id)
    this.save(data)
    return this.delay(data)
  }

  private ownedTask(data: FinanceData, id: number): Task {
    const task = data.tasks.find((t) => t.id === id)
    if (!task) throw new Error(`Task ${id} not found`)
    return task
  }

  private ownedTaskColumn(data: FinanceData, id: number): TaskColumn {
    const column = data.task_columns.find((c) => c.id === id)
    if (!column) throw new Error('That column was not found. It may have been deleted.')
    return column
  }

  async addTask(input: NewTask): Promise<FinanceData> {
    const data = this.load()
    if (!input.title.trim()) throw new Error('A task needs a title')
    if (input.note_id !== undefined) this.ownedNote(data, input.note_id)
    const task: Task = { id: nextId(data.tasks), ...input, created_at: isoDateTime() }
    data.tasks.push(task)
    this.save(data)
    return this.delay(data)
  }

  async updateTask(id: number, patch: TaskPatch): Promise<FinanceData> {
    const data = this.load()
    const task = this.ownedTask(data, id)
    if (Object.prototype.hasOwnProperty.call(patch, 'title') && !(patch.title ?? '').trim()) {
      throw new Error('A task needs a title')
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'note_id') && patch.note_id != null) {
      this.ownedNote(data, patch.note_id)
    }
    Object.assign(task, patch)
    // null is the wire's "clear this"; the stored model uses undefined.
    for (const key of ['notes', 'recurrence', 'note_id'] as const) {
      if (patch[key] === null) task[key] = undefined
    }
    this.save(data)
    return this.delay(data)
  }

  async deleteTask(id: number): Promise<FinanceData> {
    const data = this.load()
    this.ownedTask(data, id)
    data.tasks = data.tasks.filter((t) => t.id !== id)
    this.save(data)
    return this.delay(data)
  }

  /**
   * The one mutation for every column change. Moving into the done column
   * sets completed_date and, the first time this row does so, mints the
   * next occurrence for a recurring task — exactly today's completeTask.
   * recurred then stays true so a later re-entry into Done never mints a
   * duplicate. Moving to any other column (including out of done) just
   * updates column_id and clears completed_date, matching the old "Undo"
   * (updateTask completed:false).
   */
  async moveTask(id: number, input: MoveTaskInput): Promise<FinanceData> {
    const data = this.load()
    const task = this.ownedTask(data, id)
    const columns = data.task_columns
    const target = this.ownedTaskColumn(data, input.column_id)
    // A drop that neither changes the column nor assigns a date is a true
    // no-op, not a re-completion. Without the date half of this check, a
    // Backlog task dropped back onto the column it already (nominally) has
    // — the common case, since every new task defaults into the first
    // column — would silently skip the date assignment the drop was for.
    const dateChanging = input.date !== undefined && input.date !== task.date
    if (task.column_id === target.id && !dateChanging) return this.delay(data)
    if (input.date !== undefined) task.date = input.date
    if (target.is_done) {
      if (!input.completed_date) throw new Error('A completed task needs a date')
      task.column_id = target.id
      task.completed_date = input.completed_date
      if (task.recurrence && input.next_date && !task.recurred) {
        task.recurred = true
        const next: Task = {
          id: nextId(data.tasks),
          title: task.title,
          notes: task.notes,
          date: input.next_date,
          recurrence: task.recurrence,
          column_id: firstColumn(columns).id,
          note_id: task.note_id,
          created_at: isoDateTime(),
        }
        data.tasks.push(next)
      }
    } else {
      task.column_id = target.id
      task.completed_date = undefined
    }
    this.save(data)
    return this.delay(data)
  }

  async updateTaskColumn(id: number, patch: TaskColumnPatch): Promise<FinanceData> {
    const data = this.load()
    const column = this.ownedTaskColumn(data, id)
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      if (!(patch.name ?? '').trim()) throw new Error('A column needs a name')
      patch = { ...patch, name: patch.name!.trim() }
    }
    Object.assign(column, patch)
    this.save(data)
    return this.delay(data)
  }

  private ownedNote(data: FinanceData, id: number): Note {
    const note = data.notes.find((n) => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    return note
  }

  private ownedNoteItem(data: FinanceData, id: number): NoteItem {
    const item = data.note_items.find((i) => i.id === id)
    if (!item) throw new Error(`Note item ${id} not found`)
    return item
  }

  async addNote(input: NewNote): Promise<FinanceData> {
    const data = this.load()
    const note: Note = {
      id: nextId(data.notes),
      ...input,
    }
    data.notes.push(note)
    this.save(data)
    return this.delay(data)
  }

  async updateNote(id: number, patch: NotePatch): Promise<FinanceData> {
    const data = this.load()
    const note = this.ownedNote(data, id)
    Object.assign(note, patch)
    // null is the wire's "clear this"; the stored model uses undefined.
    if (patch.title === null) note.title = undefined
    if (patch.body === null) note.body = undefined
    this.save(data)
    return this.delay(data)
  }

  async deleteNote(id: number): Promise<FinanceData> {
    const data = this.load()
    this.ownedNote(data, id)
    data.note_items = data.note_items.filter((i) => i.note_id !== id)
    data.notes = data.notes.filter((n) => n.id !== id)
    this.save(data)
    return this.delay(data)
  }

  async addNoteItem(noteId: number, input: NewNoteItem): Promise<FinanceData> {
    const data = this.load()
    this.ownedNote(data, noteId)
    if (!input.text.trim()) throw new Error('A checklist item needs text')
    const sortOrder = nextSortOrder(data.note_items, noteId)
    data.note_items.push({ id: nextId(data.note_items), note_id: noteId, text: input.text, done: false, sort_order: sortOrder })
    this.save(data)
    return this.delay(data)
  }

  async updateNoteItem(id: number, patch: NoteItemPatch): Promise<FinanceData> {
    const data = this.load()
    const item = this.ownedNoteItem(data, id)
    if (Object.prototype.hasOwnProperty.call(patch, 'text') && !(patch.text ?? '').trim()) {
      throw new Error('A checklist item needs text')
    }
    Object.assign(item, patch)
    this.save(data)
    return this.delay(data)
  }

  async deleteNoteItem(id: number): Promise<FinanceData> {
    const data = this.load()
    this.ownedNoteItem(data, id)
    data.note_items = data.note_items.filter((i) => i.id !== id)
    this.save(data)
    return this.delay(data)
  }
}
