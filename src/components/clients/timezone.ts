import { addDays, format, startOfDay } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

/** Display timezone of the whole app (see AGENTS.md). */
export const APP_TZ = "America/Toronto";

/**
 * UTC boundaries of "today" as seen from America/Toronto (DST-safe).
 * start <= today < end
 */
export function torontoDayRange(now: Date = new Date()): { start: Date; end: Date } {
  const zoned = toZonedTime(now, APP_TZ);
  const dayStart = startOfDay(zoned);
  const fmt = "yyyy-MM-dd'T'HH:mm:ss";
  return {
    start: fromZonedTime(format(dayStart, fmt), APP_TZ),
    end: fromZonedTime(format(addDays(dayStart, 1), fmt), APP_TZ),
  };
}
