export async function gatewayFetch(path: string, init: RequestInit = {}) {
  const base = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:9000";
  const headers = new Headers(init.headers);
  headers.set("x-internal-token", process.env.INTERNAL_SERVICE_TOKEN ?? "");
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway ${res.status}: ${text}`);
  }
  return res.json();
}
