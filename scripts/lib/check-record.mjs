// The single writer of check records. A gate reports through this file, not only its
// exit code: a check that exits 0 having checked nothing has passed three times in one
// build, so the sweep reads `ran` from the record rather than trusting the exit status.
//
//   never_to_be_pushed/discovery/checks/<name>.json  ->  { ran, count, status, reason, at }
//
// `status` is 'pass' | 'fail' | 'skipped'. A skip is always `ran: false`. Python gates
// use check_record.py, which writes the same shape to the same place.
import { mkdirSync, writeFileSync } from 'fs';

export const CHECKS_DIR = 'never_to_be_pushed/discovery/checks';
const STATUSES = new Set(['pass', 'fail', 'skipped']);

export function writeCheckRecord(name, { ran, count, status, reason = null }) {
  if (!STATUSES.has(status)) throw new Error(`check record ${name}: unknown status ${status}`);
  if (status === 'skipped' && ran) throw new Error(`check record ${name}: a skip cannot have run`);
  mkdirSync(CHECKS_DIR, { recursive: true });
  writeFileSync(`${CHECKS_DIR}/${name}.json`, JSON.stringify(
    { ran: Boolean(ran), count, status, reason, at: new Date().toISOString() }, null, 2) + '\n');
}
