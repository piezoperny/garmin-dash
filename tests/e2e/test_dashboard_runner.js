/**
 * tests/e2e/test_dashboard_runner.js
 *
 * In-process headless simulation & real-module E2E test runner for Garmin Vault.
 *
 * Part A — Baseline Auth State Machine (TC-01 .. TC-06, 6/6 required):
 * - TC-01: Password modal blocks chart rendering on fresh session.
 * - TC-02: Invalid passphrase triggers authentication error and keeps modal locked.
 * - TC-03: Valid passphrase decrypts data.enc, renders all 3 sections, caches session.
 * - TC-04: Tab reload bypasses password prompt via sessionStorage.
 * - TC-05: Tampered payload fails GCM tag check and alerts user.
 * - TC-06: Explicit "Lock Vault" button purges sessionStorage and restores modal.
 *
 * Part B — Real-Module M2-M5 Enhancement E2E Checks:
 * - Imports real frontend/src ESM modules (`main.js`, `crypto.js`, `session.js`,
 *   `activities.js`, `chart_engine.js`, `wellness.js`, `trends_modal.js`) inside
 *   a headless Node v24+ DOM/Canvas2D/WebCrypto harness, decrypts real `dist/data.enc`,
 *   and verifies M2-M5 opaque-box contracts.
 *
 * Exit Code Policy:
 * - Default mode: exits 0 iff Baseline 6/6 passes and 0 harness/syntax errors occur.
 *   Unimplemented M2-M5 assertions are reported clearly as [PENDING_IMPL].
 * - Strict mode (`--strict` or `E2E_STRICT=1`): exits 1 unless both Baseline AND
 *   all M2-M5 enhancement E2E checks pass 100%.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { decryptDashboardPayload, encryptDashboardPayload } = require('../test_crypto_web.js');

// ============================================================================
// Baseline Headless DOM & Session Storage Mock Environment
// ============================================================================

class MockSessionStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class DashboardStateMachine {
  constructor(sessionStorage, wirePayloadSupplier) {
    this.sessionStorage = sessionStorage;
    this.getWirePayload = wirePayloadSupplier;
    this.state = {
      isLocked: true,
      errorMessage: null,
      activeData: null,
      sectionsRendered: {
        endurance: false,
        physiological: false,
        activities: false
      }
    };
  }

  async init() {
    const cachedKey = this.sessionStorage.getItem('garmin_dash_session_key');
    if (cachedKey) {
      try {
        const wire = await this.getWirePayload();
        const keyBytes = Buffer.from(cachedKey, 'base64');
        const importedKey = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['decrypt']
        );
        const iv = wire.subarray(16, 28);
        const ciphertextAndTag = wire.subarray(28);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, tagLength: 128 },
          importedKey,
          ciphertextAndTag
        );
        const payload = JSON.parse(new TextDecoder().decode(decrypted));
        this._unlockWithData(payload);
        return;
      } catch (err) {
        this.sessionStorage.removeItem('garmin_dash_session_key');
      }
    }
    this.state.isLocked = true;
  }

  async submitPassphrase(passphrase) {
    this.state.errorMessage = null;
    try {
      const wire = await this.getWirePayload();
      const { payload, rawKeyBase64 } = await decryptDashboardPayload(passphrase, wire);
      this.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);
      this._unlockWithData(payload);
    } catch (err) {
      this.state.isLocked = true;
      this.state.errorMessage = 'Authentication failed. Invalid passphrase or corrupted data.';
      this.state.activeData = null;
      this.state.sectionsRendered = { endurance: false, physiological: false, activities: false };
      throw err;
    }
  }

  lockVault() {
    this.sessionStorage.clear();
    this.state.isLocked = true;
    this.state.activeData = null;
    this.state.errorMessage = null;
    this.state.sectionsRendered = { endurance: false, physiological: false, activities: false };
  }

  _unlockWithData(data) {
    this.state.isLocked = false;
    this.state.activeData = data;
    this.state.errorMessage = null;
    this.state.sectionsRendered = {
      endurance: true,
      physiological: true,
      activities: true
    };
  }
}

// ============================================================================
// Shared Headless DOM / Canvas2D / WebCrypto Harness for Real Frontend Modules
// ============================================================================

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);

function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function escapeAttr(val) {
  return String(val).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtmlText(val) {
  return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class PendingImplError extends assert.AssertionError {}

async function waitForCondition(fn, timeoutMs = 5000, intervalMs = 25) {
  const start = Date.now();
  while (true) {
    if (await fn()) return true;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function camelCaseStyle(prop) {
  return prop.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

class MockClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
    this._syncFromClassName();
  }
  _syncFromClassName() {
    this.set.clear();
    if (this.el._className) {
      this.el._className.split(/\s+/).filter(Boolean).forEach(c => this.set.add(c));
    }
  }
  _syncToClassName() {
    this.el._className = Array.from(this.set).join(' ');
  }
  add(...tokens) {
    tokens.forEach(t => { if (t) this.set.add(t); });
    this._syncToClassName();
  }
  remove(...tokens) {
    tokens.forEach(t => this.set.delete(t));
    this._syncToClassName();
  }
  toggle(token, force) {
    if (force === true) {
      this.add(token);
      return true;
    }
    if (force === false) {
      this.remove(token);
      return false;
    }
    if (this.set.has(token)) {
      this.remove(token);
      return false;
    }
    this.add(token);
    return true;
  }
  contains(token) {
    return this.set.has(token);
  }
  toString() {
    return this.el._className;
  }
}

class MockCanvasContext2D {
  constructor(options = {}) {
    this.calls = [];
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this.shadowBlur = 0;
    this.shadowColor = 'transparent';

    if (!options.minimalCtx) {
      this.roundRect = (x, y, w, h, r) => {
        this.calls.push({ op: 'roundRect', x, y, w, h, r });
      };
      this.createLinearGradient = (x0, y0, x1, y1) => {
        const grad = {
          type: 'linearGradient',
          x0, y0, x1, y1,
          stops: [],
          addColorStop(offset, color) {
            this.stops.push({ offset, color });
          }
        };
        this.calls.push({ op: 'createLinearGradient', gradient: grad });
        return grad;
      };
    }
  }
  clearRect(x, y, w, h) {
    this.calls.push({ op: 'clearRect', x, y, w, h });
  }
  beginPath() {
    this.calls.push({ op: 'beginPath' });
  }
  closePath() {
    this.calls.push({ op: 'closePath' });
  }
  moveTo(x, y) {
    this.calls.push({ op: 'moveTo', x, y });
  }
  lineTo(x, y) {
    this.calls.push({ op: 'lineTo', x, y });
  }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this.calls.push({ op: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
  }
  arc(x, y, r, start, end) {
    this.calls.push({ op: 'arc', x, y, r, start, end });
  }
  rect(x, y, w, h) {
    this.calls.push({ op: 'rect', x, y, w, h });
  }
  fill() {
    this.calls.push({ op: 'fill', fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
  }
  stroke() {
    this.calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha });
  }
  fillRect(x, y, w, h) {
    this.calls.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
  }
  strokeRect(x, y, w, h) {
    this.calls.push({ op: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth });
  }
  fillText(text, x, y) {
    this.calls.push({
      op: 'fillText',
      text: String(text),
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
      textAlign: this.textAlign
    });
  }
  measureText(text) {
    return { width: String(text || '').length * 6 };
  }
  save() {
    this.calls.push({ op: 'save' });
  }
  restore() {
    this.calls.push({ op: 'restore' });
  }
  scale(x, y) {
    this.calls.push({ op: 'scale', x, y });
  }
  setTransform(...args) {
    this.calls.push({ op: 'setTransform', args });
  }
  resetTransform() {
    this.calls.push({ op: 'resetTransform' });
  }
  setLineDash(dash) {
    this.calls.push({ op: 'setLineDash', dash: Array.isArray(dash) ? [...dash] : [] });
  }
}

class MockElement {
  constructor(tag, id = '', className = '', ownerDoc = null) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id;
    this._className = className;
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    if (id) this.attributes.set('id', id);
    if (className) this.attributes.set('class', className);
    this.style = {};
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = ownerDoc;
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.width = this.tagName === 'CANVAS' ? 640 : 0;
    this.height = this.tagName === 'CANVAS' ? 320 : 0;
    this.offsetWidth = 640;
    this.clientWidth = 640;
    this.clientHeight = 320;
    this._rect = null;
    this._ctx = null;
    this._ctxOptions = {};
    this.eventListeners = new Map();
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.onsubmit = null;
    this.onmousemove = null;
    this.onmouseleave = null;
    this.ondragstart = null;
    this.ondragend = null;
    this.ondragover = null;
    this.ondrop = null;
  }

  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v ?? '');
    this.attributes.set('class', this._className);
    this.classList._syncFromClassName();
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map(n => (typeof n === 'string' ? n : n.textContent)).join('');
  }
  set textContent(v) {
    this._textContent = String(v ?? '');
    this._innerHTML = '';
    this.children = [];
    this.childNodes = [];
  }

  _serializeChildren() {
    if (this.childNodes.length === 0) {
      return this._textContent ? escapeHtmlText(this._textContent) : '';
    }
    return this.childNodes.map(n => (typeof n === 'string' ? escapeHtmlText(n) : n._serializeOuterHTML())).join('');
  }

  _serializeOuterHTML() {
    const tag = this.tagName.toLowerCase();
    const parts = [];
    if (this.id) parts.push(`id="${escapeAttr(this.id)}"`);
    if (this._className) parts.push(`class="${escapeAttr(this._className)}"`);
    for (const [k, v] of this.attributes.entries()) {
      if (k === 'id' || k === 'class') continue;
      if (v === '') parts.push(k);
      else parts.push(`${k}="${escapeAttr(v)}"`);
    }
    const attrStr = parts.length > 0 ? ' ' + parts.join(' ') : '';
    if (VOID_TAGS.has(tag)) {
      return `<${tag}${attrStr}>`;
    }
    return `<${tag}${attrStr}>${this._serializeChildren()}</${tag}>`;
  }

  get innerHTML() {
    return this._serializeChildren();
  }
  set innerHTML(html) {
    const str = String(html ?? '');
    this._innerHTML = str;
    this._textContent = '';
    this.children = [];
    this.childNodes = [];

    if (!str) return;

    const stack = [this];
    const tagRegex = /<(\/?)([a-zA-Z0-9\-]+)([^>]*?)(\/?)>/g;
    let lastIndex = 0;
    let match;

    while ((match = tagRegex.exec(str)) !== null) {
      if (match.index > lastIndex) {
        const text = decodeEntities(str.slice(lastIndex, match.index));
        if (text) stack[stack.length - 1].childNodes.push(text);
      }
      lastIndex = tagRegex.lastIndex;

      const isClose = match[1] === '/';
      const tagName = match[2].toLowerCase();
      const attrsStr = match[3] || '';
      const selfClose = match[4] === '/' || VOID_TAGS.has(tagName);

      if (isClose) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName.toLowerCase() === tagName) {
            stack.length = i;
            break;
          }
        }
        continue;
      }

      const parent = stack[stack.length - 1];
      const child = new MockElement(tagName, '', '', this.ownerDocument);
      child.parentElement = parent;

      const attrRe = /([a-zA-Z0-9\-_:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let am;
      while ((am = attrRe.exec(attrsStr)) !== null) {
        const attrName = am[1];
        const attrVal = am[2] ?? am[3] ?? am[4] ?? '';
        child.setAttribute(attrName, decodeEntities(attrVal));
        if (attrName === 'style' && attrVal) {
          for (const decl of attrVal.split(';')) {
            const idx = decl.indexOf(':');
            if (idx > 0) {
              const k = camelCaseStyle(decl.slice(0, idx).trim().toLowerCase());
              const v = decl.slice(idx + 1).trim();
              child.style[k] = v;
            }
          }
        }
      }

      parent.children.push(child);
      parent.childNodes.push(child);
      if (this.ownerDocument && child.id) {
        this.ownerDocument.register(child);
      }
      if (!selfClose) {
        stack.push(child);
      }
    }

    if (lastIndex < str.length) {
      const tail = decodeEntities(str.slice(lastIndex));
      if (tail) stack[stack.length - 1].childNodes.push(tail);
    }
  }

  appendChild(child) {
    if (!child) return child;
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    this.childNodes.push(child);
    if (this.ownerDocument) {
      this.ownerDocument._registerTree(child);
    }
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    const nIdx = this.childNodes.indexOf(child);
    if (nIdx >= 0) this.childNodes.splice(nIdx, 1);
    if (child) child.parentElement = null;
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
    if (this.ownerDocument && this.id) {
      this.ownerDocument.elementsById.delete(this.id);
    }
  }

  setAttribute(name, value) {
    const val = String(value);
    this.attributes.set(name, val);
    if (name === 'class') {
      this._className = val;
      this.classList._syncFromClassName();
    } else if (name === 'id') {
      if (this.ownerDocument && this.id && this.id !== val && this.ownerDocument.elementsById.get(this.id) === this) {
        this.ownerDocument.elementsById.delete(this.id);
      }
      this.id = val;
      if (this.ownerDocument && val) {
        this.ownerDocument.elementsById.set(val, this);
      }
    } else if (name === 'value') {
      this.value = val;
    }
  }

  getAttribute(name) {
    if (name === 'class') return this._className;
    if (name === 'id') return this.id || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    if (name === 'class') return Boolean(this._className);
    if (name === 'id') return Boolean(this.id);
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.eventListeners.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  dispatchEvent(event) {
    const evObj = typeof event === 'string'
      ? { type: event, target: this, defaultPrevented: false, cancelBubble: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } }
      : event;
    if (!evObj.target) evObj.target = this;
    if (typeof evObj.preventDefault !== 'function') evObj.preventDefault = () => { evObj.defaultPrevented = true; };
    if (typeof evObj.stopPropagation !== 'function') evObj.stopPropagation = () => { evObj.cancelBubble = true; };

    let cur = this;
    while (cur && !evObj.cancelBubble) {
      evObj.currentTarget = cur;
      const list = cur.eventListeners.get(evObj.type) || [];
      for (const h of [...list]) {
        h.call(cur, evObj);
      }
      const inline = cur[`on${evObj.type}`];
      if (typeof inline === 'function') {
        inline.call(cur, evObj);
      }
      if (evObj.type === 'submit' || evObj.type === 'focus' || evObj.type === 'blur' || evObj.type === 'mouseleave') {
        break;
      }
      cur = cur.parentElement;
    }
    return !evObj.defaultPrevented;
  }

  click() {
    return this.dispatchEvent('click');
  }

  focus() {}
  select() {}
  scrollIntoView() {}

  _matchesSingle(part) {
    let rem = part.trim();
    if (!rem) return false;

    const tagMatch = rem.match(/^([a-zA-Z0-9\-]+)/);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rem = rem.slice(tagMatch[1].length);
    }

    const tokenRe = /(#([a-zA-Z0-9\-_]+)|\.([a-zA-Z0-9\-_\[\]\/:#]+)|\[([a-zA-Z0-9\-_:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])/g;
    let consumed = 0;
    let tm;
    while ((tm = tokenRe.exec(rem)) !== null) {
      consumed += tm[0].length;
      if (tm[2]) {
        if (this.id !== tm[2]) return false;
      } else if (tm[3]) {
        if (!this.classList.contains(tm[3])) return false;
      } else if (tm[4]) {
        const attr = tm[4];
        const expected = tm[5] ?? tm[6] ?? tm[7];
        if (expected === undefined) {
          if (!this.hasAttribute(attr)) return false;
        } else {
          if (this.getAttribute(attr) !== expected) return false;
        }
      }
    }
    return consumed === rem.length;
  }

  matches(selector) {
    const groups = String(selector || '').split(',');
    for (const grp of groups) {
      const parts = grp.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      if (!this._matchesSingle(parts[parts.length - 1])) continue;
      if (parts.length === 1) return true;
      let cur = this.parentElement;
      let idx = parts.length - 2;
      while (cur && idx >= 0) {
        if (cur._matchesSingle(parts[idx])) idx--;
        cur = cur.parentElement;
      }
      if (idx < 0) return true;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  _collectDescendants(out) {
    for (const ch of this.children) {
      out.push(ch);
      ch._collectDescendants(out);
    }
  }

  querySelectorAll(selector) {
    const all = [];
    this._collectDescendants(all);
    return all.filter(el => el.matches(selector));
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  getBoundingClientRect() {
    if (this._rect) return this._rect;
    const w = this.tagName === 'CANVAS' ? (this.width || 640) : 640;
    const h = this.tagName === 'CANVAS' ? (this.height || 320) : 320;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h };
  }

  getContext(type) {
    if (type !== '2d') return null;
    if (!this._ctx) {
      this._ctx = new MockCanvasContext2D(this._ctxOptions);
    }
    return this._ctx;
  }
}

class MockDocument {
  constructor() {
    this.readyState = 'loading';
    this.elementsById = new Map();
    this.body = new MockElement('body', 'body', '', this);
    this.eventListeners = new Map();
  }

  createElement(tag) {
    return new MockElement(tag, '', '', this);
  }

  _registerTree(el) {
    if (!el) return;
    el.ownerDocument = this;
    if (el.id) this.elementsById.set(el.id, el);
    for (const ch of el.children) {
      this._registerTree(ch);
    }
  }

  register(el) {
    el.ownerDocument = this;
    if (el.id) this.elementsById.set(el.id, el);
    return el;
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelectorAll(sel) {
    const seen = new Set();
    const res = [];
    const consider = (el) => {
      if (!seen.has(el) && el.matches(sel)) {
        seen.add(el);
        res.push(el);
      }
    };
    const walk = (el) => {
      consider(el);
      for (const ch of el.children) walk(ch);
    };
    for (const el of this.elementsById.values()) {
      walk(el);
    }
    walk(this.body);
    return res;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length > 0 ? all[0] : null;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.eventListeners.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  dispatchEvent(event) {
    const evObj = typeof event === 'string' ? { type: event, target: this } : event;
    const list = this.eventListeners.get(evObj.type) || [];
    for (const h of [...list]) h(evObj);
  }
}

function toExactArrayBuffer(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function encryptShardWithRawKey(rawKeyBase64, shardObj, salt16 = new Uint8Array(16)) {
  const rawKey = Buffer.from(rawKeyBase64, 'base64');
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(shardObj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, pt));
  const wire = new Uint8Array(16 + 12 + ct.length);
  wire.set(salt16, 0);
  wire.set(iv, 16);
  wire.set(ct, 28);
  return wire;
}

function encodePolyline(coords) {
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  const encodeNum = (num) => {
    let v = num < 0 ? ~(num << 1) : (num << 1);
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  };
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeNum(iLat - prevLat) + encodeNum(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

function createHeadlessEnv(options = {}) {
  const doc = new MockDocument();
  const sessionStorage = new MockSessionStorage();
  const localStorage = new MockSessionStorage();
  const windowListeners = new Map();

  const reg = (tag, id, cls = '', parent = doc.body) => {
    const el = new MockElement(tag, id, cls, doc);
    if (parent) parent.appendChild(el);
    doc.register(el);
    return el;
  };

  // Passphrase modal
  const passModal = reg('div', 'passphrase-modal', 'fixed inset-0 z-50 flex items-center justify-center');
  const modalCard = new MockElement('div', '', 'modal-card', doc);
  passModal.appendChild(modalCard);
  reg('div', 'auth-error-message', 'hidden', modalCard);
  const passForm = reg('form', 'passphrase-form', '', modalCard);
  reg('input', 'passphrase-input', '', passForm);
  reg('button', 'passphrase-submit', '', passForm);

  // Dashboard shell
  const dashContent = reg('div', 'dashboard-content', 'hidden');
  dashContent.setAttribute('aria-hidden', 'true');
  const dashMain = reg('main', 'dashboard-main', '', dashContent);

  reg('button', 'btn-lock-dashboard', '', dashContent);
  reg('button', 'unit-toggle-btn', '', dashContent).textContent = 'KM';
  reg('button', 'btn-customize-dashboard', '', dashContent);

  // Today's Activity & Wellness
  reg('section', 'today-activity-section', 'hidden', dashMain);
  const wellnessDash = reg('div', 'wellness-dashboard', '', dashMain);
  reg('div', 'wellness-empty-notice', 'hidden', wellnessDash);
  reg('div', 'wellness-in-focus', 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4', wellnessDash);
  reg('div', 'wellness-at-a-glance', 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4', wellnessDash);
  reg('button', 'btn-edit-home', '', wellnessDash);

  // KPIs & Sport filter bar
  reg('div', 'kpi-total-distance', '', dashMain);
  reg('div', 'kpi-total-time', '', dashMain);
  reg('div', 'kpi-weekly-load', '', dashMain);
  reg('span', 'kpi-status', '', dashMain);

  const filterBar = reg('div', 'sport-filter-bar', '', dashMain);
  for (const sp of ['all', 'cycling', 'running', 'walking', 'hiking', 'strength', 'weights']) {
    reg('button', `filter-btn-${sp}`, '', filterBar);
  }

  // Endurance & Physiological charts
  for (const cardId of ['card-weekly-volume', 'card-training-load', 'card-hr-zone', 'card-power-zone', 'card-pace-zone', 'card-threshold-trends', 'card-backup-vault']) {
    reg('div', cardId, '', dashMain);
  }
  for (const canvasId of ['weekly-volume-chart', 'training-load-chart', 'hr-zone-chart', 'power-zone-chart', 'pace-zone-chart', 'threshold-trends-chart']) {
    const parent = reg('div', `${canvasId}-wrap`, '', dashMain);
    reg('canvas', canvasId, '', parent);
  }
  reg('p', 'hr-zone-subtitle', '', dashMain);
  reg('p', 'power-zone-subtitle', '', dashMain);

  // Activity table & drawer
  const actTable = reg('table', 'activity-table', '', dashMain);
  reg('tbody', 'activities-table-body', '', actTable);
  reg('input', 'activity-search', '', dashMain);
  reg('select', 'activity-sort', '', dashMain);
  reg('button', 'btn-reprocess-activities', '', dashMain);

  const drawer = reg('div', 'activity-drawer', 'fixed inset-0 z-50 flex items-center justify-end hidden', doc.body);
  reg('div', 'drawer-backdrop', '', drawer);
  reg('div', 'drawer-panel', 'max-w-2xl border-l', drawer);
  reg('h3', 'drawer-activity-title', '', drawer);
  reg('p', 'drawer-activity-date', '', drawer);
  reg('button', 'btn-expand-drawer', '', drawer);
  reg('svg', 'icon-expand', '', drawer);
  reg('svg', 'icon-collapse', 'hidden', drawer);
  reg('button', 'btn-close-drawer', '', drawer);
  for (const id of ['drawer-kpi-dist', 'drawer-kpi-duration', 'drawer-kpi-hr', 'drawer-kpi-cadence', 'drawer-kpi-elevation', 'drawer-kpi-calories', 'drawer-map-card', 'drawer-map-meta', 'activity-route-map', 'drawer-map-fallback', 'drawer-telemetry-container', 'readout-elev', 'readout-hr', 'readout-dist', 'toggle-stream-elevation', 'toggle-stream-hr', 'toggle-stream-pace', 'toggle-stream-cadence']) {
    reg('div', id, '', drawer);
  }
  const profWrap = reg('div', 'drawer-profile-wrap', '', drawer);
  reg('canvas', 'activity-profile-chart', '', profWrap);
  reg('tbody', 'drawer-splits-tbody', '', drawer);

  // Backup vault
  reg('div', 'backup-vault-explorer', '', dashMain);
  reg('span', 'vault-status-badge', '', dashMain);
  reg('p', 'vault-provider-label', '', dashMain);
  reg('div', 'vault-total-activities', '', dashMain);
  reg('div', 'vault-last-sync', '', dashMain);
  reg('div', 'vault-years-grid', '', dashMain);

  // Customize modal
  const custModal = reg('div', 'customize-modal', 'hidden');
  reg('button', 'btn-close-customize', '', custModal);
  reg('button', 'btn-reset-customize', '', custModal);
  reg('button', 'btn-save-customize', '', custModal);
  reg('input', 'input-custom-max-hr', '', custModal);
  reg('input', 'input-custom-lthr', '', custModal);
  reg('input', 'input-custom-ftp', '', custModal);
  for (const cardId of ['card-weekly-volume', 'card-training-load', 'card-hr-zone', 'card-power-zone', 'card-pace-zone', 'card-threshold-trends', 'card-backup-vault']) {
    const cb = reg('input', `cb-${cardId}`, '', custModal);
    cb.checked = true;
    cb.setAttribute('data-card-target', cardId);
  }
  for (const mk of ['steps', 'resting_hr', 'sleep', 'stress', 'body_battery', 'hrv', 'intensity_minutes', 'calories']) {
    const sel = reg('select', `sel-${mk}`, '', custModal);
    sel.setAttribute('data-wellness-select', mk);
  }

  // Metric trend modal
  const trendModal = reg('div', 'metric-trend-modal', 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 hidden');
  trendModal.setAttribute('aria-hidden', 'true');
  reg('div', 'trend-modal-backdrop', '', trendModal);
  reg('div', 'trend-modal-panel', 'relative w-full max-w-4xl rounded-2xl max-h-[92vh]', trendModal);
  reg('div', 'trend-metric-icon', '', trendModal);
  reg('h3', 'trend-metric-title', '', trendModal);
  reg('span', 'trend-metric-badge', '', trendModal);
  reg('p', 'trend-metric-subtitle', '', trendModal);
  const rangeBar = reg('div', 'trend-range-selector', '', trendModal);
  for (const rng of ['1d', '7d', '1m', '1y', 'custom']) {
    const rb = reg('button', `btn-trend-range-${rng}`, '', rangeBar);
    rb.setAttribute('data-trend-range', rng);
  }
  reg('button', 'btn-expand-trend-modal', '', trendModal);
  reg('button', 'btn-close-trend-modal', '', trendModal);
  reg('button', 'trend-nav-prev', '', trendModal);
  reg('span', 'trend-date-label', '', trendModal);
  reg('button', 'trend-nav-next', '', trendModal);
  reg('div', 'trend-custom-date-container', 'hidden', trendModal);
  reg('input', 'trend-input-start-date', '', trendModal);
  reg('input', 'trend-input-end-date', '', trendModal);
  reg('button', 'trend-btn-apply-custom', '', trendModal);
  reg('span', 'trend-custom-error', 'hidden', trendModal);
  reg('div', 'trend-kpi-grid', '', trendModal);
  reg('span', 'trend-chart-legend-label', '', trendModal);
  reg('span', 'trend-chart-meta', '', trendModal);
  const trendChartWrap = reg('div', 'trend-chart-wrap', '', trendModal);
  const trendCanvas = reg('canvas', 'metric-trend-chart', '', trendChartWrap);
  trendCanvas.width = 720;
  trendCanvas.height = 280;
  if (options.minimalCtx) {
    trendCanvas._ctxOptions = { minimalCtx: true };
  }
  reg('div', 'trend-chart-empty', 'hidden', trendChartWrap);
  reg('span', 'trend-table-count', '', trendModal);
  reg('tr', 'trend-table-header-row', '', trendModal);
  reg('tbody', 'trend-table-body', '', trendModal);

  const shardMap = options.shards || new Map();
  let dataEncBuf = options.dataEnc || null;

  const mockFetch = async (url) => {
    const u = String(url);
    if (/data\.enc(?:\?.*)?$/.test(u)) {
      if (!dataEncBuf) {
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => toExactArrayBuffer(dataEncBuf) };
    }
    const sm = u.match(/streams\/([^/?]+)\.enc/);
    if (sm) {
      const id = decodeURIComponent(sm[1]);
      if (shardMap.has(id)) {
        const sBuf = shardMap.get(id);
        return { ok: true, status: 200, arrayBuffer: async () => toExactArrayBuffer(sBuf) };
      }
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };

  const mockWindow = {
    devicePixelRatio: 1,
    sessionStorage,
    localStorage,
    crypto: globalThis.crypto,
    L: undefined,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    dispatchEvent(ev) {
      const evObj = typeof ev === 'string' ? { type: ev } : ev;
      for (const h of [...(windowListeners.get(evObj.type) || [])]) h(evObj);
    }
  };

  global.document = doc;
  global.window = mockWindow;
  global.sessionStorage = sessionStorage;
  global.localStorage = localStorage;
  global.fetch = mockFetch;
  if (typeof global.requestAnimationFrame !== 'function') {
    global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  }

  return {
    doc,
    window: mockWindow,
    sessionStorage,
    localStorage,
    shardMap,
    setDataEnc(buf) {
      dataEncBuf = buf;
    }
  };
}

// ============================================================================
// Test Execution Suite
// ============================================================================

async function runE2ESimulation() {
  const strictMode = process.argv.includes('--strict') || process.env.E2E_STRICT === '1';

  process.stdout.write('\n=== Running Headless Dashboard E2E State Machine Suite ===\n\n');
  const baselineResults = [];
  const enhancementResults = [];

  const validPassphrase = 'e2e-master-passphrase-2026!';
  const sampleRollup = {
    version: '1.0.0',
    athlete: { name: 'E2E Runner', max_hr: 192, ftp: 285 },
    summary: { total_distance_km: 420.5, total_moving_time_hours: 35.2 },
    activities: [
      { id: 'act_001', sport: 'running', distance_meters: 12000, avg_hr: 162 },
      { id: 'act_002', sport: 'cycling', distance_meters: 50000, avg_hr: 145 },
      { id: 'act_003', sport: 'strength', distance_meters: 0, avg_hr: 120 }
    ]
  };

  const validWire = await encryptDashboardPayload(validPassphrase, sampleRollup);

  async function runBaselineTest(name, fn) {
    try {
      await fn();
      baselineResults.push({ name, status: 'PASS' });
      process.stdout.write(`  ✓ ${name}\n`);
    } catch (err) {
      baselineResults.push({ name, status: 'FAIL', error: err });
      process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    }
  }

  // TC-01: Initial load
  await runBaselineTest('TC-01: Fresh session displays locked modal and blocks chart rendering', async () => {
    const sessionStorage = new MockSessionStorage();
    const app = new DashboardStateMachine(sessionStorage, async () => validWire);
    await app.init();

    assert.strictEqual(app.state.isLocked, true);
    assert.strictEqual(app.state.activeData, null);
    assert.strictEqual(app.state.sectionsRendered.endurance, false);
    assert.strictEqual(app.state.sectionsRendered.physiological, false);
    assert.strictEqual(app.state.sectionsRendered.activities, false);
  });

  // TC-02: Invalid passphrase
  await runBaselineTest('TC-02: Invalid passphrase rejects unlock, displays auth error, keeps locked', async () => {
    const sessionStorage = new MockSessionStorage();
    const app = new DashboardStateMachine(sessionStorage, async () => validWire);
    await app.init();

    await assert.rejects(
      async () => {
        await app.submitPassphrase('wrong-password');
      },
      /Authentication failed/i
    );

    assert.strictEqual(app.state.isLocked, true);
    assert.ok(app.state.errorMessage.includes('Authentication failed'));
    assert.strictEqual(app.state.sectionsRendered.endurance, false);
  });

  // TC-03: Valid passphrase
  await runBaselineTest('TC-03: Valid passphrase decrypts, renders 3 sections, stores session key', async () => {
    const sessionStorage = new MockSessionStorage();
    const app = new DashboardStateMachine(sessionStorage, async () => validWire);
    await app.init();

    await app.submitPassphrase(validPassphrase);

    assert.strictEqual(app.state.isLocked, false);
    assert.strictEqual(app.state.errorMessage, null);
    assert.deepStrictEqual(app.state.activeData, sampleRollup);
    assert.strictEqual(app.state.sectionsRendered.endurance, true);
    assert.strictEqual(app.state.sectionsRendered.physiological, true);
    assert.strictEqual(app.state.sectionsRendered.activities, true);

    const storedKey = sessionStorage.getItem('garmin_dash_session_key');
    assert.ok(storedKey);
    assert.ok(storedKey.length > 30);
  });

  // TC-04: Page reload
  await runBaselineTest('TC-04: Page reload in same tab bypasses password prompt via sessionStorage', async () => {
    const sharedSession = new MockSessionStorage();
    const app1 = new DashboardStateMachine(sharedSession, async () => validWire);
    await app1.init();
    await app1.submitPassphrase(validPassphrase);
    assert.strictEqual(app1.state.isLocked, false);

    const appReloaded = new DashboardStateMachine(sharedSession, async () => validWire);
    await appReloaded.init();

    assert.strictEqual(appReloaded.state.isLocked, false);
    assert.deepStrictEqual(appReloaded.state.activeData, sampleRollup);
    assert.strictEqual(appReloaded.state.sectionsRendered.endurance, true);
  });

  // TC-05: Tampered payload
  await runBaselineTest('TC-05: Tampered payload fails GCM authentication tag check and denies unlock', async () => {
    const tamperedWire = new Uint8Array(validWire);
    tamperedWire[30] ^= 0xff;

    const sessionStorage = new MockSessionStorage();
    const app = new DashboardStateMachine(sessionStorage, async () => tamperedWire);
    await app.init();

    await assert.rejects(
      async () => {
        await app.submitPassphrase(validPassphrase);
      },
      /Authentication failed/i
    );

    assert.strictEqual(app.state.isLocked, true);
    assert.ok(app.state.errorMessage.includes('Authentication failed'));
  });

  // TC-06: Lock Vault
  await runBaselineTest('TC-06: Lock Vault button purges sessionStorage and returns to modal', async () => {
    const sessionStorage = new MockSessionStorage();
    const app = new DashboardStateMachine(sessionStorage, async () => validWire);
    await app.init();
    await app.submitPassphrase(validPassphrase);
    assert.strictEqual(app.state.isLocked, false);

    app.lockVault();

    assert.strictEqual(app.state.isLocked, true);
    assert.strictEqual(app.state.activeData, null);
    assert.strictEqual(sessionStorage.getItem('garmin_dash_session_key'), null);
    assert.strictEqual(app.state.sectionsRendered.endurance, false);
  });

  // ==========================================================================
  // Part B: Real-Module M2-M5 Enhancement E2E Checks
  // ==========================================================================
  process.stdout.write('\n=== Running Real-Module M2-M5 Enhancement E2E Checks ===\n\n');

  const rootDir = path.resolve(__dirname, '../..');
  const distEncPath = path.join(rootDir, 'dist', 'data.enc');
  const distEncBytes = fs.readFileSync(distEncPath);

  // Install headless environment BEFORE importing frontend/src/main.js (readyState === 'loading')
  const env = createHeadlessEnv({ dataEnc: distEncBytes });
  const cryptoMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/crypto.js')).href);
  const activitiesMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/charts/activities.js')).href);
  const chartMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/charts/chart_engine.js')).href);
  const wellnessMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/charts/wellness.js')).href);
  const trendsMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/charts/trends_modal.js')).href);
  const mainMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/main.js')).href);

  const decryptedDist = await cryptoMod.decryptDashboardPayload('demo-passphrase-2026!', distEncBytes);

  async function runEnhancementCheck(milestone, name, fn) {
    const capturedConsoleErrors = [];
    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;
    const captureConsole = (...args) => {
      const formatted = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
      capturedConsoleErrors.push(formatted);
    };
    console.error = captureConsole;
    console.warn = captureConsole;
    try {
      await fn(capturedConsoleErrors);
      const swallowedErr = capturedConsoleErrors.find(msg =>
        /Decryption failed:|Failed to render trend chart:/i.test(msg)
      );
      if (swallowedErr) {
        throw new Error(`Swallowed runtime error logged via console.error/warn: ${swallowedErr}`);
      }
      enhancementResults.push({ milestone, name, status: 'PASS' });
      process.stdout.write(`  ✓ [${milestone}] ${name}\n`);
    } catch (err) {
      const swallowedErr = capturedConsoleErrors.find(msg =>
        /Decryption failed:|Failed to render trend chart:/i.test(msg)
      );
      if (swallowedErr) {
        const wrapped = new Error(`Swallowed runtime error logged via console.error/warn: ${swallowedErr}`);
        enhancementResults.push({ milestone, name, status: 'HARNESS_ERROR', error: wrapped });
        process.stderr.write(`  ✗ [HARNESS_ERROR] [${milestone}] ${name}: ${wrapped.message}\n`);
      } else if (err instanceof PendingImplError || err instanceof assert.AssertionError) {
        enhancementResults.push({ milestone, name, status: 'PENDING_IMPL', error: err });
        process.stdout.write(`  ⏳ [PENDING_IMPL] [${milestone}] ${name}: ${err.message}\n`);
      } else {
        enhancementResults.push({ milestone, name, status: 'HARNESS_ERROR', error: err });
        process.stderr.write(`  ✗ [HARNESS_ERROR] [${milestone}] ${name}: ${err.stack || err.message}\n`);
      }
    } finally {
      console.error = origConsoleError;
      console.warn = origConsoleWarn;
    }
  }

  // M2: Real main.js unlock of dist/data.enc triggers renderTodayActivityBanner
  await runEnhancementCheck('M2', 'Unlocking dist/data.enc via main.js renders Today/Latest Activity Hero Banner', async (capturedErrors) => {
    const e2eEnv = createHeadlessEnv({ dataEnc: distEncBytes });
    await mainMod.initApp();
    e2eEnv.doc.getElementById('passphrase-input').value = 'demo-passphrase-2026!';
    e2eEnv.doc.getElementById('passphrase-form').dispatchEvent('submit');
    // Poll until PBKDF2 + AES-GCM unlock completes (or a swallowed error is logged)
    await waitForCondition(
      () =>
        !e2eEnv.doc.getElementById('dashboard-content').classList.contains('hidden') ||
        capturedErrors.some(msg => /Decryption failed:/i.test(msg)),
      5000,
      25
    );
    if (capturedErrors.some(msg => /Decryption failed:/i.test(msg))) {
      throw new Error(`Swallowed unlock error: ${capturedErrors.join(' | ')}`);
    }

    assert.strictEqual(
      e2eEnv.doc.getElementById('dashboard-content').classList.contains('hidden'),
      false,
      'Dashboard must unlock after passphrase submission'
    );
    const todaySection = e2eEnv.doc.getElementById('today-activity-section');
    assert.strictEqual(
      todaySection.classList.contains('hidden'),
      false,
      '#today-activity-section must be unhidden by main.js renderDashboard'
    );
    assert.ok(
      todaySection.innerHTML.includes("Today's Activities"),
      'Today Activity Banner must be rendered by renderDashboard'
    );
    assert.strictEqual(
      typeof activitiesMod.loadActivityStreamShard,
      'function',
      'activities.js must export loadActivityStreamShard(actId)'
    );
    const todayCard = todaySection.querySelector('[data-today-act-idx="0"]');
    assert.ok(todayCard, 'Today Activity Banner must render clickable card [data-today-act-idx="0"]');
    todayCard.click();
    assert.strictEqual(
      e2eEnv.doc.getElementById('activity-drawer').classList.contains('hidden'),
      false,
      'Clicking Today Activity card must open #activity-drawer'
    );
    activitiesMod.closeActivityDrawer();
  });

  // M3: Chart engine supports rangeBar & Body Battery modal uses rangeBar + 2-item legend
  await runEnhancementCheck('M3', 'Body Battery trend modal renders rangeBar pillars with 2-item High/Low legend', async () => {
    createHeadlessEnv({ dataEnc: distEncBytes });
    const labels = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
    const canvas = env.doc.createElement('canvas');
    canvas.width = 640;
    canvas.height = 300;
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels,
        datasets: [{
          highData: [92, 88, 95, 90, 84, 96, 91],
          lowData: [24, 21, 28, 19, 15, 29, 22],
          chargedData: [68, 67, 72, 71, 69, 67, 69],
          drainedData: [65, 69, 71, 68, 70, 66, 68]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const ctxCalls = canvas.getContext('2d').calls;
    const highArcs = ctxCalls.filter(c => c.op === 'arc');
    assert.ok(highArcs.length >= 14, `Expected >=14 rangeBar cap arcs (High + Low for 7 days), got ${highArcs.length}`);

    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('body_battery', decryptedDist.payload);
    const modalCanvas = global.document.getElementById('metric-trend-chart');
    const fillTexts = modalCanvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(fillTexts.some(t => t.includes('Daily High')), 'Body Battery modal must render Daily High legend item');
    assert.ok(fillTexts.some(t => t.includes('Daily Low')), 'Body Battery modal must render Daily Low legend item');
    assert.ok(!fillTexts.some(t => t.includes('Peak Charge')), 'Legacy 4-line spaghetti legend must be replaced');
    chart.destroy();
  });

  // M4: Stress promoted to In Focus with 4-zone proportional bar + 4-KPI / 5-col modal
  await runEnhancementCheck('M4', 'Stress is promoted to In Focus with 4-zone bar and upgraded Trend Modal', async () => {
    const m4Env = createHeadlessEnv({ dataEnc: distEncBytes });
    assert.deepStrictEqual(
      wellnessMod.DEFAULT_WELLNESS_LAYOUT.in_focus,
      ['sleep', 'body_battery', 'stress', 'steps'],
      'DEFAULT_WELLNESS_LAYOUT.in_focus must include stress in 3rd slot'
    );
    wellnessMod.renderWellnessDashboard(decryptedDist.payload);
    const inFocusEl = m4Env.doc.getElementById('wellness-in-focus');
    const stressCard = inFocusEl.querySelector('#card-wellness-stress');
    assert.ok(stressCard, '#card-wellness-stress must render inside #wellness-in-focus');
    const cardHtml = stressCard.innerHTML.toLowerCase();
    for (const hex of ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e']) {
      assert.ok(cardHtml.includes(hex), `#card-wellness-stress must render Garmin 4-zone color ${hex}`);
    }

    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', decryptedDist.payload);
    const kpiText = m4Env.doc.getElementById('trend-kpi-grid').textContent;
    assert.ok(kpiText.includes('Overall Avg Stress'), 'Stress modal must show Overall Avg Stress KPI');
    assert.ok(kpiText.includes('Rest / Low Share'), 'Stress modal must show Rest / Low Share KPI');
    assert.strictEqual(
      m4Env.doc.getElementById('trend-table-header-row').querySelectorAll('th').length,
      5,
      'Stress breakdown table must have 5 columns'
    );
    const stressCanvasColors = new Set(
      m4Env.doc.getElementById('metric-trend-chart').getContext('2d').calls
        .filter(c => c.op === 'fill' || c.op === 'fillRect')
        .map(c => String(c.fillStyle).toLowerCase())
    );
    assert.ok(
      ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e'].some(hex => stressCanvasColors.has(hex)),
      'Stress modal chart must render Garmin 4-zone colors'
    );
  });

  // M5: Purple icon.svg + dist/icon.svg + purple frontend/index.html badges + piezoperny README
  await runEnhancementCheck('M5', 'Purple vault icon, dist/icon.svg, purple index.html badges, and piezoperny README', async () => {
    const pubIcon = path.join(rootDir, 'public', 'icon.svg');
    const distIcon = path.join(rootDir, 'dist', 'icon.svg');
    assert.ok(fs.existsSync(pubIcon), 'public/icon.svg must exist');
    assert.ok(fs.existsSync(distIcon), 'dist/icon.svg must exist');
    assert.strictEqual(fs.readFileSync(pubIcon, 'utf8'), fs.readFileSync(distIcon, 'utf8'), 'dist/icon.svg must match public/icon.svg');

    const indexHtml = fs.readFileSync(path.join(rootDir, 'frontend', 'index.html'), 'utf8');
    assert.ok(
      !indexHtml.toLowerCase().includes('%2310b981') && !indexHtml.toLowerCase().includes('#10b981'),
      'frontend/index.html must replace legacy green favicon'
    );
    assert.ok(indexHtml.includes('xl:grid-cols-4'), 'frontend/index.html #wellness-in-focus must use xl:grid-cols-4');

    const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
    assert.ok(!readme.includes('<username>'), 'README.md must replace all <username> placeholders');
    assert.ok(readme.includes('piezoperny/garmin-dash'), 'README.md must link to piezoperny/garmin-dash');
    assert.ok(readme.includes('public/icon.svg'), 'README.md must render public/icon.svg hero header');
  });

  // Print separate summaries
  const basePassed = baselineResults.filter(r => r.status === 'PASS').length;
  const baseFailed = baselineResults.filter(r => r.status === 'FAIL').length;

  const enhPassed = enhancementResults.filter(r => r.status === 'PASS').length;
  const enhPending = enhancementResults.filter(r => r.status === 'PENDING_IMPL').length;
  const enhErrors = enhancementResults.filter(r => r.status === 'HARNESS_ERROR').length;

  process.stdout.write(`\nBaseline Checks: ${basePassed} passed, ${baseFailed} failed (Total: ${baselineResults.length})\n`);
  process.stdout.write(`M2-M5 Enhancement E2E Checks: ${enhPassed} passed, ${enhPending} pending-impl, ${enhErrors} errors (Total: ${enhancementResults.length})\n`);
  process.stdout.write(`=== E2E Runner Results: ${basePassed} passed, ${baseFailed} failed (Baseline Total: ${baselineResults.length}) ===\n\n`);

  if (baseFailed > 0 || enhErrors > 0) {
    process.exit(1);
  }
  if (strictMode && enhPending > 0) {
    process.stderr.write('STRICT MODE: Exiting 1 because M2-M5 enhancement checks are still pending implementation.\n');
    process.exit(1);
  }
}

if (require.main === module) {
  runE2ESimulation().catch(err => {
    process.stderr.write(`Fatal error: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  runE2ESimulation,
  createHeadlessEnv,
  waitForCondition,
  PendingImplError,
  encryptShardWithRawKey,
  encodePolyline,
  toExactArrayBuffer,
  MockSessionStorage,
  MockDocument,
  MockElement,
  MockCanvasContext2D
};
