/** Accepts only same-site paths, so `next` cannot cause an open redirect. */
export function safeNext(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

export function ago(date: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (s < 60) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  let label = 'minute';
  let size = 60;
  for (const [secs, name] of units) {
    if (s >= secs) { size = secs; label = name; }
  }
  const n = Math.floor(s / size);
  return `${n} ${label}${n === 1 ? '' : 's'} ago`;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
