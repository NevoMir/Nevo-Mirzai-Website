import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseTimelineToTimestamp(timeline?: string): number | null {
  if (!timeline) return null;
  const match = timeline.match(/(?:(\d{1,2})\.)?(\d{4})/);
  if (!match) return null;
  const month = match[1] ? Number(match[1]) : 1;
  const year = Number(match[2]);
  if (!Number.isFinite(year) || year < 0) return null;
  const monthIndex = Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : 0;
  return new Date(year, monthIndex, 1).getTime();
}
