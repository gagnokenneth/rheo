// Rheo — Google Apps Script web app backend.
// Bind this script to the Google Sheet that holds the data sheets, then
// Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
// Secrets are generated automatically on first use; nothing to paste here.
// Full steps: docs/superpowers/guides/apps-script-setup.md

var INVITE_COUNT = 50;

var SHEETS = {
  users: ['id', 'username', 'pw_hash', 'currency', 'created'],
  bills: ['id', 'user_id', 'name', 'type', 'frequency', 'amount', 'day', 'second_day', 'month', 'closed'],
  bill_payables: ['id', 'user_id', 'bill_id', 'due_date', 'amount', 'paid', 'paid_date', 'paid_amount'],
  debts: ['id', 'user_id', 'name', 'type'],
  debt_schedule: ['id', 'user_id', 'debt_id', 'due_date', 'amount', 'paid', 'paid_date', 'paid_amount'],
  debt_statements: ['id', 'user_id', 'debt_id', 'due_date', 'min_due', 'total_due', 'outstanding', 'paid', 'paid_date', 'paid_amount'],
  income: ['id', 'user_id', 'source_id', 'amount', 'date', 'notes'],
  income_sources: ['id', 'user_id', 'name', 'archived'],
  savings_ledger: ['id', 'user_id', 'date', 'amount', 'kind', 'ref_type', 'ref_id', 'notes'],
  // goal_id is a retired column (Goals was removed) kept only so the tasks
  // tab's shape still matches: a header change makes rebuildSheets DISCARD
  // and recreate the tab, wiping every task. Nothing reads or writes it.
  tasks: ['id', 'user_id', 'title', 'notes', 'date', 'recurrence', 'column_id', 'completed_date', 'goal_id', 'note_id', 'created_at', 'recurred'],
  task_columns: ['id', 'user_id', 'name', 'sort_order', 'is_done'],
  notes: ['id', 'user_id', 'title', 'body'],
  note_items: ['id', 'user_id', 'note_id', 'text', 'done', 'sort_order'],
  invites: ['code', 'used_by', 'used_at']
};

/**
 * Bump this whenever a sheet's columns change. It busts the ensureSheets cache
 * so the new shape is applied on the very next request after a deployment,
 * instead of up to an hour later.
 */
var SCHEMA_VERSION = 17;

/*
 * Tabs whose stale shape may be DISCARDED and recreated. Deliberately excludes
 * users and invites: a column change there would otherwise delete every account
 * and password hash on the next request, re-seed fresh codes, and lock everyone
 * out with no recovery path.
 */
var REBUILDABLE_SHEETS = ['debts', 'debt_schedule', 'debt_statements', 'bills', 'bill_payables', 'income', 'income_sources', 'savings_ledger', 'tasks', 'task_columns', 'notes', 'note_items'];

var DATA_SHEETS = ['bills', 'bill_payables', 'debts', 'debt_schedule', 'debt_statements', 'income', 'income_sources', 'savings_ledger', 'tasks', 'task_columns', 'notes', 'note_items'];

/**
 * Sheets getAll actually reads. Every sheet read is a separate round trip, so
 * reading the ones no screen displays is pure latency.
 *
 * IMPORTANT: a module ticket that starts reading a sheet must add it here in
 * the same change. A sheet in DATA_SHEETS but not here is reported as an empty
 * array, so its page renders blank even though the rows exist.
 */
var ACTIVE_SHEETS = ['debts', 'debt_schedule', 'debt_statements', 'bills', 'bill_payables', 'income', 'income_sources', 'savings_ledger', 'tasks', 'task_columns', 'notes', 'note_items'];

/** Actions that return the full dataset instead of the affected row. */
var RETURNS_DATA = {
  addDebt: true, updateDebt: true, deleteDebt: true,
  addScheduleRow: true, updateScheduleRow: true, deleteScheduleRow: true,
  addStatement: true, updateStatement: true, deleteStatement: true,
  addBill: true, updateBill: true, closeBill: true, deleteBill: true,
  updateBillPayable: true, deleteBillPayable: true, payBillPayable: true,
  addIncome: true, updateIncome: true, deleteIncome: true,
  addIncomeSource: true, updateIncomeSource: true, deleteIncomeSource: true,
  setCurrency: true,
  addSavingsEntry: true, updateSavingsEntry: true, deleteSavingsEntry: true,
  addTask: true, updateTask: true, deleteTask: true, moveTask: true,
  updateTaskColumn: true,
  addNote: true, updateNote: true, deleteNote: true,
  addNoteItem: true, updateNoteItem: true, deleteNoteItem: true
};

function doGet() {
  return json({ data: 'finance api ok' });
}

function doPost(e) {
  try {
    initSecrets();
    var body = JSON.parse(e.postData.contents);
    ensureSheets();

    var action = body.action;
    // These two are the only unauthenticated actions.
    if (action === 'signup') return json(signup(body.payload || {}));
    if (action === 'login') return json(login(body.payload || {}));

    var session = verifyToken(body.token);
    if (!session || !session.uid) return json({ error: 'unauthorized' });

    // uid always comes from the verified token, never from the payload.
    var result = dispatch(action, body.payload, session.uid);

    // Writes answer with the whole updated dataset, read back in this SAME
    // execution: one request instead of two, and no window where a separate
    // read observes state from before the write.
    if (RETURNS_DATA[action]) {
      SpreadsheetApp.flush();
      return json({ data: getAll(session.uid) });
    }
    return json({ data: result });
  } catch (err) {
    return json({ error: String((err && err.message) || err) });
  }
}

/**
 * Creates any missing tab and writes its header row. Idempotent, so it can run
 * on every request: a fully set-up spreadsheet costs one lookup per tab.
 *
 * Headers on an EXISTING non-empty sheet are left alone — silently rewriting
 * them could mislabel columns of real data.
 */
function ensureSheets() {
  // Confirming every tab on every request adds up, so the result is cached.
  // The key carries SCHEMA_VERSION, so a deployment that changes columns
  // re-checks immediately rather than waiting for the cache to expire.
  var cache = CacheService.getScriptCache();
  var readyKey = 'sheets_ready_v' + SCHEMA_VERSION;
  if (cache.get(readyKey)) return;

  // Two requests arriving with a cold cache would both try to delete and
  // recreate the same tab; the second throws. Serialise, then re-check.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (cache.get(readyKey)) return;
    rebuildSheets(cache, readyKey);
  } finally {
    lock.releaseLock();
  }
}

function rebuildSheets(cache, readyKey) {
  var spreadsheet = ss();
  for (var name in SHEETS) {
    if (!Object.prototype.hasOwnProperty.call(SHEETS, name)) continue;
    var sh = spreadsheet.getSheetByName(name);

    if (!sh) {
      writeHeaders(spreadsheet.insertSheet(name), name);
      continue;
    }
    if (sh.getLastRow() === 0) {
      writeHeaders(sh, name);
      continue;
    }
    if (headersMatch(sh, name)) continue;
    // A stale shape outside the rebuildable set is left exactly as it is; losing
    // accounts is never an acceptable side effect of a deploy.
    if (REBUILDABLE_SHEETS.indexOf(name) === -1) continue;

    // Dropped and recreated. This DISCARDS the rows in that tab — deliberate, so
    // a deployment needs no manual sheet surgery. Other tabs always exist, so
    // deleting this one can never leave the file empty.
    spreadsheet.deleteSheet(sh);
    writeHeaders(spreadsheet.insertSheet(name), name);
  }

  seedInvites();
  cache.put(readyKey, '1', 3600);
}

/**
 * Puts INVITE_COUNT single-use codes in the invites sheet when it is empty, so a
 * fresh deployment can hand out accounts without inventing codes by hand. Read
 * them from the sheet; only you can see it.
 */
function seedInvites() {
  // A one-way marker, not row count: clearing the sheet is how the owner closes
  // signups, and re-seeding would silently reopen them.
  if (props().getProperty('INVITES_SEEDED')) return;
  props().setProperty('INVITES_SEEDED', '1');
  var sh = sheet('invites');
  if (sh.getLastRow() > 1) return;
  var rows = [];
  for (var i = 0; i < INVITE_COUNT; i++) rows.push([newInviteCode(), '', '']);
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

/** Eight hex characters from a v4 UUID, grouped for readability. */
function newInviteCode() {
  var hex = Utilities.getUuid().replace(/-/g, '').toUpperCase();
  return hex.slice(0, 4) + '-' + hex.slice(4, 8);
}

function normalizeCode(c) { return String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * Returns the sheet row of a matching unused code, or -1. Codes are compared
 * with punctuation stripped, so "ab12cd34" and "AB12-CD34" both work.
 */
function findUnusedInvite(code) {
  var wanted = normalizeCode(code);
  if (!wanted) return -1;
  var rows = readRows('invites');
  for (var i = 0; i < rows.length; i++) {
    if (normalizeCode(rows[i].code) === wanted && blank(rows[i].used_by)) return i + 2;
  }
  return -1;
}

function markInviteUsed(rowIndex, username) {
  var sh = sheet('invites');
  sh.getRange(rowIndex, 2).setValue(username);
  sh.getRange(rowIndex, 3).setValue(new Date().toISOString().slice(0, 10));
}

function writeHeaders(sh, name) {
  sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
  sh.setFrozenRows(1);
}

/** True when row 1 is exactly the expected columns, in order. */
function headersMatch(sh, name) {
  var expected = SHEETS[name];
  var width = sh.getLastColumn();
  if (width < expected.length) return false;
  var actual = sh.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < expected.length; i++) {
    if (String(actual[i]).trim().toLowerCase() !== expected[i]) return false;
  }
  return true;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function props() { return PropertiesService.getScriptProperties(); }

/**
 * Generates the two secrets on first use so there is no manual setup step.
 *
 * PW_PEPPER must never be rotated: it is mixed into every stored password hash,
 * so changing it invalidates every account.
 */
function initSecrets() {
  var p = props();
  if (!p.getProperty('PW_PEPPER')) p.setProperty('PW_PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('SESSION_SECRET')) p.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
}

function pepper() { return props().getProperty('PW_PEPPER'); }
function sessionSecret() { return props().getProperty('SESSION_SECRET'); }

/**
 * The client already ran 210k PBKDF2 iterations against a salt derived from the
 * username. This adds the server-held pepper, so a leaked spreadsheet does not
 * contain anything an attacker can start guessing against.
 */
function hashCredential(derived) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(derived) + pepper())
  );
}

function signToken(payloadObj) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify(payloadObj));
  return payload + '.' + Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, sessionSecret())
  );
}

/**
 * Returns { uid, username } or null. No expiry is enforced — sessions do not
 * expire by design; rotating SESSION_SECRET is the only revocation lever.
 */
function verifyToken(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], sessionSecret())
  );
  if (!constantTimeEquals(parts[1], expected)) return null;
  try {
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) {
    return null;
  }
}

/** Compares without revealing where the first difference is. */
function constantTimeEquals(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/*
 * Failed-attempt throttle for the public /exec endpoint.
 *
 * Only failures are counted, and the window's end is stored rather than re-set
 * on each write. Counting successes and extending the TTL would let an attacker
 * hammering one username keep that account locked out indefinitely — punishing
 * the owner instead of the attacker.
 */
function failureState(key) {
  var raw = CacheService.getScriptCache().get('rl_' + key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function tooManyFailures(key, max) {
  var st = failureState(key);
  return !!st && new Date().getTime() <= st.until && st.n >= max;
}

function recordFailure(key, seconds) {
  var now = new Date().getTime();
  var st = failureState(key);
  if (!st || now > st.until) st = { n: 0, until: now + seconds * 1000 };
  st.n += 1;
  var remaining = Math.max(1, Math.ceil((st.until - now) / 1000));
  CacheService.getScriptCache().put('rl_' + key, JSON.stringify(st), remaining);
}

function normalizeUsername(u) { return String(u || '').trim().toLowerCase(); }

/*
 * ASCII only, and must match isValidUsername in src/auth/password.ts.
 *
 * Beyond being a sane identifier rule, this keeps the token payload Latin-1:
 * signToken base64-encodes UTF-8 bytes while the client decodes with atob, so a
 * non-ASCII username would render as mojibake.
 */
function isValidUsername(u) { return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u); }

function findUserByUsername(username) {
  var rows = readRows('users');
  for (var i = 0; i < rows.length; i++) {
    if (normalizeUsername(rows[i].username) === username) {
      return {
        id: num(rows[i].id),
        username: String(rows[i].username),
        pw_hash: String(rows[i].pw_hash)
      };
    }
  }
  return null;
}

function userById(id) {
  var rows = readRows('users');
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].id) === num(id)) {
      return {
        id: num(rows[i].id),
        username: String(rows[i].username),
        currency: rows[i].currency ? String(rows[i].currency) : 'PHP'
      };
    }
  }
  return null;
}

function sessionResponse(uid, username) {
  return { token: signToken({ uid: uid, username: username }), user: { id: uid, username: username } };
}

function signup(p) {
  var username = normalizeUsername(p.username);
  if (!isValidUsername(username)) {
    return { error: 'Use 3-32 characters: letters, numbers, dot, dash or underscore.' };
  }
  // Password length is a client-side policy (MIN_PASSWORD_LENGTH); the server
  // only ever sees the derived value, so all it can check is that shape.
  if (!/^[0-9a-f]{64}$/.test(String(p.derived || ''))) {
    return { error: 'Could not read those credentials. Try again.' };
  }

  /*
   * Locked: this endpoint is public, and without serialisation two concurrent
   * signups both read the same nextId('users') and the same unused invite row.
   * That yields two accounts sharing one id — and a shared id means they read
   * and write each other's data, because every query is scoped by uid.
   */
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var inviteRow = findUnusedInvite(p.invite_code);
    if (inviteRow === -1) return { error: "That invite code isn't valid or has already been used." };
    if (findUserByUsername(username)) return { error: 'That username is taken.' };

    var user = {
      id: nextId('users'),
      username: username,
      pw_hash: hashCredential(p.derived),
      currency: 'PHP',
      created: new Date().toISOString().slice(0, 10)
    };
    appendRow('users', user);
    markInviteUsed(inviteRow, username); // single use — burn it
    SpreadsheetApp.flush();
    return { data: sessionResponse(user.id, username) };
  } finally {
    lock.releaseLock();
  }
}

function login(p) {
  var username = normalizeUsername(p.username);
  var key = 'login_' + username;
  if (tooManyFailures(key, 5)) {
    return { error: 'Too many attempts. Wait a minute and try again.' };
  }
  var user = findUserByUsername(username);
  // Identical message whether the user is missing or the password is wrong, so
  // this cannot be used to discover which usernames exist.
  if (!user || !constantTimeEquals(user.pw_hash, hashCredential(p.derived))) {
    recordFailure(key, 60);
    return { error: 'Wrong username or password.' };
  }
  return { data: sessionResponse(user.id, user.username) };
}

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name) {
  var sh = ss().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name);
  return sh;
}

function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function num(v) { return v === '' || v === null || v === undefined ? 0 : Number(v); }

function blank(v) { return v === '' || v === null || v === undefined; }

function bool(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/** Optional cells come back as undefined so they are omitted from the JSON. */
function optNum(v) { return blank(v) ? undefined : Number(v); }

function optDate(v) { return blank(v) ? undefined : fmtDate(v); }

/**
 * Full ISO 8601 datetime, never truncated to a bare day like optDate/fmtDate
 * do. Sheets may auto-parse a stored ISO string into a native Date cell;
 * when it comes back as a Date object here, .toISOString() reconstructs the
 * exact instant instead of collapsing it to a calendar day.
 */
function optDateTime(v) {
  if (blank(v)) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Blank text cell as undefined, matching optNum/optDate. */
function optStr(v) { return blank(v) ? undefined : String(v); }

function readRows(name) {
  var values = sheet(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === '') continue; // skip blank id rows
    var row = {};
    for (var c = 0; c < headers.length; c++) row[headers[c]] = values[i][c];
    rows.push(row);
  }
  return rows;
}

function coerce(name, r) {
  if (name === 'bills') return {
    id: num(r.id), name: String(r.name), type: String(r.type), frequency: String(r.frequency),
    amount: optNum(r.amount), day: num(r.day), second_day: optNum(r.second_day),
    month: optNum(r.month), closed: bool(r.closed)
  };
  if (name === 'bill_payables') return {
    // amount uses optNum, not num: an empty cell is a variable bill's "not set
    // yet", which is not the same as zero.
    id: num(r.id), bill_id: num(r.bill_id), due_date: fmtDate(r.due_date), amount: optNum(r.amount),
    paid: bool(r.paid), paid_date: optDate(r.paid_date), paid_amount: optNum(r.paid_amount)
  };
  if (name === 'debts') return { id: num(r.id), name: String(r.name), type: String(r.type) };
  if (name === 'debt_schedule') return {
    id: num(r.id), debt_id: num(r.debt_id), due_date: fmtDate(r.due_date), amount: num(r.amount),
    paid: bool(r.paid), paid_date: optDate(r.paid_date), paid_amount: optNum(r.paid_amount)
  };
  if (name === 'debt_statements') return {
    id: num(r.id), debt_id: num(r.debt_id), due_date: fmtDate(r.due_date),
    // optNum, not num: a blank cell is an auto-generated statement's "not set
    // yet", which is not the same as zero.
    min_due: optNum(r.min_due), total_due: optNum(r.total_due), outstanding: optNum(r.outstanding),
    paid: bool(r.paid), paid_date: optDate(r.paid_date), paid_amount: optNum(r.paid_amount)
  };
  if (name === 'income') return {
    id: num(r.id), source_id: num(r.source_id), amount: num(r.amount),
    date: fmtDate(r.date), notes: optStr(r.notes)
  };
  if (name === 'income_sources') return {
    id: num(r.id), name: String(r.name), archived: bool(r.archived)
  };
  if (name === 'savings_ledger') return {
    // amount is signed: positive is a deposit, negative a withdrawal or a
    // payment. The balance is the sum and is never stored.
    id: num(r.id), date: fmtDate(r.date), amount: num(r.amount), kind: String(r.kind),
    ref_type: optStr(r.ref_type), ref_id: optNum(r.ref_id), notes: optStr(r.notes)
  };
  if (name === 'tasks') return {
    id: num(r.id), title: String(r.title), notes: optStr(r.notes), date: optDate(r.date),
    recurrence: optStr(r.recurrence),
    column_id: num(r.column_id), completed_date: optDate(r.completed_date),
    note_id: optNum(r.note_id), created_at: optDateTime(r.created_at),
    recurred: bool(r.recurred)
  };
  if (name === 'task_columns') return {
    id: num(r.id), name: String(r.name), sort_order: num(r.sort_order), is_done: bool(r.is_done)
  };
  if (name === 'notes') return {
    id: num(r.id), title: optStr(r.title), body: optStr(r.body)
  };
  if (name === 'note_items') return {
    id: num(r.id), note_id: num(r.note_id), text: String(r.text), done: bool(r.done),
    sort_order: num(r.sort_order)
  };
  return r;
}

function appendRow(name, obj) {
  var row = SHEETS[name].map(function (h) {
    return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
  });
  sheet(name).appendRow(row);
}

/** Batch append — one setValues call instead of N appendRow round-trips. */
function appendRows(name, objs) {
  if (!objs.length) return;
  var sh = sheet(name);
  var headers = SHEETS[name];
  var values = objs.map(function (obj) {
    return headers.map(function (h) {
      return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

/** Writes only the keys present in patch. Identity columns are never patchable. */
function patchRowAt(name, rowIndex, patch) {
  var sh = sheet(name);
  var headers = SHEETS[name];
  for (var c = 0; c < headers.length; c++) {
    var h = headers[c];
    if (h === 'id' || h === 'user_id' || h === 'debt_id' || h === 'bill_id') continue;
    if (!Object.prototype.hasOwnProperty.call(patch, h)) continue;
    var v = patch[h];
    sh.getRange(rowIndex, c + 1).setValue(v === undefined || v === null ? '' : v);
  }
  // No read-back: callers are all RETURNS_DATA actions, so doPost reads the
  // whole dataset once instead of re-reading this sheet here.
  return null;
}

/**
 * JSON.stringify drops undefined, so a "clear the paid flag" patch arrives
 * without paid_date / paid_amount. Clear them explicitly, or the row would
 * keep a stale payment date next to paid = false.
 */
function normalizePaidPatch(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, 'paid') && !bool(patch.paid)) {
    patch.paid = false;
    patch.paid_date = '';
    patch.paid_amount = '';
  }
  return patch;
}

/** Deletes bottom-up so earlier row indices stay valid as rows are removed. */
function deleteRowsWhere(name, col, value) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return;
  var colIdx = SHEETS[name].indexOf(col);
  // Only the matched column is read, not the whole grid.
  var vals = sh.getRange(2, colIdx + 1, last - 1, 1).getValues();
  // Bottom-up so earlier row indices stay valid as rows are removed.
  for (var i = vals.length - 1; i >= 0; i--) {
    if (num(vals[i][0]) === num(value)) sh.deleteRow(i + 2);
  }
}

/** Reads only the id column, not every column of every row. */
function idColumn(name) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues();
}

function nextId(name) {
  var ids = idColumn(name);
  var max = 0;
  for (var i = 0; i < ids.length; i++) { var id = num(ids[i][0]); if (id > max) max = id; }
  return max + 1;
}

/** 1-based sheet row for an id, or -1. Reads only the id column. */
function findSheetRow(name, id) {
  var ids = idColumn(name);
  for (var i = 0; i < ids.length; i++) if (num(ids[i][0]) === num(id)) return i + 2;
  return -1;
}

function setCell(name, id, col, value) {
  var rowIndex = findSheetRow(name, id);
  if (rowIndex === -1) throw new Error(name + ' ' + id + ' not found');
  sheet(name).getRange(rowIndex, SHEETS[name].indexOf(col) + 1).setValue(value);
}

function getById(name, id) {
  var rows = readRows(name);
  for (var i = 0; i < rows.length; i++) if (num(rows[i].id) === num(id)) return coerce(name, rows[i]);
  return null;
}

function sumField(rows, field) {
  var t = 0;
  for (var i = 0; i < rows.length; i++) t += num(rows[i][field]);
  return t;
}

/** Rows of `name` belonging to this user. */
function readOwnedRows(name, uid) {
  var rows = readRows(name);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].user_id) === num(uid)) out.push(rows[i]);
  }
  return out;
}

/**
 * 1-based sheet row for a row the caller owns. Throws 'not found' when the row
 * is missing OR belongs to someone else — identical either way, so ids cannot be
 * probed for existence.
 *
 * Reads only the id and user_id columns, which are always the first two on owned
 * sheets, and returns the location so callers do not look the row up a second
 * time.
 */
/*
 * Deliberately says nothing about whether the row exists — see above. Now that
 * a backend message can reach a toast, it also has to read as a sentence rather
 * than as the bare 'not found' it used to be.
 */
var NOT_FOUND = 'That row was not found. It may have been changed in another tab.';

function ownedRowIndex(name, id, uid) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (num(vals[i][0]) === num(id)) {
        if (num(vals[i][1]) !== num(uid)) throw new Error(NOT_FOUND);
        return i + 2;
      }
    }
  }
  throw new Error(NOT_FOUND);
}

/** Ownership check where the row's position is not needed. */
function assertOwned(name, id, uid) {
  ownedRowIndex(name, id, uid);
}

/**
 * Mirrors MockApi.ts's load() self-heal step — every user gets the three
 * default columns the first time their data is read. No signup hook exists
 * to seed this at account creation, and every existing user needs it once
 * too.
 */
function ensureDefaultTaskColumns(uid) {
  var existing = readOwnedRows('task_columns', uid);
  if (existing.length > 0) return;

  // Two concurrent requests from the same user could both pass the check
  // above before either insert commits, producing duplicate default columns
  // (and more than one is_done column). Serialise, then re-check.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (readOwnedRows('task_columns', uid).length > 0) return;
    var rows = [
      { name: 'To Do', sort_order: 0, is_done: false },
      { name: 'In Progress', sort_order: 1, is_done: false },
      { name: 'Done', sort_order: 2, is_done: true }
    ];
    for (var i = 0; i < rows.length; i++) {
      appendRow('task_columns', {
        id: nextId('task_columns'),
        user_id: uid,
        name: rows[i].name,
        sort_order: rows[i].sort_order,
        is_done: rows[i].is_done
      });
    }
  } finally {
    lock.releaseLock();
  }
}

function getAll(uid) {
  ensureDefaultTaskColumns(uid);
  var data = {};
  DATA_SHEETS.forEach(function (name) {
    // Inactive sheets are reported as empty rather than read — see ACTIVE_SHEETS.
    if (ACTIVE_SHEETS.indexOf(name) === -1) { data[name] = []; return; }
    data[name] = readOwnedRows(name, uid).map(function (r) { return coerce(name, r); });
  });
  var user = userById(uid);
  data.settings = { currency: user ? user.currency : 'PHP' };
  return data;
}

/*
 * Every sheet served here is per-user: its second column is user_id and its
 * handlers go through readOwnedRows / assertOwned. Each module ticket adds its
 * own actions. Anything added here without an ownership check would let any
 * authenticated user read and write another user's rows.
 *
 * A foreign key needs its own check: the income handlers call assertOwnedSource
 * on source_id, because a request naming someone else's source would otherwise
 * read that source's name back through getAll.
 */
function dispatch(action, p, uid) {
  switch (action) {
    case 'getAll': return getAll(uid);
    case 'addDebt': return addDebt(p, uid);
    case 'updateDebt': return updateDebt(p, uid);
    case 'deleteDebt': return deleteDebt(p, uid);
    case 'addScheduleRow': return addChildRow('debt_schedule', p, uid);
    case 'updateScheduleRow': return updateDebtRow('debt_schedule', 'debt_schedule', p, uid);
    case 'deleteScheduleRow': return deleteDebtRow('debt_schedule', 'debt_schedule', p, uid);
    case 'addStatement': return addChildRow('debt_statements', p, uid);
    case 'updateStatement': return updateDebtRow('debt_statements', 'debt_statement', p, uid);
    case 'deleteStatement': return deleteDebtRow('debt_statements', 'debt_statement', p, uid);
    case 'addBill': return addBill(p, uid);
    case 'updateBill': return updateBill(p, uid);
    case 'closeBill': return closeBill(p, uid);
    case 'deleteBill': return deleteBill(p, uid);
    case 'updateBillPayable': return updateBillPayable(p, uid);
    case 'deleteBillPayable': return deleteBillPayable(p, uid);
    case 'payBillPayable': return payBillPayable(p, uid);
    case 'addIncome': return addIncome(p, uid);
    case 'updateIncome': return updateIncome(p, uid);
    case 'deleteIncome': return deleteIncome(p, uid);
    case 'addIncomeSource': return addIncomeSource(p, uid);
    case 'updateIncomeSource': return updateIncomeSource(p, uid);
    case 'deleteIncomeSource': return deleteIncomeSource(p, uid);
    case 'setCurrency': return setCurrency(p, uid);
    case 'addSavingsEntry': return addSavingsEntry(p, uid);
    case 'updateSavingsEntry': return updateSavingsEntry(p, uid);
    case 'deleteSavingsEntry': return deleteSavingsEntry(p, uid);
    case 'addTask': return addTask(p, uid);
    case 'updateTask': return updateTask(p, uid);
    case 'deleteTask': return deleteTask(p, uid);
    case 'moveTask': return moveTask(p, uid);
    case 'updateTaskColumn': return updateTaskColumn(p, uid);
    case 'addNote': return addNote(p, uid);
    case 'updateNote': return updateNote(p, uid);
    case 'deleteNote': return deleteNote(p, uid);
    case 'addNoteItem': return addNoteItem(p, uid);
    case 'updateNoteItem': return updateNoteItem(p, uid);
    case 'deleteNoteItem': return deleteNoteItem(p, uid);
    default: throw new Error('Unknown action: ' + action);
  }
}

function addDebt(p, uid) {
  var debt = { id: nextId('debts'), user_id: uid, name: p.name, type: p.type };
  appendRow('debts', debt);

  var target = p.type === 'fixed' ? 'debt_schedule' : 'debt_statements';
  var rows = p.rows || [];
  var baseId = nextId(target);
  var prepared = rows.map(function (row, i) {
    var copy = {};
    for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) copy[k] = row[k];
    copy.id = baseId + i;
    copy.user_id = uid;
    copy.debt_id = debt.id;
    return copy;
  });
  appendRows(target, prepared);

  return null; // RETURNS_DATA action — doPost reads the dataset back
}

function updateDebt(p, uid) {
  var rowIndex = ownedRowIndex('debts', p.id, uid);
  sheet('debts').getRange(rowIndex, SHEETS.debts.indexOf('name') + 1).setValue(p.patch.name);
  return null;
}

/** Ids of `name` rows belonging to this debt/bill, read from the owned rows. */
function ownedIdsWhere(name, uid, col, value) {
  var rows = readOwnedRows(name, uid);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i][col]) === num(value)) out.push(num(rows[i].id));
  }
  return out;
}

function deleteDebt(p, uid) {
  var rowIndex = ownedRowIndex('debts', p.id, uid);
  // Unsettle every child row's ledger entry BEFORE the cascade deletes the
  // rows themselves, so a failure here cannot leave the settled rows gone with
  // the ledger rows still present.
  unsettleManyFromSavings(uid, 'debt_schedule', ownedIdsWhere('debt_schedule', uid, 'debt_id', p.id));
  unsettleManyFromSavings(uid, 'debt_statement', ownedIdsWhere('debt_statements', uid, 'debt_id', p.id));
  deleteRowsWhere('debt_schedule', 'debt_id', p.id);
  deleteRowsWhere('debt_statements', 'debt_id', p.id);
  sheet('debts').deleteRow(rowIndex);
  return null;
}

function addChildRow(name, p, uid) {
  assertOwned('debts', p.debtId, uid); // the parent debt must be yours
  var row = {};
  for (var k in p.input) if (Object.prototype.hasOwnProperty.call(p.input, k)) row[k] = p.input[k];
  row.id = nextId(name);
  row.user_id = uid;
  row.debt_id = p.debtId;
  appendRow(name, row);
  return null;
}

function updateChildRow(name, p, uid) {
  var rowIndex = ownedRowIndex(name, p.id, uid);
  return patchRowAt(name, rowIndex, normalizePaidPatch(p.patch));
}

/*
 * A debt row's payment travels through the same generic update as an edit, so
 * this decides which one is happening. Bills have a dedicated payBillPayable and
 * need no equivalent.
 *
 * sheetName is the tab; refType is what savings_ledger stores, and the two
 * differ for statements (debt_statements vs debt_statement).
 */
function updateDebtRow(sheetName, refType, p, uid) {
  // Authorize before reading the ledger or refusing anything. Costs one extra
  // narrow two-column read on top of updateChildRow's own, which is the price of
  // deciding before the patch.
  assertOwned(sheetName, p.id, uid);
  var patch = p.patch || {};
  var hasPaid = Object.prototype.hasOwnProperty.call(patch, 'paid');
  // Classified by TRANSITION, not by payload: the two form modals always
  // re-send paid/paid_date/paid_amount on an already-paid row, so a payload-only
  // read of `paid: true` would misclassify a plain edit as a re-pay.
  var current = getById(sheetName, p.id);
  var wasPaid = bool(current && current.paid);
  var unpaying = hasPaid && !bool(patch.paid) && wasPaid;
  var paying = hasPaid && bool(patch.paid) && !wasPaid;

  /*
   * The reversal fires on the PAYLOAD, not the transition — see the same note in
   * updateBillPayable. A row left unpaid with its ledger row still present (an
   * un-pay that failed after the patch) would otherwise be unrecoverable.
   */
  if (hasPaid && !bool(patch.paid)) {
    var undone = updateChildRow(sheetName, p, uid);
    unsettleFromSavings(uid, refType, p.id);
    return undone;
  }

  if (paying) {
    // Validate before the patch, so a bad amount/date, an insufficient
    // balance, or a re-pay of a row already funded from savings leaves the
    // sheet untouched.
    var signed = null;
    if (p.from_savings === true) {
      signed = prepareSettleFromSavings(uid, refType, p.id, patch.paid_date, patch.paid_amount);
    } else {
      assertNotSavingsFunded(uid, refType, p.id);
    }
    var paidResult = updateChildRow(sheetName, p, uid);
    if (signed !== null) {
      appendSavingsPayment(uid, refType, p.id, patch.paid_date, signed);
    }
    return paidResult;
  }

  // An edit — including a harmless re-send of the SAME paid/paid_date/paid_amount
  // on an already-paid row. Only a genuine CHANGE to the payment's own figures
  // can desync the ledger; editing the installment amount or the due date
  // cannot, and re-sending identical values must not be refused either.
  if (paidAmountChanged(patch, current) || paidDateChanged(patch, current)) {
    assertNotSavingsFunded(uid, refType, p.id);
  }
  return updateChildRow(sheetName, p, uid);
}

/**
 * Whether patch actually changes paid_amount / paid_date, compared by VALUE
 * rather than by key presence — a caller re-sending the identical figure must
 * not trip a refusal meant for an actual change. paid_amount compares
 * numerically; paid_date compares as a string, matching how it is stored.
 */
function paidAmountChanged(patch, current) {
  if (!Object.prototype.hasOwnProperty.call(patch, 'paid_amount')) return false;
  var newVal = patch.paid_amount;
  var oldVal = current ? current.paid_amount : undefined;
  if (blank(newVal) && blank(oldVal)) return false;
  if (blank(newVal) !== blank(oldVal)) return true;
  return Number(newVal) !== Number(oldVal);
}

function paidDateChanged(patch, current) {
  if (!Object.prototype.hasOwnProperty.call(patch, 'paid_date')) return false;
  var newVal = patch.paid_date;
  var oldVal = current ? current.paid_date : undefined;
  if (blank(newVal) && blank(oldVal)) return false;
  if (blank(newVal) !== blank(oldVal)) return true;
  return String(newVal) !== String(oldVal);
}

function deleteChildRow(name, p, uid) {
  sheet(name).deleteRow(ownedRowIndex(name, p.id, uid));
  return null;
}

/*
 * Parameterised on the same (sheetName, refType) pair updateDebtRow takes — the
 * statement's ref_type is singular while its sheet is plural. Unsettle before
 * the delete, so a failure cannot leave the row gone with its ledger row behind.
 */
function deleteDebtRow(sheetName, refType, p, uid) {
  assertOwned(sheetName, p.id, uid);
  unsettleFromSavings(uid, refType, p.id);
  return deleteChildRow(sheetName, p, uid);
}

/**
 * The caller's own bill, refused when closed. Every bill write goes through
 * here: the frontend hides the actions on a closed bill, but a stale tab must
 * not be able to slip one past.
 */
function openBill(id, uid) {
  // Returns the row's position too, so a caller that goes on to patch it does
  // not look the same row up a second time — the pattern ownedRowIndex exists for.
  var rowIndex = ownedRowIndex('bills', id, uid);
  var bill = getById('bills', id);
  if (!bill) throw new Error('not found');
  if (bill.closed) throw new Error('That bill is closed.');
  return { bill: bill, rowIndex: rowIndex };
}

/** A payable's sheet row and coerced values, plus its parent bill — all checked. */
function ownedPayable(id, uid) {
  var rowIndex = ownedRowIndex('bill_payables', id, uid);
  var row = getById('bill_payables', id);
  return { rowIndex: rowIndex, row: row, bill: openBill(row.bill_id, uid).bill };
}

/** The payable a new bill or a payment starts from. */
function newPayable(bill, uid, dueDate) {
  return {
    id: nextId('bill_payables'),
    user_id: uid,
    bill_id: bill.id,
    due_date: dueDate,
    // Blank for a variable bill: its figure is unknown until the statement
    // arrives, and blank coerces back to undefined rather than to zero.
    amount: bill.type === 'fixed' && bill.amount !== undefined && bill.amount !== null ? bill.amount : '',
    paid: false
  };
}

function addBill(p, uid) {
  var bill = {
    id: nextId('bills'),
    user_id: uid,
    name: p.name,
    type: p.type,
    frequency: p.frequency,
    amount: blank(p.amount) ? '' : p.amount,
    day: p.day,
    second_day: blank(p.second_day) ? '' : p.second_day,
    month: blank(p.month) ? '' : p.month,
    closed: false
  };
  appendRow('bills', bill);
  appendRow('bill_payables', newPayable({ id: bill.id, type: p.type, amount: p.amount }, uid, p.first_due_date));
  return null; // RETURNS_DATA action — doPost reads the dataset back
}

/**
 * JSON.stringify drops undefined, so a patch that clears an optional field
 * arrives without it. Blank those explicitly, or the row would keep a value
 * from the shape it had before — a monthly bill holding the second_day of the
 * bi-monthly schedule it used to be.
 */
function normalizeBillPatch(patch) {
  var optional = ['amount', 'second_day', 'month'];
  for (var i = 0; i < optional.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(patch, optional[i])) patch[optional[i]] = '';
  }
  return patch;
}

function updateBill(p, uid) {
  var found = openBill(p.id, uid);
  return patchRowAt('bills', found.rowIndex, normalizeBillPatch(p.patch || {}));
}

function closeBill(p, uid) {
  openBill(p.id, uid);
  deleteUnpaidPayables(uid, p.id);
  setCell('bills', p.id, 'closed', true);
  return null;
}

/**
 * Deletes this bill's unpaid payables, optionally sparing one. Deletes bottom-up
 * so earlier row indices stay valid as rows are removed.
 *
 * Pass exceptId when undoing a payment: the row being unpaid must survive while
 * the payable that payment minted goes. Closing a bill spares nothing.
 */
/*
 * Takes uid so it can unsettle: closeBill and the un-mint path both delete
 * unpaid payables, and a payable can be unpaid while still carrying a ledger row
 * (an un-pay that failed after the patch). Deleting it without unsettling leaves
 * that row orphaned with a dangling ref_id, which FT-3's read-only rule makes
 * unfixable from the Savings page.
 */
function deleteUnpaidPayables(uid, billId, exceptId) {
  var sh = sheet('bill_payables');
  var last = sh.getLastRow();
  if (last < 2) return;
  var headers = SHEETS.bill_payables;
  var vals = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var idCol = headers.indexOf('id');
  var billCol = headers.indexOf('bill_id');
  var paidCol = headers.indexOf('paid');
  var doomed = [];
  for (var i = vals.length - 1; i >= 0; i--) {
    if (num(vals[i][billCol]) !== num(billId)) continue;
    if (exceptId !== undefined && num(vals[i][idCol]) === num(exceptId)) continue;
    if (bool(vals[i][paidCol])) continue;
    doomed.push(num(vals[i][idCol]));
  }
  // Unsettle before deleting, in one ledger read, so a failure cannot leave the
  // payables gone with their ledger rows behind.
  unsettleManyFromSavings(uid, 'bill_payable', doomed);
  for (var d = vals.length - 1; d >= 0; d--) {
    if (num(vals[d][billCol]) !== num(billId)) continue;
    if (exceptId !== undefined && num(vals[d][idCol]) === num(exceptId)) continue;
    if (!bool(vals[d][paidCol])) sh.deleteRow(d + 2);
  }
}

function deleteBill(p, uid) {
  var rowIndex = ownedRowIndex('bills', p.id, uid);
  // Unsettle every payable's ledger entry BEFORE the cascade deletes the
  // payables themselves, so a failure here cannot leave the payables gone
  // with the ledger rows still present.
  unsettleManyFromSavings(uid, 'bill_payable', ownedIdsWhere('bill_payables', uid, 'bill_id', p.id));
  deleteRowsWhere('bill_payables', 'bill_id', p.id);
  sheet('bills').deleteRow(rowIndex);
  return null;
}

function updateBillPayable(p, uid) {
  var found = ownedPayable(p.id, uid);
  var patch = normalizePaidPatch(p.patch || {});
  // An omitted amount means "not set yet" — clear the cell rather than keep the
  // figure that was there.
  if (!Object.prototype.hasOwnProperty.call(patch, 'amount')) patch.amount = '';
  /*
   * Undoing a payment un-mints the payable that payment created — the inverse of
   * the mint in payBillPayable.
   *
   * Decided before the patch, which is what makes "was this row paid" answerable.
   * The paid key must be present AND false: an omitted paid means "leave it
   * alone", and reading that as false would un-mint on a patch that only set an
   * amount.
   */
  // Classified by TRANSITION, not by payload: `unpaying` requires the row to
  // have BEEN paid, not merely that the patch sets paid to false — otherwise a
  // patch on an already-unpaid row would be misread as an un-pay.
  var hasPaid = Object.prototype.hasOwnProperty.call(patch, 'paid');
  var unpaying = hasPaid && !bool(patch.paid) && bool(found.row.paid);
  /*
   * The reversal fires on the PAYLOAD, not the transition. If a previous un-pay
   * patched the row unpaid and then failed before unsettling, the row is unpaid
   * with its ledger row still present — and a transition-based test would make
   * every later un-pay a no-op, leaving no way to clear it: paying is refused
   * because the ref is settled, and un-paying does nothing. Reversing on the
   * payload makes re-submitting the un-pay the recovery. unsettleFromSavings is
   * a no-op when there is no row, so this is safe on an ordinary edit.
   */
  var reversing = hasPaid && !bool(patch.paid);
  var unmint = bool(found.row.paid) && unpaying && isLatestPaidPayable(found.bill.id, found.row);
  // Before patchRowAt, while "was this row paid" is still answerable. Compared
  // by VALUE, not key presence: PayableFormModal always re-sends paid_amount
  // and paid_date on an already-paid row, and a caller re-sending the identical
  // figure must not be refused.
  if (!unpaying) {
    if (paidAmountChanged(patch, found.row) || paidDateChanged(patch, found.row)) {
      assertNotSavingsFunded(uid, 'bill_payable', found.row.id);
    }
  }
  // Patch first, so found.rowIndex is still valid when it is used — the deletion
  // shifts indices, and nothing may rely on that index afterwards.
  var result = patchRowAt('bill_payables', found.rowIndex, patch);
  if (unmint) deleteUnpaidPayables(uid, found.bill.id, found.row.id);
  // Un-paying reverses both halves — the escape hatch for a savings-funded
  // payment, since editing its amount is refused. After the patch so a failure
  // cannot credit savings for a payment still recorded as paid.
  if (reversing) unsettleFromSavings(uid, 'bill_payable', found.row.id);
  return result;
}

function deleteBillPayable(p, uid) {
  var found = ownedPayable(p.id, uid);
  // Before the delete: if unsettling throws, the payable and its ledger row
  // both survive, rather than deleting first and risking an orphan.
  unsettleFromSavings(uid, 'bill_payable', found.row.id);
  sheet('bill_payables').deleteRow(found.rowIndex);
  return null;
}

/**
 * Whether this paid payable is the most recent paid one for its bill, and so the
 * one whose payment minted the payable now open.
 *
 * Only that payment has something to un-mint. An older one minted the payable
 * that has since been paid itself, so undoing it must leave the open payable
 * alone — deleting it would discard a figure the user entered, and would let the
 * re-payment mint a duplicate of a month already paid.
 *
 * Compared by due date, which is ISO and so orders lexicographically.
 */
function isLatestPaidPayable(billId, payable) {
  var rows = readRows('bill_payables');
  var due = fmtDate(payable.due_date);
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].bill_id) !== num(billId)) continue;
    if (num(rows[i].id) === num(payable.id)) continue;
    if (!bool(rows[i].paid)) continue;
    if (fmtDate(rows[i].due_date) > due) return false;
  }
  return true;
}

/** Whether this bill has an unpaid payable other than `exceptId`. */
function hasOtherUnpaidPayable(billId, exceptId) {
  var rows = readRows('bill_payables');
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].bill_id) !== num(billId)) continue;
    if (num(rows[i].id) === num(exceptId)) continue;
    if (!bool(rows[i].paid)) return true;
  }
  return false;
}

function payBillPayable(p, uid) {
  var found = ownedPayable(p.id, uid);
  var input = p.input || {};
  // Validate BEFORE anything is written, so a bad amount/date or an
  // insufficient balance — or a re-pay of a row already funded from savings —
  // leaves the sheet completely untouched.
  var signed = null;
  if (input.from_savings === true) {
    signed = prepareSettleFromSavings(uid, 'bill_payable', found.row.id, input.paid_date, input.paid_amount);
  } else {
    // A stale tab could re-pay a row already funded from savings; that would
    // desync the amount from the ledger row.
    assertNotSavingsFunded(uid, 'bill_payable', found.row.id);
  }
  patchRowAt('bill_payables', found.rowIndex, {
    paid: true,
    paid_date: input.paid_date,
    paid_amount: input.paid_amount
  });
  // Minted BEFORE the settle: a late failure writing the ledger row must not
  // kill the bill's recurrence by leaving the payable paid with no successor.
  // Patch stays before both — settling first would strand an undeletable
  // ledger row against a payable not yet marked paid.
  //
  // Mint only when nothing else is outstanding, so a double-submitted Pay
  // cannot leave two competing upcoming rows.
  if (!hasOtherUnpaidPayable(found.bill.id, found.row.id)) {
    appendRow('bill_payables', newPayable(found.bill, uid, input.next_due_date));
  }
  if (signed !== null) {
    appendSavingsPayment(uid, 'bill_payable', found.row.id, input.paid_date, signed);
  }
  return null;
}

/**
 * The caller's own source. Every income write goes through here: a crafted
 * request naming someone else's source_id would otherwise read that source's
 * name back through getAll.
 */
function assertOwnedSource(sourceId, uid) {
  if (blank(sourceId)) throw new Error('An income entry needs a source');
  assertOwned('income_sources', sourceId, uid);
}

/**
 * A date and a usable amount. The frontend marks both fields required, but a
 * blank date writes a row no month window matches — invisible on every screen,
 * so unreachable for edit or delete while still sitting in the sheet.
 */
function assertIncomeDate(date) {
  if (blank(date)) throw new Error('An income entry needs a date');
}

function assertIncomeAmount(amount) {
  var n = Number(amount);
  if (blank(amount) || isNaN(n)) throw new Error('An income entry needs an amount');
  if (n < 0) throw new Error('An income amount cannot be negative');
}

function addIncome(p, uid) {
  var input = p.input || {};
  assertOwnedSource(input.source_id, uid);
  assertIncomeDate(input.date);
  assertIncomeAmount(input.amount);
  appendRow('income', {
    id: nextId('income'),
    user_id: uid,
    source_id: input.source_id,
    amount: input.amount,
    date: input.date,
    notes: input.notes
  });
  return null;
}

/*
 * Fields are copied one-by-one, not forwarded wholesale, because each one
 * needs its own validator run before it's accepted: assertOwnedSource,
 * assertIncomeAmount and assertIncomeDate. A blanket copy of given into patch
 * would let any of them through unchecked.
 */
function updateIncome(p, uid) {
  var rowIndex = ownedRowIndex('income', p.id, uid);
  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'source_id')) {
    assertOwnedSource(given.source_id, uid);
    patch.source_id = given.source_id;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'amount')) {
    assertIncomeAmount(given.amount);
    patch.amount = given.amount;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'date')) {
    assertIncomeDate(given.date);
    patch.date = given.date;
  }
  // null is how the client clears notes, and patchRowAt writes both null and
  // undefined as a blank cell — which coerce reads back as undefined, the
  // model's "no notes". So no conversion is needed here.
  if (Object.prototype.hasOwnProperty.call(given, 'notes')) patch.notes = given.notes;
  return patchRowAt('income', rowIndex, patch);
}

function deleteIncome(p, uid) {
  var rowIndex = ownedRowIndex('income', p.id, uid);
  sheet('income').deleteRow(rowIndex);
  return null;
}

function addIncomeSource(p, uid) {
  var input = p.input || {};
  var name = String(input.name || '').trim();
  if (!name) throw new Error('A source needs a name');
  appendRow('income_sources', {
    id: nextId('income_sources'),
    user_id: uid,
    name: name,
    archived: false
  });
  return null;
}

function updateIncomeSource(p, uid) {
  var rowIndex = ownedRowIndex('income_sources', p.id, uid);
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(p.patch || {}, 'name')) {
    var name = String(p.patch.name || '').trim();
    if (!name) throw new Error('A source needs a name');
    patch.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(p.patch || {}, 'archived')) {
    patch.archived = p.patch.archived === true;
  }
  return patchRowAt('income_sources', rowIndex, patch);
}

/** Deleted only when unused. A used source is archived instead, never cascaded. */
function deleteIncomeSource(p, uid) {
  var rowIndex = ownedRowIndex('income_sources', p.id, uid);
  var rows = readOwnedRows('income', uid);
  var used = 0;
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].source_id) === num(p.id)) used++;
  }
  if (used > 0) {
    throw new Error(used + (used === 1 ? ' entry uses' : ' entries use') + ' that source. Archive it instead.');
  }
  sheet('income_sources').deleteRow(rowIndex);
  return null;
}

function setCurrency(p, uid) {
  setCell('users', uid, 'currency', p.currency);
  return null;
}

/**
 * The stored amount is signed; the input is a positive magnitude, so the kind
 * and the sign cannot disagree. MockApi and lib/savings.ts convert identically.
 */
function signedSavingsAmount(kind, magnitude) {
  var size = Math.abs(Number(magnitude));
  return kind === 'withdrawal' ? -size : size;
}

/** Only the two kinds a user creates. FT-4 writes the payment kinds itself. */
function assertMovementKind(kind) {
  if (kind !== 'deposit' && kind !== 'withdrawal') {
    throw new Error('A savings movement must be a deposit or a withdrawal');
  }
}

function assertSavingsDate(date) {
  if (blank(date)) throw new Error('A savings movement needs a date');
}

function assertSavingsAmount(amount) {
  var n = Number(amount);
  if (blank(amount) || isNaN(n)) throw new Error('A savings movement needs an amount');
  if (n <= 0) throw new Error('Enter a positive amount and pick deposit or withdrawal');
}

/**
 * The caller's rows, read ONCE. Both the below-zero guard and the row being
 * edited come out of the same read: ownedRowIndex already gave us the sheet
 * position from a narrow two-column read, so calling getById as well would be
 * a third trip for a row this array already contains.
 */
function ownedSavingsRows(uid) {
  return readOwnedRows('savings_ledger', uid);
}

/** Today in the SPREADSHEET's timezone, so it compares against stored dates. */
function isoToday() {
  return Utilities.formatDate(new Date(), ss().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/** The exact current instant, for audit timestamps like Task.created_at —
 *  unlike isoToday, deliberately NOT spreadsheet-timezone-formatted, since
 *  this records a moment, not a calendar day. */
function isoNow() {
  return new Date().toISOString();
}

/*
 * The as-of-today balance after optionally replacing one row: money you actually
 * have. A movement dated for a future payday is stored but not counted, so it
 * cannot fund a withdrawal now — the hole a plain all-rows sum left open.
 *
 * Still ONE sum, not a walk through the sequence. A backdated row changes this
 * total and nothing else, so the "final balance, not every intermediate point"
 * rule is untouched.
 *
 * `replacement` is {date, amount} for an add or an edit, or null for a delete.
 * Old and new versions each count only once their own date has arrived, which is
 * why moving a row into or out of the future shifts the balance by one side of
 * the pair rather than both.
 *
 * KNOWN LIMITATION: this guards the CURRENT balance, so a movement dated in the
 * future is not checked against the balance on its own date. Recording a
 * withdrawal of 1000 next month against 100 today is accepted, and the balance
 * goes negative when that date arrives. Guarding it would need the per-date walk
 * this design rejected — and it is visible on the card the moment it lands,
 * unlike the hole it replaces, where a future deposit funded a real withdrawal
 * today.
 */
function savingsBalanceAfter(rows, excludeId, replacement) {
  var today = isoToday();
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    if (excludeId !== null && num(rows[i].id) === num(excludeId)) continue;
    if (fmtDate(rows[i].date) <= today) total += num(rows[i].amount);
  }
  if (replacement && String(replacement.date) <= today) total += Number(replacement.amount);
  return total;
}

function findSavingsRow(rows, id) {
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].id) === num(id)) return coerce('savings_ledger', rows[i]);
  }
  throw new Error('not found');
}

/**
 * Refused on the FINAL balance, not on any intermediate point. A backdated
 * withdrawal may make older rows' running balance dip while the sum stays
 * valid; that is permitted, because movements are often entered out of order
 * and a user cannot locate which historical row a refusal refers to.
 */
/*
 * Compared in CENTS. 0.70 + 0.10 sums to 0.7999999999999999 in floating point,
 * so withdrawing the full 0.80 lands at -1.1e-16 and a raw `< 0` refuses a
 * write the user can plainly see is valid — with an unreadable number in the
 * message. Math.round(x * 100) is the same guard debtSchedule.ts already uses.
 *
 * The balance is formatted too: it reaches the user through a toast now, and
 * `13.5` reads as broken next to every other figure in the app.
 */
function assertNotBelowZero(balance) {
  if (Math.round(balance * 100) < 0) {
    throw new Error(
      'That would put savings below zero. The balance as of today is ' + Number(balance).toFixed(2) + '.'
    );
  }
}

/**
 * A payment row belongs to the bill or debt it settled: editing it here would
 * desync the two. Unreachable until FT-4 writes the payment kinds.
 */
function assertNotPaymentRow(row) {
  if (row && (row.kind === 'bill_payment' || row.kind === 'debt_payment')) {
    throw new Error('That movement settled a bill or debt. Change it there instead.');
  }
}

/*
 * The kind a settled row's payment is recorded under. Keyed by ref_type, whose
 * statement value is SINGULAR (debt_statement) while its sheet is plural
 * (debt_statements) — SavingsRefType in src/types.ts is the authority.
 */
var PAYMENT_KIND = {
  bill_payable: 'bill_payment',
  debt_schedule: 'debt_payment',
  debt_statement: 'debt_payment'
};

/*
 * The caller's ledger row for a settled row, plus the rows it was found in so a
 * caller needing the balance does not read the sheet twice.
 *
 * Scoped to readOwnedRows, so a crafted ref_id can never reach another user's
 * ledger — ref_id is not an id this user owns, it is a foreign key they supply.
 */
function savingsRefRow(uid, refType, refId) {
  var rows = readOwnedRows('savings_ledger', uid);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].ref_type) === refType && num(rows[i].ref_id) === num(refId)) {
      return { row: coerce('savings_ledger', rows[i]), rows: rows };
    }
  }
  return { row: null, rows: rows };
}

/*
 * Validates a savings-funded payment and returns the signed amount the write
 * will use. ONE ledger read, and it does every check: already-settled, date,
 * amount, and the below-zero guard.
 *
 * Called BEFORE anything is written, so the common refusals leave the sheet
 * untouched — a late throw used to record the payment and skip minting the next
 * payable, killing a bill's recurrence.
 *
 * This is the single home for that validation. appendSavingsPayment below does
 * no checking of its own precisely because this ran first; the two used to
 * duplicate all four checks and read the ledger twice between them.
 *
 * A retried Pay is REFUSED here, not absorbed — the already-settled branch
 * throws rather than returning quietly. That is what stops a double-submit
 * appending two ledger rows and deducting savings twice, and it is also what
 * enforces one-source-per-payment: a second call for the same ref cannot add a
 * second row. Do not weaken the caller-side guards on the belief that retries
 * pass through harmlessly.
 */
function prepareSettleFromSavings(uid, refType, refId, paidDate, paidAmount) {
  var found = savingsRefRow(uid, refType, refId);
  if (found.row) {
    throw new Error(
      'That payment came from savings (' +
        Number(Math.abs(found.row.amount)).toFixed(2) +
        '). Un-pay it first, then pay again.'
    );
  }
  assertSavingsDate(paidDate);
  assertSavingsAmount(paidAmount);
  var signed = -Math.abs(Number(paidAmount));
  // The as-of-today rule and the cents comparison both come from FT-3 unchanged.
  assertNotBelowZero(savingsBalanceAfter(found.rows, null, { date: paidDate, amount: signed }));
  return signed;
}

/*
 * Writes the row prepareSettleFromSavings validated. No reads and no checks:
 * repeating them would be another ledger round trip for an answer this request
 * already has.
 */
function appendSavingsPayment(uid, refType, refId, paidDate, signed) {
  appendRow('savings_ledger', {
    id: nextId('savings_ledger'),
    user_id: uid,
    date: paidDate,
    amount: signed,
    kind: PAYMENT_KIND[refType],
    ref_type: refType,
    ref_id: refId,
    notes: ''
  });
}

/** Returns the money. A no-op when the payment was not savings-funded. */
function unsettleFromSavings(uid, refType, refId) {
  var found = savingsRefRow(uid, refType, refId);
  if (!found.row) return;
  sheet('savings_ledger').deleteRow(ownedRowIndex('savings_ledger', found.row.id, uid));
}

/*
 * Drops every ledger row settling one of `refIds`, in ONE read and one
 * bottom-up pass.
 *
 * The per-child alternative re-read the whole ledger for each child: a bill with
 * 24 payables meant 24 reads, and each read is a separate round trip on a
 * platform charging over a second of fixed overhead per request.
 *
 * Bottom-up so an earlier deletion cannot shift a row still to be removed.
 */
function unsettleManyFromSavings(uid, refType, refIds) {
  if (!refIds.length) return;
  var sh = sheet('savings_ledger');
  var last = sh.getLastRow();
  if (last < 2) return;
  var headers = SHEETS.savings_ledger;
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var userCol = headers.indexOf('user_id');
  var typeCol = headers.indexOf('ref_type');
  var idCol = headers.indexOf('ref_id');
  var wanted = {};
  for (var i = 0; i < refIds.length; i++) wanted[String(num(refIds[i]))] = true;
  for (var r = values.length - 1; r >= 0; r--) {
    if (num(values[r][userCol]) !== num(uid)) continue;
    if (String(values[r][typeCol]) !== refType) continue;
    if (!wanted[String(num(values[r][idCol]))]) continue;
    sh.deleteRow(r + 2);
  }
}

/*
 * Refuses a change that would leave a savings-funded payment disagreeing with
 * its ledger row. Un-paying is the sanctioned way out — see the reversal
 * decision in the spec — so this fires only for a re-pay or an amount edit.
 */
function assertNotSavingsFunded(uid, refType, refId) {
  var found = savingsRefRow(uid, refType, refId);
  if (found.row) {
    throw new Error(
      'That payment came from savings (' +
        Number(Math.abs(found.row.amount)).toFixed(2) +
        '). Un-pay it first, then pay again.'
    );
  }
}

function addSavingsEntry(p, uid) {
  var input = p.input || {};
  assertMovementKind(input.kind);
  assertSavingsDate(input.date);
  assertSavingsAmount(input.amount);
  var signed = signedSavingsAmount(input.kind, input.amount);
  assertNotBelowZero(savingsBalanceAfter(ownedSavingsRows(uid), null, { date: input.date, amount: signed }));
  appendRow('savings_ledger', {
    id: nextId('savings_ledger'),
    user_id: uid,
    date: input.date,
    amount: signed,
    kind: input.kind,
    ref_type: '',
    ref_id: '',
    notes: input.notes
  });
  return null;
}

/*
 * Whitelisted, not forwarded. patchRowAt skips only the id columns, so an
 * unfiltered patch would let a client write ref_type and ref_id — which is how
 * FT-4 ties a ledger row to the payment it settled. The same hole FT-2 had to
 * close after review.
 */
function updateSavingsEntry(p, uid) {
  var rowIndex = ownedRowIndex('savings_ledger', p.id, uid);
  var rows = ownedSavingsRows(uid);
  var row = findSavingsRow(rows, p.id);
  assertNotPaymentRow(row);

  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'date')) {
    assertSavingsDate(given.date);
    patch.date = given.date;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'notes')) {
    // null and undefined both reach patchRowAt as a blank cell, which coerce
    // reads back as undefined.
    patch.notes = given.notes;
  }

  /*
   * Kind and amount move together: either one changes the signed value, and
   * editing a deposit into a withdrawal moves the balance by twice the amount.
   */
  var hasKind = Object.prototype.hasOwnProperty.call(given, 'kind');
  var hasAmount = Object.prototype.hasOwnProperty.call(given, 'amount');
  var kind = hasKind ? given.kind : row.kind;
  var magnitude = hasAmount ? given.amount : Math.abs(Number(row.amount));
  if (hasKind || hasAmount) {
    assertMovementKind(kind);
    assertSavingsAmount(magnitude);
    patch.kind = kind;
    patch.amount = signedSavingsAmount(kind, magnitude);
  }

  /*
   * Checked on EVERY edit, not only when kind or amount changed. Now that the
   * balance counts only rows whose date has arrived, moving a withdrawal from
   * next week to today lowers the balance without touching its amount.
   */
  var effectiveDate = patch.date !== undefined ? patch.date : fmtDate(row.date);
  assertNotBelowZero(
    savingsBalanceAfter(rows, p.id, {
      date: effectiveDate,
      amount: signedSavingsAmount(kind, magnitude)
    })
  );
  return patchRowAt('savings_ledger', rowIndex, patch);
}

/* Deleting a deposit LOWERS the balance, so delete is subject to the same
 * check as a write rather than exempt from it. */
function deleteSavingsEntry(p, uid) {
  var rowIndex = ownedRowIndex('savings_ledger', p.id, uid);
  var rows = ownedSavingsRows(uid);
  var row = findSavingsRow(rows, p.id);
  assertNotPaymentRow(row);
  assertNotBelowZero(savingsBalanceAfter(rows, p.id, null));
  sheet('savings_ledger').deleteRow(rowIndex);
  return null;
}

function addTask(p, uid) {
  var input = p.input || {};
  if (blank(input.title)) throw new Error('A task needs a title');
  if (blank(input.column_id)) throw new Error('A task needs a column');
  assertOwned('task_columns', input.column_id, uid);
  if (!blank(input.note_id)) assertOwned('notes', input.note_id, uid);
  appendRow('tasks', {
    id: nextId('tasks'),
    user_id: uid,
    title: input.title,
    notes: input.notes,
    date: input.date,
    recurrence: input.recurrence,
    column_id: input.column_id,
    completed_date: '',
    note_id: input.note_id,
    created_at: isoNow()
  });
  return null;
}

function updateTask(p, uid) {
  var rowIndex = ownedRowIndex('tasks', p.id, uid);
  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'title')) {
    if (blank(given.title)) throw new Error('A task needs a title');
    patch.title = given.title;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'notes')) patch.notes = given.notes;
  if (Object.prototype.hasOwnProperty.call(given, 'recurrence')) patch.recurrence = given.recurrence;
  if (Object.prototype.hasOwnProperty.call(given, 'note_id')) {
    if (!blank(given.note_id)) assertOwned('notes', given.note_id, uid);
    patch.note_id = given.note_id;
  }
  return patchRowAt('tasks', rowIndex, patch);
}

function deleteTask(p, uid) {
  var rowIndex = ownedRowIndex('tasks', p.id, uid);
  sheet('tasks').deleteRow(rowIndex);
  return null;
}

/**
 * The one action for every column change — drag or button, done or not.
 * Moving into the done column sets completed_date and, the first time this
 * row does so, mints the next occurrence for a recurring task (the CLIENT
 * computes both dates, same split payBillPayable already uses) — recurred
 * then stays true so a later re-entry into Done never mints a duplicate.
 * Moving to any other column just updates column_id and clears
 * completed_date.
 */
function moveTask(p, uid) {
  var rowIndex = ownedRowIndex('tasks', p.id, uid);
  var current = getById('tasks', p.id);
  var input = p.input || {};
  if (blank(input.column_id)) throw new Error('A column is required');
  assertOwned('task_columns', input.column_id, uid);
  var column = getById('task_columns', input.column_id);
  if (!column) throw new Error('That column was not found. It may have been deleted.');
  // A drop that neither changes the column nor assigns a date is a true
  // no-op, not a re-completion. Without the date half of this check, a
  // Backlog task dropped back onto the column it already (nominally) has —
  // the common case, since every new task defaults into the first column —
  // would silently skip the date assignment the drop was for.
  var dateChanging = !blank(input.date) && String(input.date) !== String(current.date || '');
  if (num(current.column_id) === num(input.column_id) && !dateChanging) return null;
  var patch = { column_id: input.column_id };
  if (!blank(input.date)) patch.date = input.date;
  if (bool(column.is_done)) {
    if (blank(input.completed_date)) throw new Error('A completed task needs a date');
    patch.completed_date = input.completed_date;
    // recurred, once true, is never cleared — cycling a recurring task out
    // of Done and back in must not mint a second successor for what is
    // still the same occurrence.
    var shouldMint = !blank(current.recurrence) && !blank(input.next_date) && !bool(current.recurred);
    if (shouldMint) patch.recurred = true;
    patchRowAt('tasks', rowIndex, patch);
    if (shouldMint) {
      var firstCol = firstTaskColumn(uid);
      appendRow('tasks', {
        id: nextId('tasks'),
        user_id: uid,
        title: current.title,
        notes: current.notes,
        date: input.next_date,
        recurrence: current.recurrence,
        column_id: firstCol.id,
        completed_date: '',
        note_id: current.note_id,
        created_at: isoNow()
      });
    }
  } else {
    patch.completed_date = '';
    patchRowAt('tasks', rowIndex, patch);
  }
  return null;
}

/** Whichever of this user's columns sorts first — where a new/minted task lands. */
function firstTaskColumn(uid) {
  var rows = readOwnedRows('task_columns', uid).map(function (r) { return coerce('task_columns', r); });
  rows.sort(function (a, b) { return a.sort_order - b.sort_order; });
  if (rows.length === 0) throw new Error('No columns — task_columns is empty.');
  return rows[0];
}

function updateTaskColumn(p, uid) {
  var rowIndex = ownedRowIndex('task_columns', p.id, uid);
  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'name')) {
    var name = String(given.name || '').trim();
    if (!name) throw new Error('A column needs a name');
    patch.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'sort_order')) patch.sort_order = given.sort_order;
  return patchRowAt('task_columns', rowIndex, patch);
}

function addNote(p, uid) {
  var input = p.input || {};
  appendRow('notes', {
    id: nextId('notes'),
    user_id: uid,
    title: input.title || '',
    body: input.body || ''
  });
  return null;
}

function updateNote(p, uid) {
  var rowIndex = ownedRowIndex('notes', p.id, uid);
  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'title')) patch.title = given.title || '';
  if (Object.prototype.hasOwnProperty.call(given, 'body')) patch.body = given.body;
  return patchRowAt('notes', rowIndex, patch);
}

function deleteNote(p, uid) {
  var rowIndex = ownedRowIndex('notes', p.id, uid);
  deleteRowsWhere('note_items', 'note_id', p.id);
  sheet('notes').deleteRow(rowIndex);
  return null;
}

/** One more than the highest sort_order already used by this note's items. */
function nextSortOrder(noteId) {
  var rows = readRows('note_items');
  var max = -1;
  for (var i = 0; i < rows.length; i++) {
    if (num(rows[i].note_id) !== num(noteId)) continue;
    if (num(rows[i].sort_order) > max) max = num(rows[i].sort_order);
  }
  return max + 1;
}

function addNoteItem(p, uid) {
  ownedRowIndex('notes', p.noteId, uid); // throws if not owned
  var input = p.input || {};
  if (blank(input.text)) throw new Error('A checklist item needs text');
  appendRow('note_items', {
    id: nextId('note_items'),
    user_id: uid,
    note_id: p.noteId,
    text: input.text,
    done: false,
    sort_order: nextSortOrder(p.noteId)
  });
  return null;
}

function updateNoteItem(p, uid) {
  var rowIndex = ownedRowIndex('note_items', p.id, uid);
  var given = p.patch || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(given, 'text')) {
    if (blank(given.text)) throw new Error('A checklist item needs text');
    patch.text = given.text;
  }
  if (Object.prototype.hasOwnProperty.call(given, 'done')) patch.done = bool(given.done);
  return patchRowAt('note_items', rowIndex, patch);
}

function deleteNoteItem(p, uid) {
  var rowIndex = ownedRowIndex('note_items', p.id, uid);
  sheet('note_items').deleteRow(rowIndex);
  return null;
}
