// The single writer of check records. A gate reports through this file, not only its
// exit code: a check that exits 0 having checked nothing has passed three times in one
// build, so the sweep reads `ran` from the record rather than trusting the exit status.
//
//   <dir>/<name>.json  ->  { ran, count, status, reason, at }
//
// `dir` defaults to never_to_be_pushed/discovery/checks; Phase D (orchestrator/verify.mjs)
// passes a node's own folder. `status` is 'pass' | 'fail' | 'skipped'. A skip is always
// `ran: false`. Python gates use check_record.py, which writes the same shape to the same place.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const CHECKS_DIR = 'never_to_be_pushed/discovery/checks';
const STATUSES = new Set(['pass', 'fail', 'skipped']);

/** Write one record and return it. `dir` is the output folder (default CHECKS_DIR). */
export function writeCheckRecord(name, { ran, count, status, reason = null }, dir = CHECKS_DIR) {
  if (!STATUSES.has(status)) throw new Error(`check record ${name}: unknown status ${status}`);
  if (status === 'skipped' && ran) throw new Error(`check record ${name}: a skip cannot have run`);
  mkdirSync(dir, { recursive: true });
  const rec = { ran: Boolean(ran), count, status, reason, at: new Date().toISOString() };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}
