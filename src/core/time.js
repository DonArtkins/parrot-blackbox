/**
 * Time & scheduling math.
 *
 * The whole scheduler is built around calendar "due times" (e.g. every day at
 * 22:00, or every Saturday at 22:00). Catch-up works by listing every due time
 * strictly after the last one we considered and strictly before/at *now*, then
 * running those we have not completed yet — oldest first. A machine that was
 * off or offline simply finds its missed dues on the next wake-up and drains
 * them in order.
 *
 * `clock()` is injectable via PBB_TEST_NOW so tests can fake the wall clock.
 */

export const MS_HOUR = 3_600_000;
export const MS_DAY = 24 * MS_HOUR;

/** Injectable wall clock. @returns {Date} */
export function clock() {
  if (process.env.PBB_TEST_NOW) {
    return new Date(process.env.PBB_TEST_NOW);
  }
  return new Date();
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Build a Date at `at:{hour,minute}` on the local calendar day of `dayBase`. */
function localAt(dayBase, at) {
  const d = new Date(dayBase.getFullYear(), dayBase.getMonth(), dayBase.getDate());
  d.setHours(at.hour ?? 0, at.minute ?? 0, 0, 0);
  return d;
}

/**
 * Every due time in (from, to] for a daily schedule.
 * @param {Date} from exclusive lower bound
 * @param {Date} to inclusive upper bound
 * @param {{hour:number,minute:number}} at
 * @returns {Date[]} ascending
 */
export function dailyDues(from, to, at) {
  const out = [];
  if (to.getTime() <= from.getTime()) return out;
  let day = startOfLocalDay(new Date(from.getTime() + 1));
  const lastDay = startOfLocalDay(to);
  while (day.getTime() <= lastDay.getTime()) {
    const due = localAt(day, at);
    if (due.getTime() > from.getTime() && due.getTime() <= to.getTime()) out.push(due);
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return out;
}

/**
 * Every due time in (from, to] for a weekly schedule.
 * @param {Date} from exclusive lower bound
 * @param {Date} to inclusive upper bound
 * @param {0|1|2|3|4|5|6} on day of week, 0=Sunday .. 6=Saturday
 * @param {{hour:number,minute:number}} at
 * @returns {Date[]} ascending
 */
export function weeklyDues(from, to, on, at) {
  const out = [];
  if (to.getTime() <= from.getTime()) return out;
  let day = startOfLocalDay(new Date(from.getTime() + 1));
  const lastDay = startOfLocalDay(to);
  // Advance to the first matching weekday at-or-after `day`.
  while (day.getDay() !== on) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  while (day.getTime() <= lastDay.getTime()) {
    const due = localAt(day, at);
    if (due.getTime() > from.getTime() && due.getTime() <= to.getTime()) out.push(due);
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7);
  }
  return out;
}

/**
 * Resolve a job schedule object into a due-time generator.
 * @param {{kind:'daily'|'weekly', at:{hour,minute}, on?:number}} schedule
 */
export function dueList(schedule, from, to) {
  if (schedule.kind === 'weekly') {
    return weeklyDues(from, to, schedule.on ?? 6, schedule.at ?? { hour: 22, minute: 0 });
  }
  return dailyDues(from, to, schedule.at ?? { hour: 22, minute: 0 });
}

/** RFC3339-ish local ISO stamp without milliseconds (stable for keys). */
export function iso(d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `2026-08-29T22:00:00` -> `2026-08-29` (the calendar day of the due). */
export function dueDay(isoDue) {
  return (isoDue || '').slice(0, 10);
}

/**
 * Compute the pending due list for one job and persist window advancement.
 *
 * @param {string} jobType 'files' | 'snapshots'
 * @param {object} jobState state.jobs[jobType]
 * @param {object} jobCfg  config.jobs[jobType] (has schedule + catchUpLimit)
 * @param {Date} now
 * @returns {{pending:string[], lastDue:string|null, dropped:number}}
 */
export function advancePending(jobState, jobCfg, now) {
  const from = jobState.lastDue ? new Date(jobState.lastDue) : new Date(jobState.since);
  if (now.getTime() <= from.getTime()) {
    return { pending: jobState.pending || [], lastDue: jobState.lastDue, dropped: 0 };
  }
  const candidates = dueList(jobCfg.schedule, from, now);
  if (candidates.length === 0) {
    return { pending: jobState.pending || [], lastDue: jobState.lastDue, dropped: 0 };
  }
  const completedDues = new Set((jobState.completed || []).map((c) => c.due));
  const alreadyPending = new Set(jobState.pending || []);
  const fresh = candidates
    .map((d) => iso(d))
    .filter((due) => !completedDues.has(due) && !alreadyPending.has(due));

  const limit = jobCfg.catchUpLimit ?? 3;
  const dropped = Math.max(0, fresh.length - limit);
  const kept = fresh.slice(-limit); // keep the most recent `limit` missed dues

  const merged = [...(jobState.pending || []), ...kept]
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();
  const lastDue = iso(candidates[candidates.length - 1]);
  return { pending: merged, lastDue, dropped };
}

/** Do two due stamps correspond to the same calendar slot? (string compare is exact) */
export function dueEqual(a, b) {
  return a === b;
}