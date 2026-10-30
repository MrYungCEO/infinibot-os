/**
 * Date picker model — pure logic for components/DatePicker.js, quick capture
 * and the idea / note / task editors. Everything is a plain calendar date
 * ("YYYY-MM-DD") plus an optional wall-clock time ("HH:mm") in the PHONE's
 * timezone (the owner's), never a UTC instant, so a date never shifts by a
 * day when it crosses the wire.
 *
 *   quickChips(now)            Today / Tomorrow / This weekend / Next week /
 *                              In 2 weeks (+ "No date" is the clear button)
 *   monthGrid(y, m, opts)      6×7 Monday-first weeks for the calendar
 *   formatWhen(date, time)     "Fri 17 Oct, 3 pm" (year only when not this year)
 *   relativeHint(date)         "today", "tomorrow", "in 3 days", "2 days ago"
 *   splitWhen / joinWhen       "2026-10-17T15:00" ↔ { date, time }
 *   stepTime(time, minutes)    ±15 min stepper, wraps at midnight
 *   dateChipLabel(suggestion)  "Auto: Fri 17 Oct · from “by Friday”"
 */

export const TIME_PRESETS = [
  { key: 'morning', label: 'Morning', time: '09:00' },
  { key: 'noon', label: 'Noon', time: '12:00' },
  { key: 'afternoon', label: 'Afternoon', time: '15:00' },
  { key: 'evening', label: 'Evening', time: '18:00' },
];

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of a Date → "YYYY-MM-DD". */
export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" → local-midnight Date, or null when it isn't a real date. */
export function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

export function isYmd(s) {
  return !!parseYmd(s) && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isHm(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/** "2026-10-17T15:00" / "2026-10-17" / Notion "2026-10-17T15:00:00.000+07:00" → { date, time? }. */
export function splitWhen(v) {
  if (typeof v !== 'string' || !v) return { date: null, time: null };
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m || !parseYmd(m[1])) return { date: null, time: null };
  return { date: m[1], time: m[2] && isHm(m[2]) ? m[2] : null };
}

export function joinWhen(date, time) {
  if (!date) return '';
  return time ? `${date}T${time}` : date;
}

/**
 * The quick chips. "This weekend" is the coming Saturday (today on a
 * weekend); "Next week" is Monday of next week.
 */
export function quickChips(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay();
  const weekend = dow === 6 || dow === 0 ? today : addDays(today, 6 - dow);
  const nextMonday = addDays(today, (8 - dow) % 7 || 7);
  return [
    { key: 'today', label: 'Today', date: ymd(today) },
    { key: 'tomorrow', label: 'Tomorrow', date: ymd(addDays(today, 1)) },
    { key: 'weekend', label: 'This weekend', date: ymd(weekend) },
    { key: 'next-week', label: 'Next week', date: ymd(nextMonday) },
    { key: 'two-weeks', label: 'In 2 weeks', date: ymd(addDays(today, 14)) },
  ];
}

/**
 * Calendar weeks for month `m` (0-11) of year `y`, Monday first: always 6
 * rows of 7 cells { date, day, inMonth, isToday, isPast }.
 */
export function monthGrid(y, m, { now = new Date() } = {}) {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first offset
  const start = addDays(first, -lead);
  const today = ymd(now);
  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const row = [];
    for (let i = 0; i < 7; i += 1) {
      const d = addDays(start, w * 7 + i);
      const date = ymd(d);
      row.push({ date, day: d.getDate(), inMonth: d.getMonth() === m, isToday: date === today, isPast: date < today });
    }
    weeks.push(row);
  }
  return weeks;
}

/** Month after / before ({ y, m }) — for the calendar arrows. */
export function shiftMonth({ y, m }, by) {
  const d = new Date(y, m + by, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

/** "3 pm", "9:30 am", "12 pm". */
export function formatTime(time) {
  if (!isHm(time)) return '';
  const [h, mi] = time.split(':').map(Number);
  return `${h % 12 || 12}${mi ? `:${pad(mi)}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Fri 17 Oct", "Fri 17 Oct, 3 pm", "Tue 5 Jan 2027" — '' for no date. */
export function formatWhen(date, time, { now = new Date() } = {}) {
  const d = parseYmd(date);
  if (!d) return '';
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  const head = `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}${year}`;
  return isHm(time) ? `${head}, ${formatTime(time)}` : head;
}

/** "today" / "tomorrow" / "yesterday" / "in 3 days" / "2 days ago" / "in 5 weeks". */
export function relativeHint(date, { now = new Date() } = {}) {
  const d = parseYmd(date);
  if (!d) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d - today) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0 && days < 14) return `in ${days} days`;
  if (days < 0 && days > -14) return `${-days} days ago`;
  const weeks = Math.round(Math.abs(days) / 7);
  return days > 0 ? `in ${weeks} weeks` : `${weeks} weeks ago`;
}

/** Time ± minutes, wrapping round midnight; no time yet starts from 09:00. */
export function stepTime(time, minutes) {
  const base = isHm(time) ? time : '09:00';
  const [h, m] = base.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Which quick chip (if any) a date is. */
export function chipFor(date, now = new Date()) {
  return quickChips(now).find((c) => c.date === date)?.key || null;
}

/** "Auto: Fri 17 Oct, 3 pm · from “by Friday”". */
export function dateChipLabel(s, { now = new Date() } = {}) {
  if (!s?.date) return '';
  const when = formatWhen(s.date, s.time, { now }) || s.label || s.date;
  return `Auto: ${when}${s.phrase ? ` · from “${s.phrase}”` : ''}`;
}

/** What the date means for each capture kind (field label + empty text). */
export const DATE_FIELD = {
  task: { label: 'Due', empty: 'No due date' },
  project: { label: 'Target date', empty: 'No target date' },
  idea: { label: 'Review on', empty: 'No review date' },
  note: { label: 'Review on', empty: 'No review date' },
  log: { label: 'Date', empty: 'Today' },
};
