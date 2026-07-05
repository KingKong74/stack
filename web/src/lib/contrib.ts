// The contribution grid maths, shared by the Timeline screen and the deck's
// compact strip: 53 Monday-start week columns ending this week.

export interface ContribDay { date: string; count: number; future: boolean }

const DAY_MS = 24 * 60 * 60 * 1000;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

export function buildWeeks(counts: Map<string, number>): ContribDay[][] {
  const today = new Date();
  const utcToday = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const dow = (utcToday.getUTCDay() + 6) % 7; // Monday = 0
  const end = new Date(utcToday.getTime() + (6 - dow) * DAY_MS); // this week's Sunday
  const weeks: ContribDay[][] = [];
  for (let w = 52; w >= 0; w--) {
    const week: ContribDay[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(end.getTime() - (w * 7 + (6 - d)) * DAY_MS);
      const key = dateKey(day);
      week.push({ date: key, count: counts.get(key) || 0, future: day.getTime() > utcToday.getTime() });
    }
    weeks.push(week);
  }
  return weeks;
}

export const contribLevel = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3);
