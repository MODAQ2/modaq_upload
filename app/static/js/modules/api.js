/**
 * Shared fetch wrappers for JSON API calls.
 */

/**
 * GET a JSON endpoint. Throws on non-ok responses.
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function apiGet(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/**
 * POST to a JSON endpoint. Throws on non-ok responses.
 * @param {string} url
 * @param {any} [body] - If provided, sent as JSON with Content-Type header.
 * @returns {Promise<any>}
 */
export async function apiPost(url, body) {
  /** @type {RequestInit} */
  const options = { method: 'POST' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/**
 * PUT to a JSON endpoint. Throws on non-ok responses.
 * @param {string} url
 * @param {any} body
 * @returns {Promise<any>}
 */
export async function apiPut(url, body) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
