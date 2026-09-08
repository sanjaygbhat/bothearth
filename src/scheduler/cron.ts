/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week).
 * No dependency. Supports *, N, N-M, star-slash-N, N,M lists; DOW 0-6 (Sun=0) and names.
 */

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MON_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export type CronField = {
  /** true = every value in range */
  any: boolean;
  values: Set<number>;
};

export type CronExpr = {
  raw: string;
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

function parseToken(
  token: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): number {
  const key = token.toLowerCase();
  if (names && key in names) return names[key]!;
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid cron token: ${token}`);
  }
  const n = Number(token);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`cron value out of range [${min},${max}]: ${token}`);
  }
  return n;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField {
  if (field === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepSplit = part.split("/");
    const rangePart = stepSplit[0]!;
    const step = stepSplit[1] !== undefined ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step: ${part}`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = parseToken(a!, min, max, names);
      end = parseToken(b!, min, max, names);
      if (end < start) throw new Error(`invalid cron range: ${part}`);
    } else {
      start = parseToken(rangePart, min, max, names);
      end = start;
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return { any: false, values };
}

/** Parse a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${parts.length}`);
  }
  return {
    raw: expr.trim(),
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12, MON_NAMES),
    dow: parseField(parts[4]!, 0, 6, DOW_NAMES),
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/** True if `date` (local timezone) matches the expression. */
export function cronMatches(expr: CronExpr | string, date: Date): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  return (
    fieldMatches(c.minute, date.getMinutes()) &&
    fieldMatches(c.hour, date.getHours()) &&
    fieldMatches(c.dom, date.getDate()) &&
    fieldMatches(c.month, date.getMonth() + 1) &&
    fieldMatches(c.dow, date.getDay())
  );
}

/**
 * Next fire time strictly after `after` (ms precision floored to minute).
 * Searches forward up to ~4 years of minutes.
 */
export function nextCronRun(expr: CronExpr | string, after: Date): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60 * 4;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`no next cron run within search window for: ${c.raw}`);
}

/** Product default: warn (never reject schema-valid cron) if denser than this. */
export const MINIMUM_INTERVAL_MS = 15 * 60 * 1000;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function ordinal(day: number): string {
  const remainder100 = day % 100;
  if (remainder100 >= 11 && remainder100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function joinWords(words: string[]): string {
  if (words.length === 1) return words[0]!;
  const last = words[words.length - 1]!;
  return `${words.slice(0, -1).join(", ")} and ${last}`;
}

function parsePlainInt(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number.parseInt(field, 10);
  if (value < min || value > max) return null;
  return value;
}

/**
 * Human schedule text for common 5-field shapes; otherwise the raw expression.
 * Portions derived from OpenBot, Copyright (c) 2026 CopilotKit, MIT License.
 */
export function describeCron(cron: string): string {
  try {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return cron;
    const [
      minuteField,
      hourField,
      dayOfMonthField,
      monthField,
      dayOfWeekField,
    ] = fields;
    const wideOpen =
      dayOfMonthField === "*" && monthField === "*" && dayOfWeekField === "*";
    if (wideOpen && hourField === "*") {
      const stepMatch = /^\*\/(\d{1,2})$/.exec(minuteField!);
      if (stepMatch) {
        const step = Number.parseInt(stepMatch[1]!, 10);
        if (Number.isInteger(step) && step > 1 && 60 % step === 0) {
          return `Every ${step} minutes`;
        }
      }
    }
    const minute = parsePlainInt(minuteField!, 0, 59);
    const hour = parsePlainInt(hourField!, 0, 23);
    if (wideOpen && hour !== null && /^\d{1,2}(,\d{1,2})+$/.test(minuteField!)) {
      const minutes = minuteField!.split(",").map((part) => parsePlainInt(part, 0, 59));
      if (minutes.every((value): value is number => value !== null)) {
        const times = [...minutes]
          .sort((a, b) => a - b)
          .map((value) => `${pad2(hour)}:${pad2(value)}`);
        return `Every day at ${joinWords(times)}`;
      }
    }
    if (minute === null || hour === null) return cron;
    const time = `${pad2(hour)}:${pad2(minute)}`;
    if (dayOfMonthField === "*" && monthField === "*") {
      if (dayOfWeekField === "*") return `Every day at ${time}`;
      if (dayOfWeekField === "1-5") return `Weekdays at ${time}`;
      if (/^[0-6]$/.test(dayOfWeekField!)) {
        const dayIndex = Number.parseInt(dayOfWeekField!, 10);
        return `${WEEKDAY_NAMES[dayIndex]}s at ${time}`;
      }
      if (/^[0-6](,[0-6])+$/.test(dayOfWeekField!)) {
        const names = dayOfWeekField!.split(",").map(
          (digit) => `${WEEKDAY_NAMES[Number.parseInt(digit, 10)]}s`,
        );
        return `${joinWords(names)} at ${time}`;
      }
    }
    if (monthField === "*" && dayOfWeekField === "*") {
      const day = parsePlainInt(dayOfMonthField!, 1, 31);
      if (day !== null) return `On the ${ordinal(day)} of the month at ${time}`;
    }
    return cron;
  } catch {
    return cron;
  }
}

/** Smallest adjacent gap in a short scan; null if unreadable. Never throws. */
export function cronMinIntervalMs(cron: string): number | null {
  try {
    let prev = nextCronRun(cron, new Date("2024-01-01T00:00:00Z"));
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 48; i++) {
      const next = nextCronRun(cron, prev);
      min = Math.min(min, next.getTime() - prev.getTime());
      prev = next;
    }
    return min;
  } catch {
    return null;
  }
}

/** Warn string if denser than 15 min; never used to reject create. */
export function cronIntervalFloorWarning(cron: string): string | null {
  const ms = cronMinIntervalMs(cron);
  if (ms !== null && ms < MINIMUM_INTERVAL_MS) {
    return "Routines may run at most every 15 minutes (product default; schedule still accepted).";
  }
  return null;
}

/** Missed-run rule: fire once if scheduled time is late by < 1h; else skip. */
export const MISSED_RUN_WINDOW_MS = 60 * 60 * 1000;

export function shouldFireMissed(
  scheduledAt: Date,
  now: Date,
  windowMs = MISSED_RUN_WINDOW_MS,
): boolean {
  const late = now.getTime() - scheduledAt.getTime();
  return late >= 0 && late < windowMs;
}
