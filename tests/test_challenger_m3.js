/**
 * tests/test_challenger_m3.js
 * 
 * Milestone 3 Adversarial Challenger Empirical Test Suite:
 * Frontend Authentication Flow, Session Lifecycle & Cryptographic Tamper Resistance.
 * 
 * Validates against ORIGINAL_REQUEST.md (R3, AC 3) and PROJECT.md:
 * 1. Initial Lock State: Unconditionally blocks chart rendering & displays modal.
 * 2. Invalid Passphrase Rejection: Strict failure, error banner, shake UX, modal locked.
 * 3. Tamper Rejection: Bit-flipping across Salt, IV, Ciphertext, and Auth Tag slices.
 * 4. Valid Unlock & Visualization: PBKDF2 (600k iter) + AES-GCM decrypt, renders 3 sections.
 * 5. Tab Reload Bypass: sessionStorage persistence with full session and raw key alone.
 * 6. Lock Vault: Complete purge of sessionStorage keys and UI re-locking.
 * 7. Adversarial Session Scenarios: Corrupted sessionStorage keys, tampered payloads on reload,
 *    rapid retries, and unit toggle reactivity.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ============================================================================
// 1. Headless DOM Simulation Engine
// ============================================================================

class MockElement {
  constructor(tag, id = '', className = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this._classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this.disabled = false;
    this.offsetWidth = 100;
    this._focused = false;
    this._selected = false;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  get classList() {
    return {
      add: (...cls) => {
        cls.forEach(c => this._classes.add(c));
        this.className = Array.from(this._classes).join(' ');
      },
      remove: (...cls) => {
        cls.forEach(c => this._classes.delete(c));
        this.className = Array.from(this._classes).join(' ');
      },
      contains: (c) => this._classes.has(c),
      toggle: (c) => {
        if (this._classes.has(c)) {
          this._classes.delete(c);
          this.className = Array.from(this._classes).join(' ');
          return false;
        } else {
          this._classes.add(c);
          this.className = Array.from(this._classes).join(' ');
          return true;
        }
      }
    };
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }

  focus() { this._focused = true; }
  select() { this._selected = true; }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  removeEventListener(event, fn) {
    if (!this.listeners.has(event)) return;
    this.listeners.set(event, this.listeners.get(event).filter(f => f !== fn));
  }

  async dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) {
      await fn(event);
    }
  }

  querySelector(sel) {
    if (sel === 'tbody') {
      return this.children.find(c => c.tagName === 'TBODY') || this._tbody || null;
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.children.find(c => c.classList.contains(cls)) || null;
    }
    return null;
  }

  querySelectorAll(sel) {
    if (sel === 'tbody tr' || sel === 'tr') {
      const tbody = this.querySelector('tbody');
      return tbody ? tbody.children.filter(c => c.tagName === 'TR') : [];
    }
    return [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
}

class MockCanvasElement extends MockElement {
  constructor(id, className) {
    super('canvas', id, className);
    this.width = 600;
    this.height = 400;
    this.renderCalls = 0;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  getContext(type) {
    if (type === '2d') {
      return {
        canvas: this,
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => { this.renderCalls++; },
        stroke: () => { this.renderCalls++; },
        clearRect: () => {},
        fillRect: () => { this.renderCalls++; },
        strokeRect: () => { this.renderCalls++; },
        rect: () => {},
        roundRect: () => {},
        fillText: () => { this.renderCalls++; },
        measureText: (txt) => ({ width: (txt || '').length * 7 }),
        scale: () => {},
        translate: () => {},
        resetTransform: () => {},
        setLineDash: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} })
      };
    }
    return null;
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.readyState = 'complete';
  }

  register(el) {
    if (el.id) this.elements.set(el.id, el);
    return el;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  createElement(tag) {
    if (tag.toLowerCase() === 'canvas') return new MockCanvasElement();
    return new MockElement(tag);
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  removeEventListener(event, fn) {
    if (!this.listeners.has(event)) return;
    this.listeners.set(event, this.listeners.get(event).filter(f => f !== fn));
  }
}

class MockSessionStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
  get length() { return this.store.size; }
  key(index) { return Array.from(this.store.keys())[index] || null; }
}

/**
 * Creates a fresh headless DOM fixture matching dist/index.html.
 */
function createDOMFixture(sharedSession = null) {
  const doc = new MockDocument();
  const session = sharedSession || new MockSessionStorage();

  // Authentication Modal
  const modal = doc.register(new MockElement('div', 'passphrase-modal', 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md'));
  const modalCard = new MockElement('div', '', 'modal-card bg-slate-900 border border-slate-800 rounded-2xl p-8');
  modal.appendChild(modalCard);
  const authError = doc.register(new MockElement('div', 'auth-error-message', 'hidden mb-4 p-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300'));
  const form = doc.register(new MockElement('form', 'passphrase-form'));
  const input = doc.register(new MockElement('input', 'passphrase-input'));
  input.setAttribute('type', 'password');
  const submitBtn = doc.register(new MockElement('button', 'passphrase-submit'));
  submitBtn.textContent = 'Unlock Vault';

  // Dashboard Container (Hidden initially)
  const dashboard = doc.register(new MockElement('div', 'dashboard-content', 'hidden flex-1 flex flex-col'));
  dashboard.setAttribute('aria-hidden', 'true');

  // Controls
  const lockBtn = doc.register(new MockElement('button', 'btn-lock-dashboard'));
  const unitBtn = doc.register(new MockElement('button', 'unit-toggle-btn'));
  unitBtn.textContent = 'KM';

  // Section 1: KPI Cards
  const kpiDist = doc.register(new MockElement('div', 'kpi-total-distance'));
  kpiDist.textContent = '-';
  const kpiTime = doc.register(new MockElement('div', 'kpi-total-time'));
  kpiTime.textContent = '-';
  const kpiLoad = doc.register(new MockElement('div', 'kpi-weekly-load'));
  kpiLoad.textContent = '-';
  const kpiStatus = doc.register(new MockElement('div', 'kpi-status'));
  kpiStatus.textContent = 'Optimal';

  // Section 1: Charts
  const volChart = doc.register(new MockCanvasElement('weekly-volume-chart'));
  const loadChart = doc.register(new MockCanvasElement('training-load-chart'));

  // Section 1: Sport Filter Buttons
  const filterBtnAll = doc.register(new MockElement('button', 'filter-btn-all'));
  const filterBtnRun = doc.register(new MockElement('button', 'filter-btn-running'));
  const filterBtnCyc = doc.register(new MockElement('button', 'filter-btn-cycling'));
  const filterBtnStr = doc.register(new MockElement('button', 'filter-btn-strength'));

  // Section 2: Physiological Charts
  const hrChart = doc.register(new MockCanvasElement('hr-zone-chart'));
  const powerChart = doc.register(new MockCanvasElement('power-zone-chart'));
  const trendsChart = doc.register(new MockCanvasElement('threshold-trends-chart'));
  const paceChart = doc.register(new MockCanvasElement('pace-zone-chart'));

  // Section 3: Activities Table & Controls
  const searchInput = doc.register(new MockElement('input', 'activity-search'));
  const sortSelect = doc.register(new MockElement('select', 'activity-sort'));
  sortSelect.value = 'date-desc';
  const actTable = doc.register(new MockElement('table', 'activity-table'));
  const tbody = new MockElement('tbody');
  actTable._tbody = tbody;
  actTable.appendChild(tbody);

  // Section 3: Drill-Down Drawer
  const actDrawer = doc.register(new MockElement('div', 'activity-drawer', 'fixed inset-0 z-50 hidden'));
  const drawerBackdrop = doc.register(new MockElement('div', 'drawer-backdrop'));
  const closeDrawerBtn = doc.register(new MockElement('button', 'btn-close-drawer'));
  const drawerTitle = doc.register(new MockElement('h3', 'drawer-activity-title'));
  const drawerDate = doc.register(new MockElement('p', 'drawer-activity-date'));
  const drawerKpiDist = doc.register(new MockElement('div', 'drawer-kpi-dist'));
  const drawerKpiDur = doc.register(new MockElement('div', 'drawer-kpi-duration'));
  const drawerKpiHR = doc.register(new MockElement('div', 'drawer-kpi-hr'));
  const drawerKpiCad = doc.register(new MockElement('div', 'drawer-kpi-cadence'));
  const drawerKpiElev = doc.register(new MockElement('div', 'drawer-kpi-elevation'));
  const drawerKpiCal = doc.register(new MockElement('div', 'drawer-kpi-calories'));
  const drawerSplitsTbody = doc.register(new MockElement('tbody', 'drawer-splits-tbody'));
  const drawerChart = doc.register(new MockCanvasElement('activity-profile-chart'));

  // Window Listeners
  const windowListeners = new Map();
  const mockWindow = {
    document: doc,
    sessionStorage: session,
    crypto: global.crypto,
    devicePixelRatio: 1,
    addEventListener: (ev, fn) => {
      if (!windowListeners.has(ev)) windowListeners.set(ev, []);
      windowListeners.get(ev).push(fn);
    },
    removeEventListener: (ev, fn) => {
      if (!windowListeners.has(ev)) return;
      windowListeners.set(ev, windowListeners.get(ev).filter(f => f !== fn));
    },
    dispatchEvent: async (ev) => {
      const fns = windowListeners.get(ev.type) || [];
      for (const fn of fns) await fn(ev);
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary')
  };

  return {
    doc,
    session,
    mockWindow,
    elements: {
      modal,
      modalCard,
      authError,
      form,
      input,
      submitBtn,
      dashboard,
      lockBtn,
      unitBtn,
      kpiDist,
      kpiTime,
      kpiLoad,
      kpiStatus,
      volChart,
      loadChart,
      hrChart,
      powerChart,
      trendsChart,
      paceChart,
      filterBtnAll,
      filterBtnRun,
      filterBtnCyc,
      filterBtnStr,
      searchInput,
      sortSelect,
      actTable,
      tbody,
      actDrawer,
      drawerBackdrop,
      closeDrawerBtn,
      drawerTitle,
      drawerDate,
      drawerKpiDist,
      drawerKpiDur,
      drawerKpiHR,
      drawerKpiCad,
      drawerKpiElev,
      drawerKpiCal,
      drawerSplitsTbody,
      drawerChart
    }
  };
}

// ============================================================================
// 2. Test Execution & Assertion Harness
// ============================================================================

async function runChallengerTestSuite() {
  process.stdout.write('\n======================================================================\n');
  process.stdout.write('   Milestone 3 Adversarial Challenger Empirical Test Suite            \n');
  process.stdout.write('   Auth Flow, Session Lifecycle & Cryptographic Tamper Resistance     \n');
  process.stdout.write('======================================================================\n\n');

  const results = [];
  const validPassphrase = 'demo-passphrase-2026!';
  const encFilePath = path.resolve(__dirname, '../dist/data.enc');
  assert.ok(fs.existsSync(encFilePath), 'dist/data.enc must exist on disk for tests');
  const authenticEncBuffer = fs.readFileSync(encFilePath);

  // Load modules
  const cryptoModulePath = 'file:///' + path.resolve(__dirname, '../dist/assets/crypto.js').replace(/\\/g, '/');
  const cryptoModule = await import(cryptoModulePath);

  const sessionModulePath = 'file:///' + path.resolve(__dirname, '../dist/assets/session.js').replace(/\\/g, '/');
  const sessionModule = await import(sessionModulePath);

  const mainModulePath = 'file:///' + path.resolve(__dirname, '../dist/assets/main.js').replace(/\\/g, '/');
  const mainModule = await import(mainModulePath);

  async function test(id, description, fn) {
    try {
      await fn();
      results.push({ id, description, status: 'PASS' });
      process.stdout.write(`  [PASS] ${id}: ${description}\n`);
    } catch (err) {
      results.push({ id, description, status: 'FAIL', error: err });
      process.stderr.write(`  [FAIL] ${id}: ${description}\n`);
      process.stderr.write(`         Error: ${err.message}\n`);
      if (err.stack) {
        const stackLines = err.stack.split('\n').slice(1, 3).join('\n');
        process.stderr.write(`         ${stackLines}\n`);
      }
    }
  }

  function setupGlobalEnv(fixture, wireBufferSupplier) {
    global.document = fixture.doc;
    global.window = fixture.mockWindow;
    global.sessionStorage = fixture.session;
    global.fetch = async (url) => {
      const buffer = await wireBufferSupplier(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      };
    };
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Initial Lock State
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 1: Initial Lock State & Rendering Prevention ---\n');

  await test('TC-M3-01', 'Fresh session unconditionally blocks chart rendering and displays password modal', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();

    const { modal, dashboard } = fixture.elements;
    assert.strictEqual(modal.classList.contains('hidden'), false, 'Modal must NOT have hidden class');
    assert.strictEqual(modal.getAttribute('aria-hidden'), 'false', 'Modal aria-hidden must be false');
    assert.strictEqual(dashboard.classList.contains('hidden'), true, 'Dashboard container must have hidden class');
    assert.strictEqual(dashboard.getAttribute('aria-hidden'), 'true', 'Dashboard aria-hidden must be true');
  });

  await test('TC-M3-02', 'Passphrase input is present, blank, and auto-focused on fresh entry', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();

    const { input } = fixture.elements;
    assert.strictEqual(input.value, '', 'Input value must be empty initially');
    assert.strictEqual(input._focused, true, 'Input must receive auto-focus on startup');
    assert.strictEqual(input.hasAttribute('aria-invalid'), false, 'aria-invalid must not be present initially');
  });

  await test('TC-M3-03', 'Submitting empty passphrase displays validation error and stays locked', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, authError, dashboard, modal } = fixture.elements;

    // Submit with empty input
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false, 'Modal must remain visible');
    assert.strictEqual(dashboard.classList.contains('hidden'), true, 'Dashboard must remain hidden');
    assert.strictEqual(authError.classList.contains('hidden'), false, 'Error banner must be visible');
    assert.ok(authError.textContent.includes('Please enter master passphrase'), 'Error must prompt for passphrase');
    assert.strictEqual(fixture.session.length, 0, 'No keys must be saved in sessionStorage');
  });

  await test('TC-M3-04', 'Initial DOM contains zero decrypted metrics or athlete records', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { kpiDist, kpiTime, kpiLoad, tbody } = fixture.elements;

    assert.strictEqual(kpiDist.textContent, '-', 'Distance KPI must be unpopulated');
    assert.strictEqual(kpiTime.textContent, '-', 'Time KPI must be unpopulated');
    assert.strictEqual(kpiLoad.textContent, '-', 'Load KPI must be unpopulated');
    assert.strictEqual(tbody.children.length, 0, 'Activity table must contain 0 rows');
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 2: Invalid Passphrase Rejection & Error UX
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 2: Invalid Passphrase Rejection & Error UX ---\n');

  await test('TC-M3-05', 'Incorrect passphrase guess fails AES-256-GCM decryption with error banner', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, authError, dashboard, modal, submitBtn } = fixture.elements;

    input.value = 'wrong-password-guess-1234!';
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false, 'Modal must remain open');
    assert.strictEqual(dashboard.classList.contains('hidden'), true, 'Dashboard must remain hidden');
    assert.strictEqual(authError.classList.contains('hidden'), false, 'Error banner must be shown');
    assert.ok(authError.textContent.includes('Authentication failed'), 'Error text must indicate auth failure');
    assert.strictEqual(input.getAttribute('aria-invalid'), 'true', 'Input aria-invalid must be set to true');
    assert.strictEqual(submitBtn.disabled, false, 'Submit button must re-enable');
    assert.strictEqual(submitBtn.textContent, 'Unlock Vault', 'Submit button text must reset');
    assert.strictEqual(fixture.session.length, 0, 'sessionStorage must remain completely empty');
  });

  await test('TC-M3-06', 'Near-miss passphrase (single punctuation difference) strictly fails unlock', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, authError, dashboard, modal } = fixture.elements;

    // 'demo-passphrase-2026.' vs valid 'demo-passphrase-2026!'
    input.value = 'demo-passphrase-2026.';
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-07', 'Modal card triggers shake animation on authentication failure', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, modalCard } = fixture.elements;

    input.value = 'bad-pass';
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.ok(modalCard.classList.contains('shake'), 'Modal container must receive shake class');
  });

  await test('TC-M3-08', 'Multiple repeated failed attempts maintain lock without state leakage', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, dashboard, modal } = fixture.elements;

    const badPassphrases = ['bad1', 'bad2', 'admin', 'password', '12345678'];
    for (const bad of badPassphrases) {
      input.value = bad;
      await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
      assert.strictEqual(modal.classList.contains('hidden'), false);
      assert.strictEqual(dashboard.classList.contains('hidden'), true);
      assert.strictEqual(fixture.session.length, 0);
    }
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 3: Tamper Rejection across Wire Format Slices
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 3: Cryptographic Tamper Rejection across Wire Slices ---\n');

  await test('TC-M3-09', 'Salt Slice Tamper: byte 0 bit-flip fails GCM auth tag check and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[0] ^= 0x01; // flip bit 0 of salt

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-10', 'Salt Slice Tamper: byte 15 bit-flip fails GCM auth tag check and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[15] ^= 0x80; // flip bit 7 of salt end

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-11', 'IV Slice Tamper: byte 16 bit-flip fails GCM auth tag check and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[16] ^= 0x01; // flip bit 0 of IV start

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-12', 'IV Slice Tamper: byte 27 bit-flip fails GCM auth tag check and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[27] ^= 0x08; // flip bit 3 of IV end

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-13', 'Ciphertext Slice Tamper: byte 28 (start) bit-flip fails GCM tag and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[28] ^= 0x01; // flip bit 0 of ciphertext start

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-14', 'Ciphertext Slice Tamper: middle byte bit-flip fails GCM tag and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[1000] ^= 0x55; // flip multiple bits in middle of ciphertext

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-15', 'Auth Tag Slice Tamper: byte len-16 (tag start) bit-flip fails and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    const tagStart = tampered.length - 16;
    tampered[tagStart] ^= 0x01; // flip bit 0 of GCM tag

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-16', 'Auth Tag Slice Tamper: byte len-1 (tag end) bit-flip fails and denies unlock', async () => {
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[tampered.length - 1] ^= 0x80; // flip bit 7 of last tag byte

    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => tampered);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  await test('TC-M3-17', 'Envelope Truncation: payloads < 44 bytes rejected before SubtleCrypto invocation', async () => {
    const truncatedLengths = [0, 15, 27, 28, 43];
    for (const len of truncatedLengths) {
      const truncated = Buffer.alloc(len, 0xaa);
      const fixture = createDOMFixture();
      setupGlobalEnv(fixture, async () => truncated);

      await mainModule.initApp();
      const { form, input, dashboard, modal, authError } = fixture.elements;

      input.value = validPassphrase;
      await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

      assert.strictEqual(modal.classList.contains('hidden'), false, `Must reject length ${len}`);
      assert.strictEqual(dashboard.classList.contains('hidden'), true, `Must stay hidden for length ${len}`);
      assert.strictEqual(authError.classList.contains('hidden'), false);
      assert.strictEqual(fixture.session.length, 0);
    }
  });

  await test('TC-M3-18', 'Appended Trailing Garbage: extra bytes appended to wire payload fail GCM check', async () => {
    const trailingGarbage = Buffer.concat([authenticEncBuffer, Buffer.from('TRAILING_GARBAGE_BYTES_INJECTION_TEST')]);
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => trailingGarbage);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(dashboard.classList.contains('hidden'), true);
    assert.strictEqual(authError.classList.contains('hidden'), false);
    assert.strictEqual(fixture.session.length, 0);
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 4: Valid Unlock & 3 Core Visualization Sections
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 4: Valid Unlock & 3 Core Visualization Sections ---\n');

  await test('TC-M3-19', 'Valid passphrase decrypts data.enc, hides modal, and reveals dashboard', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, dashboard, modal, authError } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(modal.classList.contains('hidden'), true, 'Modal must have hidden class');
    assert.strictEqual(modal.getAttribute('aria-hidden'), 'true', 'Modal aria-hidden must be true');
    assert.strictEqual(dashboard.classList.contains('hidden'), false, 'Dashboard must NOT have hidden class');
    assert.strictEqual(dashboard.getAttribute('aria-hidden'), 'false', 'Dashboard aria-hidden must be false');
    assert.strictEqual(authError.classList.contains('hidden'), true, 'Error banner must be hidden');
  });

  await test('TC-M3-20', 'Section 1 (Endurance & Training Load): KPI cards and charts populated', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, kpiDist, kpiTime, kpiLoad, kpiStatus, volChart, loadChart } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // Verify KPI Card text values
    assert.ok(kpiDist.textContent.includes('km'), `Distance KPI must contain km: ${kpiDist.textContent}`);
    assert.notStrictEqual(kpiDist.textContent, '-', 'Distance KPI must not be default hyphen');
    assert.ok(kpiTime.textContent.includes('h'), `Time KPI must contain hours: ${kpiTime.textContent}`);
    assert.notStrictEqual(kpiTime.textContent, '-', 'Time KPI must not be default hyphen');
    assert.ok(kpiLoad.textContent.includes('TSS/wk'), `Load KPI must contain TSS/wk: ${kpiLoad.textContent}`);
    assert.ok(['Optimal', 'Productive', 'Recovery', 'Overreaching'].includes(kpiStatus.textContent.trim()), `Status KPI invalid: ${kpiStatus.textContent}`);

    // Verify Section 1 Canvas rendering
    assert.ok(volChart.renderCalls > 0, 'Volume chart canvas must have render operations executed');
    assert.ok(loadChart.renderCalls > 0, 'Training load chart canvas must have render operations executed');
  });

  await test('TC-M3-21', 'Section 2 (Physiological Distribution): HR, power, and threshold curves rendered', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, hrChart, powerChart, trendsChart } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.ok(hrChart.renderCalls > 0, 'HR zone chart canvas must have render operations executed');
    assert.ok(powerChart.renderCalls > 0, 'Power zone chart canvas must have render operations executed');
    assert.ok(trendsChart.renderCalls > 0, 'Threshold progression chart canvas must have render operations executed');
  });

  await test('TC-M3-22', 'Section 3 (Activity Drill-Down): Table populated with 49 activities and filter reactivity', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, tbody, filterBtnRun, filterBtnAll } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // Must have exactly 49 activities from generated rollup
    assert.strictEqual(tbody.children.length, 49, 'Activity table must contain exactly 49 rows');

    // Test Sport Filter reactivity: switch to Running
    await filterBtnRun.dispatchEvent({ type: 'click' });
    const runningCount = tbody.children.length;
    assert.ok(runningCount > 0 && runningCount < 49, `Running count must be subset of 49: ${runningCount}`);

    // Switch back to All
    await filterBtnAll.dispatchEvent({ type: 'click' });
    assert.strictEqual(tbody.children.length, 49, 'Activity table must restore all 49 rows');
  });

  await test('TC-M3-23', 'Activity Drawer opens on row click with split breakdown and closes cleanly', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input, tbody, actDrawer, closeDrawerBtn, drawerTitle, drawerSplitsTbody } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // Click first activity row
    const firstRow = tbody.children[0];
    assert.ok(firstRow, 'First row must exist');
    await firstRow.dispatchEvent({ type: 'click' });

    // Drawer must be revealed
    assert.strictEqual(actDrawer.classList.contains('hidden'), false, 'Activity drawer must not be hidden');
    assert.ok(drawerTitle.textContent.length > 0, 'Drawer title must be populated');
    assert.ok(drawerSplitsTbody.children.length > 0, 'Drawer splits table must be populated');

    // Close drawer via close button
    await closeDrawerBtn.dispatchEvent({ type: 'click' });
    assert.strictEqual(actDrawer.classList.contains('hidden'), true, 'Activity drawer must be hidden after close');
  });

  await test('TC-M3-24', 'Session Storage caches raw 32-byte key and decrypted JSON payload', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    const { form, input } = fixture.elements;

    input.value = validPassphrase;
    await form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    const rawKey = fixture.session.getItem('garmin_dash_session_key');
    assert.ok(rawKey, 'garmin_dash_session_key must be present in sessionStorage');
    assert.strictEqual(rawKey.length, 44, 'Base64 encoded 32-byte AES key must be 44 chars');

    const vaultSession = fixture.session.getItem('garmin_vault_session');
    assert.ok(vaultSession, 'garmin_vault_session must be present in sessionStorage');
    const parsed = JSON.parse(vaultSession);
    assert.strictEqual(parsed.version, '1.0.0');
    assert.strictEqual(parsed.activities.length, 49);
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 5: Tab Reload Bypass & Session Lifecycle
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 5: Tab Reload Bypass & Session Lifecycle ---\n');

  await test('TC-M3-25', 'Full session reload bypass: page reload in same tab bypasses password modal', async () => {
    const sharedSession = new MockSessionStorage();

    // 1. Initial login in tab 1
    const fixture1 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture1, async () => authenticEncBuffer);
    await mainModule.initApp();
    fixture1.elements.input.value = validPassphrase;
    await fixture1.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
    assert.strictEqual(fixture1.elements.modal.classList.contains('hidden'), true);
    assert.strictEqual(fixture1.elements.dashboard.classList.contains('hidden'), false);

    // 2. Simulate page reload (new DOM sharing same sessionStorage)
    const fixture2 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture2, async () => authenticEncBuffer);
    await mainModule.initApp();

    // Password modal must be bypassed immediately without entering passphrase!
    assert.strictEqual(fixture2.elements.modal.classList.contains('hidden'), true, 'Modal must remain hidden on reload');
    assert.strictEqual(fixture2.elements.dashboard.classList.contains('hidden'), false, 'Dashboard must be visible on reload');
    assert.strictEqual(fixture2.elements.tbody.children.length, 49, 'Activities must be hydrated from session');
  });

  await test('TC-M3-26', 'Raw-key-only reload bypass: decrypts wire data via cached AES key without PBKDF2', async () => {
    const sharedSession = new MockSessionStorage();

    // 1. Initial login in tab 1
    const fixture1 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture1, async () => authenticEncBuffer);
    await mainModule.initApp();
    fixture1.elements.input.value = validPassphrase;
    await fixture1.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // 2. Delete garmin_vault_session to simulate payload cache-miss (leaving only garmin_dash_session_key)
    sharedSession.removeItem('garmin_vault_session');
    assert.strictEqual(sharedSession.getItem('garmin_vault_session'), null);
    assert.ok(sharedSession.getItem('garmin_dash_session_key'));

    // 3. Reload: initApp() should detect raw key, fetch data.enc, decrypt instantly, and render!
    const fixture2 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture2, async () => authenticEncBuffer);
    await mainModule.initApp();

    assert.strictEqual(fixture2.elements.modal.classList.contains('hidden'), true, 'Modal must remain hidden with raw key');
    assert.strictEqual(fixture2.elements.dashboard.classList.contains('hidden'), false, 'Dashboard must be visible with raw key');
    assert.strictEqual(fixture2.elements.tbody.children.length, 49, '49 activities must be decrypted');
    assert.ok(sharedSession.getItem('garmin_vault_session'), 'garmin_vault_session must be restored');
  });

  await test('TC-M3-27', 'Corrupted session key on reload purges session and displays locked modal', async () => {
    const sharedSession = new MockSessionStorage();
    // Set invalid base64 key
    sharedSession.setItem('garmin_dash_session_key', 'INVALID_BASE64_CORRUPTED_KEY_BYTES_123456789==');

    const fixture = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture, async () => authenticEncBuffer);
    await mainModule.initApp();

    assert.strictEqual(fixture.elements.modal.classList.contains('hidden'), false, 'Modal must be shown on corrupted key');
    assert.strictEqual(fixture.elements.dashboard.classList.contains('hidden'), true, 'Dashboard must stay hidden');
    assert.strictEqual(sharedSession.length, 0, 'Corrupted session must be purged');
  });

  await test('TC-M3-28', 'Tampered data.enc on reload with raw key fails GCM check, purges, and locks', async () => {
    const sharedSession = new MockSessionStorage();

    // 1. Initial valid unlock to populate session key
    const fixture1 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture1, async () => authenticEncBuffer);
    await mainModule.initApp();
    fixture1.elements.input.value = validPassphrase;
    await fixture1.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // Purge cached decrypted payload so it must decrypt wire data
    sharedSession.removeItem('garmin_vault_session');

    // 2. Host serves tampered wire data
    const tampered = Buffer.from(authenticEncBuffer);
    tampered[50] ^= 0xff; // bit-flip in ciphertext

    const fixture2 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture2, async () => tampered);
    await mainModule.initApp();

    assert.strictEqual(fixture2.elements.modal.classList.contains('hidden'), false, 'Modal must be shown on tampered payload');
    assert.strictEqual(fixture2.elements.dashboard.classList.contains('hidden'), true, 'Dashboard must stay hidden');
    assert.strictEqual(sharedSession.length, 0, 'Session must be purged after tamper detection');
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 6: Lock Vault Button & Complete Purge
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 6: Lock Vault Button & Complete Purge ---\n');

  await test('TC-M3-29', 'Clicking Lock Vault purges sessionStorage and transitions UI to modal', async () => {
    const sharedSession = new MockSessionStorage();
    const fixture = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    fixture.elements.input.value = validPassphrase;
    await fixture.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    // Verify unlocked
    assert.strictEqual(fixture.elements.modal.classList.contains('hidden'), true);
    assert.strictEqual(fixture.elements.dashboard.classList.contains('hidden'), false);
    assert.ok(sharedSession.getItem('garmin_dash_session_key'));

    // Click Lock Vault button
    await fixture.elements.lockBtn.dispatchEvent({ type: 'click' });

    // Verify completely locked
    assert.strictEqual(fixture.elements.modal.classList.contains('hidden'), false, 'Modal must be revealed after lock');
    assert.strictEqual(fixture.elements.modal.getAttribute('aria-hidden'), 'false');
    assert.strictEqual(fixture.elements.dashboard.classList.contains('hidden'), true, 'Dashboard must be hidden after lock');
    assert.strictEqual(fixture.elements.dashboard.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(fixture.elements.input.value, '', 'Passphrase input must be cleared');

    // Verify cryptographic keys purged
    assert.strictEqual(sharedSession.getItem('garmin_dash_session_key'), null);
    assert.strictEqual(sharedSession.getItem('garmin_vault_session'), null);
    assert.strictEqual(sharedSession.length, 0, 'sessionStorage must have 0 items');
  });

  await test('TC-M3-30', 'Post-lock tab reload unconditionally stays locked in password modal', async () => {
    const sharedSession = new MockSessionStorage();
    const fixture1 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture1, async () => authenticEncBuffer);

    await mainModule.initApp();
    fixture1.elements.input.value = validPassphrase;
    await fixture1.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
    await fixture1.elements.lockBtn.dispatchEvent({ type: 'click' });

    // Reload tab
    const fixture2 = createDOMFixture(sharedSession);
    setupGlobalEnv(fixture2, async () => authenticEncBuffer);
    await mainModule.initApp();

    assert.strictEqual(fixture2.elements.modal.classList.contains('hidden'), false, 'Must stay locked after reload');
    assert.strictEqual(fixture2.elements.dashboard.classList.contains('hidden'), true, 'Dashboard must stay hidden');
    assert.strictEqual(fixture2.elements.tbody.children.length, 0, 'No activities rendered');
  });

  // --------------------------------------------------------------------------
  // TEST GROUP 7: Adversarial Edge Cases & UI Reactivity
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Group 7: Adversarial Edge Cases & UI Reactivity ---\n');

  await test('TC-M3-31', 'Unit Toggle reactivity: toggles distance units between KM and MI dynamically', async () => {
    const fixture = createDOMFixture();
    setupGlobalEnv(fixture, async () => authenticEncBuffer);

    await mainModule.initApp();
    fixture.elements.input.value = validPassphrase;
    await fixture.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    const { unitBtn, kpiDist } = fixture.elements;
    assert.ok(kpiDist.textContent.includes('km'));

    // Toggle to MI
    await unitBtn.dispatchEvent({ type: 'click' });
    assert.strictEqual(unitBtn.textContent, 'MI');
    assert.ok(kpiDist.textContent.includes('mi'), `Distance must update to miles: ${kpiDist.textContent}`);

    // Toggle back to KM
    await unitBtn.dispatchEvent({ type: 'click' });
    assert.strictEqual(unitBtn.textContent, 'KM');
    assert.ok(kpiDist.textContent.includes('km'), `Distance must update back to km: ${kpiDist.textContent}`);
  });

  await test('TC-M3-32', 'Submit button disabled during decryption prevents race condition', async () => {
    const fixture = createDOMFixture();
    let wasDisabledDuringDecrypt = false;
    let buttonTextDuringDecrypt = null;

    global.document = fixture.doc;
    global.window = fixture.mockWindow;
    global.sessionStorage = fixture.session;
    global.fetch = async () => {
      wasDisabledDuringDecrypt = fixture.elements.submitBtn.disabled;
      buttonTextDuringDecrypt = fixture.elements.submitBtn.textContent;
      const buf = authenticEncBuffer;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      };
    };

    await mainModule.initApp();
    fixture.elements.input.value = validPassphrase;
    await fixture.elements.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(wasDisabledDuringDecrypt, true, 'Submit button must be disabled during decryption');
    assert.strictEqual(buttonTextDuringDecrypt, 'Decrypting...', 'Submit button must display Decrypting...');
    assert.strictEqual(fixture.elements.submitBtn.disabled, false, 'Submit button must re-enable afterwards');
  });

  await test('TC-M3-33', 'Source vs Distribution parity: frontend/src/ and dist/assets/ match functionality', async () => {
    const srcCryptoPath = 'file:///' + path.resolve(__dirname, '../frontend/src/crypto.js').replace(/\\/g, '/');
    const srcCryptoModule = await import(srcCryptoPath);

    const { payload: srcPayload } = await srcCryptoModule.decryptDashboardPayload(validPassphrase, authenticEncBuffer);
    const { payload: distPayload } = await cryptoModule.decryptDashboardPayload(validPassphrase, authenticEncBuffer);

    assert.deepStrictEqual(srcPayload, distPayload, 'Decrypted payloads between src and dist must be byte-for-byte identical');
  });

  // --------------------------------------------------------------------------
  // Summary & Exit Verdict
  // --------------------------------------------------------------------------
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;

  process.stdout.write('\n======================================================================\n');
  process.stdout.write(`   Challenger Results: ${passed} PASSED, ${failed} FAILED (Total: ${total})\n`);
  process.stdout.write(`   Verdict: ${failed === 0 ? 'CONFIRMED' : 'FAILED'}\n`);
  process.stdout.write('======================================================================\n\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runChallengerTestSuite().catch((err) => {
    process.stderr.write(`Fatal test harness error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { runChallengerTestSuite };
