/**
 * Minimal fake DOM for exercising the page-side overlay probe in
 * tests/popup_dismiss.test.js via node:vm.
 *
 * Implements only what core/ui.js's probe touches:
 *   querySelectorAll (a small selector subset), textContent / innerText,
 *   getBoundingClientRect, offsetParent, getClientRects, closest,
 *   getAttribute, click, querySelector.
 *
 * Selector subset (matching the probe's actual usage):
 *   tag, .class, [attr], [attr*="v" i], [class*="v"], #id, "a, b, c" lists.
 * The `i` flag on attribute-substring selectors is accepted and ignored
 * (case-insensitivity) so the probe's real selectors parse unchanged.
 */
const CLASS_SELECTOR = /^\.([\w-]+)$/;
const ID_SELECTOR = /^#([\w-]+)$/;
const TAG_SELECTOR = /^[a-zA-Z][\w-]*$/;
const ATTR_SUB = /^\[([\w-]+)\*="([^"]*)"\s*i?\]$/;
const ATTR_EQ = /^\[([\w-]+)="([^"]*)"\]$/;

class FakeNode {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this._doc = null; // set by appendChild so clicks survive detachment
    this.childNodes = [];
    this.parentNode = null;
    this._text = text;
    this.clicked = 0;
    // Visible by default; tests flip this to simulate a collapsed overlay.
    this.offsetParent = {};
    this.rect = { x: 10, y: 20, width: 300, height: 120 };
    // When true the click leaves the node in the DOM (sticky overlay).
    this.sticky = false;
  }

  get className() { return this.attrs.class || ''; }

  appendChild(child) {
    child.parentNode = this;
    this._adopt(child);
    this.childNodes.push(child);
    return child;
  }

  _adopt(child) {
    const doc = this._doc || (this instanceof FakeDocument ? this : null);
    child._doc = doc;
    if (doc) for (const c of child.descendants()) c._doc = doc;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map(c => c.textContent).join('');
  }

  get innerText() { return this.textContent.trim(); }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect() { return this.rect; }

  getClientRects() { return this.offsetParent === null ? [] : [this.rect]; }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  click() {
    this.clicked += 1;
    if (this._doc) this._doc._clickedNodes.push(this);
    // Model TV's React unmount: clicking a real dismiss/close control tears
    // down the whole overlay, not just the button. `sticky` models the
    // opposite (a control that reports success while the modal stays).
    if (this.sticky) return;
    if (this.tagName === 'BUTTON') {
      const overlay = this.closest('[role="dialog"], [data-name], .tv-dialog, .popup-Popup, .tour-modal');
      if (overlay && overlay !== this) { overlay.remove(); return; }
    }
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  matches(selectorList) {
    return String(selectorList)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .some(sel => this._matchesOne(sel));
  }

  _matchesOne(sel) {
    let m;
    if ((m = CLASS_SELECTOR.exec(sel))) return (` ${this.className} `).includes(` ${m[1]} `);
    if ((m = ID_SELECTOR.exec(sel))) return (this.attrs.id || '') === m[1];
    if (TAG_SELECTOR.test(sel)) return this.tagName === sel.toUpperCase();
    if ((m = ATTR_SUB.exec(sel))) {
      const v = this.attrs[m[1]] || '';
      return v.toLowerCase().includes(m[2].toLowerCase());
    }
    if ((m = ATTR_EQ.exec(sel))) return (this.attrs[m[1]] || '') === m[2];
    // Compound simple selector: a sequence of tag / .class / [attr] / [attr*="v" i]
    // joined without a combinator (e.g. button[class*="close" i]). Every part
    // must match the element; a part that is not a recognized simple form
    // disqualifies the selector.
    const parts = sel.split(/(?=[.#\[])/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(p => /^/.test('\u0001') )) {
      return parts.every(p => this._matchesSimplePart(p));
    }
    return false;
  }

  _matchesSimplePart(p) {
    let m;
    if ((m = CLASS_SELECTOR.exec(p))) return (` ${this.className} `).includes(` ${m[1]} `);
    if (TAG_SELECTOR.test(p)) return this.tagName === p.toUpperCase();
    if ((m = ATTR_SUB.exec(p))) {
      const v = this.attrs[m[1]] || '';
      return v.toLowerCase().includes(m[2].toLowerCase());
    }
    if ((m = ATTR_EQ.exec(p))) return (this.attrs[m[1]] || '') === m[2];
    return false;
  }

  descendants(out = []) {
    for (const c of this.childNodes) { out.push(c); c.descendants(out); }
    return out;
  }

  querySelectorAll(selectorList) {
    return this.descendants().filter(n => n.matches(selectorList));
  }

  querySelector(selectorList) {
    return this.querySelectorAll(selectorList)[0] || null;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document');
    this.body = new FakeNode('body');
    this.appendChild(this.body);
    // Clicks are recorded here centrally so a detached control (a real
    // dismiss control unmounts the overlay) is still observable.
    this._clickedNodes = [];
  }

  // Every click ever made, including on nodes since detached (a real
  // dismiss control unmounts, so the record has to survive removal).
  get clicks() {
    return this._clickedNodes.map(n => n.innerText || n.getAttribute('aria-label') || n.tagName);
  }
}

export function makeDom(overlayNodes = []) {
  const document = new FakeDocument();
  const window = { document, devicePixelRatio: 1 };
  for (const node of overlayNodes) document.body.appendChild(node);
  return { document, window };
}

/**
 * Overlay fixtures. Every option below names the real-world variant it
 * stands in for; all shapes were observed on TradingView Desktop.
 */
export const overlayHtml = {
  subscriptionUpsell(opts = {}) {
    const {
      dismissText = "Don't need",
      closeText = 'Close', includeClose = true,
      iconClose = false, visible = true, sticky = false,
    } = opts;
    const overlay = new FakeNode('div', {
      class: 'tv-dialog tv-dialog--modal',
      role: 'dialog',
      'aria-modal': 'true',
      'data-name': 'subscription-upsell-dialog',
    });
    if (!visible) overlay.offsetParent = null;

    const title = new FakeNode('div', { class: 'title' }, 'Take your subscription to the next level');
    overlay.appendChild(title);
    const body = new FakeNode('div', { class: 'body' }, 'Get real-time data from NASDAQ.');
    overlay.appendChild(body);

    if (dismissText) {
      const b = btn(dismissText, 'js-dont-need');
      b.sticky = sticky; // sticky models a control that "clicks" but the modal stays
      overlay.appendChild(b);
    }
    if (includeClose && closeText) {
      const c = btn(closeText, 'js-close');
      c.sticky = sticky;
      overlay.appendChild(c);
    }
    if (iconClose) {
      // Icon-only close: no text, exposed via aria-label only — the probe's
      // labelOf() must resolve it through aria-label / title / data-name.
      overlay.appendChild(new FakeNode('button', {
        class: 'close-button', 'aria-label': 'Close', title: 'Close', 'data-name': 'close',
      }));
    }
    return overlay;
  },

  getRealtime(opts = {}) {
    const { controls = ["Don't need"] } = opts;
    const overlay = new FakeNode('div', { class: 'popup-Popup popup--upsell', 'data-name': 'get-realtime-popup', role: 'dialog' });
    overlay.appendChild(new FakeNode('div', {}, 'Get real-time data from NASDAQ.'));
    for (const text of controls) overlay.appendChild(btn(text, text.toLowerCase().replace(/\s+/g, '-')));
    return overlay;
  },

  newFeatureTour() {
    const overlay = new FakeNode('div', { class: 'tour-modal', 'data-name': 'new-features-tour', role: 'dialog' });
    overlay.appendChild(new FakeNode('div', {}, "What's new in TradingView"));
    overlay.appendChild(btn('Skip', 'js-skip'));
    overlay.appendChild(btn('Got it', 'js-got-it'));
    return overlay;
  },

  // Chart chrome that mentions "upgrade" but is not a modal: the probe's
  // container selector + text-length bound must not match this.
  upgradeMenuItem() {
    const menu = new FakeNode('div', { class: 'tv-menu' });
    const item = new FakeNode('div', { class: 'item', role: 'menuitem' }, 'Upgrade your plan');
    menu.appendChild(item);
    return menu;
  },
};

function btn(text, dataName) {
  const b = new FakeNode('button', { class: 'button', 'data-name': dataName }, text);
  return b;
}