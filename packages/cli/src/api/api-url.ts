/** The hosted API (Render, T19). */
export const DEFAULT_API_URL = 'https://agentnomad-api.onrender.com';

/** Environment variable that points the CLI at another server, e.g. a local one. */
export const API_URL_ENV = 'AGENTNOMAD_API_URL';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The server address: `AGENTNOMAD_API_URL` when set, else the hosted API. Must be https
 * (plain http only for this PC), and a bare origin so paths cannot be redirected.
 */
export function resolveApiUrl(env: Readonly<Record<string, string | undefined>>): URL {
  const raw = env[API_URL_ENV]?.trim();
  if (!raw) return new URL(DEFAULT_API_URL);

  const invalid = (reason: string) => new Error(`${API_URL_ENV} ${reason}: ${raw}`);
  if (!URL.canParse(raw)) throw invalid('is not a valid URL');
  const url = new URL(raw);
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw invalid('must use https (http is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalid('must be just the server address, e.g. https://example.com');
  }
  return url;
}
