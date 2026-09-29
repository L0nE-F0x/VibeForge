/**
 * Which address belongs on a workspace's browser, and how a typed address becomes one.
 * The panel and the main process share this so a page from one workspace is never stored on another.
 */

/** An address the dock may open or remember. `http` and `https` only. */
export function isDockUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * What to put in the address bar. A bare local host becomes `http`; anything else without a
 * scheme becomes `https`. Empty stays empty.
 */
export function normalizeDockInput(draft: string): string {
  const next = draft.trim();
  if (!next || isDockUrl(next)) return next;
  return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(next) ? `http://${next}` : `https://${next}`;
}

/**
 * The address to store after a navigation. Null when the page belongs to another workspace,
 * is not `http` or `https`, or is already the one stored.
 */
export function savedDockUrl(ownerId: string, panelId: string, pageUrl: string, savedUrl: string): string | null {
  if (ownerId !== panelId) return null;
  if (!isDockUrl(pageUrl)) return null;
  if (pageUrl === savedUrl) return null;
  return pageUrl;
}
