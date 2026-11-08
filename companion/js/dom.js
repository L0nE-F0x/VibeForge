// @ts-check
// Building the page's nodes: elements, bars, and the panels that open over a page.

import { t } from "./words.js";

/** @typedef {import("./state.js").Sheet} Sheet */
/** What a node can hold: nodes, words and numbers, nothing for null or false, and lists of those. @typedef {Node | string | number | null | undefined | false | Child[]} Child */
/**
 * Attributes, `class`, and `on…` listeners. Null and false leave an attribute out.
 * @typedef {{ onclick?: (event: MouseEvent) => void, onkeydown?: (event: KeyboardEvent) => void, onchange?: (event: Event) => void, [name: string]: unknown }} Attrs
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs} [attrs]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = /** @type {string} */ (value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    else node.setAttribute(key, String(value));
  }
  for (const child of /** @type {Child[]} */ (children.flat())) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * @param {number} percent
 * @param {string} className
 */
export function bar(percent, className) {
  const fill = el("i");
  // CSSOM, not a style attribute: the page's CSP has no 'unsafe-inline'.
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return el("span", { class: className }, fill);
}

/**
 * A panel over the landing. Closing it shows the three buttons again; the page is not rebuilt.
 * @param {string} title
 * @param {...Child} nodes
 * @returns {Sheet}
 */
export function sheet(title, ...nodes) {
  /** @type {Element | null} */
  let opener = null;
  /**
   * What the panel covers: the page under it, while it is open.
   * @param {boolean} inert
   */
  const under = (inert) => {
    for (const child of panel.parentElement?.children || []) {
      if (child !== panel && !child.classList.contains("sheet")) child.toggleAttribute("inert", inert);
    }
  };
  const close = () => {
    panel.hidden = true;
    under(false);
    if (opener instanceof HTMLElement) opener.focus();
    opener = null;
  };
  const panel = /** @type {Sheet} */ (
    el(
      "div",
      { class: "sheet", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "top sheet-bar" }, el("button", { class: "back sheet-close", type: "button", onclick: close }, t("phone.homeClose")), el("h2", {}, title)),
      el("div", { class: "sheet-body" }, ...nodes),
    )
  );
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault();
    close();
  });
  panel.open = () => {
    opener = document.activeElement;
    const home = panel.parentElement;
    for (const other of /** @type {Iterable<HTMLElement>} */ (home?.querySelectorAll(":scope > .sheet") || [])) {
      if (other !== panel) other.hidden = true;
    }
    under(true);
    panel.hidden = false;
    /** @type {HTMLElement | null} */ (panel.querySelector(".sheet-close"))?.focus();
  };
  return panel;
}

/**
 * The node someone is typing in. A poll leaves it alone; a picked option is already sent, so a list doesn't count.
 * @param {Node} node
 */
export function editingIn(node) {
  const active = document.activeElement;
  return Boolean(active && node.contains(active) && active.matches("input, textarea"));
}
