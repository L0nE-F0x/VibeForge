// @ts-check
// Reading what someone typed, pasted or opened as a computer's address: the link Settings → Phone
// shows (and draws as a QR code), an address, or only a computer's name.

/**
 * The pairing code a link carries after its `#`, the way Settings → Phone writes it. It is never
 * sent to the computer as part of the address: a browser keeps what follows `#` to itself.
 * @param {string} hash
 */
export function linkCode(hash) {
  return /^#?pair=(vf_[0-9a-f]{32})$/.exec(hash.trim())?.[1] ?? "";
}

/**
 * Where another computer's page is, from what was typed: its whole link, its address, or only its
 * name ("laptop"), which is completed with this page's own tailnet. Only a computer this page may
 * ask is taken: another machine of the same tailnet or, for a page opened on the computer itself,
 * another local port. Anything else is null.
 * @param {string} typed
 * @param {{ protocol: string, host: string, hostname: string }} here The page's own address.
 * @returns {{ url: string, code: string } | null} `url` is empty for the computer this page came from. `code` is the pairing code a link carried.
 */
export function readAddress(typed, here) {
  let text = typed.trim();
  if (!text) return null;
  const local = /^(127\.0\.0\.1|localhost)$/.test(here.hostname);
  const tailnet = /^[a-z0-9-]+\.((?:[a-z0-9-]+\.)*ts\.net)$/.exec(here.hostname.toLowerCase())?.[1] ?? "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const [, name = "", port = "", rest = ""] = /^([^/:#?]+)(:\d+)?(.*)$/.exec(text) ?? [];
    if (tailnet && name && !name.includes(".")) text = `${name}.${tailnet}${port}${rest}`;
    text = `${local ? "http" : "https"}://${text}`;
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const machine = tailnet && host.endsWith(`.${tailnet}`) ? host.slice(0, -tailnet.length - 1) : "";
  const allowed = tailnet ? url.protocol === "https:" && /^[a-z0-9-]+$/.test(machine) : local && url.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(host);
  if (!allowed) return null;
  return { url: url.origin === `${here.protocol}//${here.host}` ? "" : url.origin, code: linkCode(url.hash) };
}
