/** Local or explicitly selected endpoint only; no discovery or notifications. */
export async function probeHealth({ url, timeoutMs = 3000 }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Health URL must be HTTP(S), without credentials.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Health timeout must be 1–60000 milliseconds.');
  const started = Date.now();
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || data?.service !== 'semeyniy-ezh' || data.ready !== true) throw new Error('Not ready.');
    return { ok: true, service: data.service, ready: true, elapsedMs: Date.now() - started };
  } catch { throw new Error('Health probe failed, was not ready, or timed out.'); }
}
