export type StudyBlock = { key: string; title: string; start: number; end: number };
export function studyBlock(calendar: string, event: {
  id?: string | null; summary?: string | null; status?: string | null;
  start?: { dateTime?: string | null } | null; end?: { dateTime?: string | null } | null;
}): StudyBlock | null {
  if (!event.id || event.status === "cancelled" || !/\bstudy(?:ing)?\b/i.test(event.summary ?? "")
      || !event.start?.dateTime || !event.end?.dateTime) return null;
  const start = Date.parse(event.start.dateTime), end = Date.parse(event.end.dateTime);
  const minutes = (end - start) / 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || minutes < 5 || minutes > 240 || !Number.isInteger(minutes)) return null;
  return { key: `${calendar}:${event.id}`, title: event.summary!.replace(/\s+/g," ").slice(0,100), start, end };
}
