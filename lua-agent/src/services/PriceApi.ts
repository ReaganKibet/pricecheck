import { env } from 'lua-cli';

/**
 * Thin client for the Supabase edge functions. All price logic lives there,
 * so WhatsApp, web chat and the web app always give the same answer.
 *
 * Set once per agent:
 *   lua env set PRICE_API_URL https://<project-ref>.supabase.co/functions/v1
 *   lua env set PRICE_API_KEY <same secret as the Supabase PRICE_API_KEY>
 */
export async function callPriceApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const base = env('PRICE_API_URL');
  const key = env('PRICE_API_KEY');
  if (!base || !key) throw new Error('PRICE_API_URL and PRICE_API_KEY must be set with `lua env set`');

  const url = new URL(`${base.replace(/\/$/, '')}/${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
