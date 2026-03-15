/**
 * Cookie parser — shared utility for reading HTTP cookies.
 * Extracted to shared/ to avoid cross-module auth↔session imports.
 */

export function parseCookies(header: string | undefined): Record<string, string> {
  if (header == null || header === '') return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const trimmedPair = pair.trim();
    if (trimmedPair === '') continue;
    const [name, ...rest] = trimmedPair.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}
