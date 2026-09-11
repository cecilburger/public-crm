export type CalendarMode = 'day' | 'week' | 'month' | 'year';

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Monday-first week start. */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const offset = (x.getDay() + 6) % 7;
  return addDays(x, -offset);
}
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
export function addYears(d: Date, n: number): Date {
  return new Date(d.getFullYear() + n, d.getMonth(), 1);
}
export function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}
/** 42-cell month grid, Monday-first. */
export function monthGrid(monthStart: Date): Date[] {
  const start = startOfWeek(monthStart);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Move the anchor date by one unit of the given mode, in either direction. */
export function shiftAnchor(mode: CalendarMode, anchor: Date, dir: 1 | -1): Date {
  if (mode === 'day') return addDays(anchor, dir);
  if (mode === 'week') return addDays(anchor, dir * 7);
  if (mode === 'year') return addYears(anchor, dir);
  return addMonths(anchor, dir);
}
