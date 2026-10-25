/**
 * frontend/src/main.js
 * 
 * Application Entry Point, Authentication State Machine, and Dashboard Orchestrator.
 * 
 * Specifications:
 * - Native window.crypto.subtle in-browser decryption
 * - Session caching in sessionStorage (garmin_dash_session_key & garmin_vault_session)
 * - Reload bypass within active session
 * - Three core visualization sections:
 *   1. Endurance & Training Load
 *   2. Physiological Distribution
 *   3. Activity Drill-Down
 */

import { decryptDashboardPayload, decryptWithRawKey } from './crypto.js';
import {
  saveSession,
  getStoredKey,
  getStoredPayload,
  clearSession
} from './session.js';
import {
  renderKPICards,
  renderWeeklyVolumeChart,
  renderTrainingLoadChart
} from './charts/endurance.js';
import {
  renderHeartRateZoneChart,
  renderPowerZoneChart,
  renderThresholdTrendsChart,
  renderPaceZoneChart
} from './charts/physiological.js';
import {
  renderActivityTable,
  setupActivityEventListeners,
  setActivitySportFilter
} from './charts/activities.js';

// Application State
let activeRollup = null;
let activeUnit = 'km'; // 'km' or 'mi'
let activeSportFilter = 'all'; // 'all', 'running', 'cycling', 'strength'

/**
 * Fetches the binary data.enc payload from static root.
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchEncryptedData() {
  const candidates = ['./data.enc', 'data.enc', '/data.enc'];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (resp.ok) {
        return await resp.arrayBuffer();
      }
    } catch (e) {
      // Continue to next candidate
    }
  }
  throw new Error('Encrypted payload data.enc could not be retrieved from static host.');
}

/**
 * Renders all dashboard sections with the decrypted data.
 * @param {object} rollup
 */
function renderDashboard(rollup) {
  if (!rollup) return;
  activeRollup = rollup;

  // 1. KPI Cards
  renderKPICards(rollup, activeUnit);

  // 2. Section 1: Endurance & Training Load
  renderWeeklyVolumeChart(rollup, activeUnit, activeSportFilter);
  renderTrainingLoadChart(rollup);

  // 3. Section 2: Physiological Distribution
  renderHeartRateZoneChart(rollup);
  renderPowerZoneChart(rollup);
  renderThresholdTrendsChart(rollup);
  renderPaceZoneChart(rollup);

  // 4. Section 3: Activity Drill-Down
  renderActivityTable(rollup.activities || [], activeUnit);
}

/**
 * Transitions UI into unlocked state and displays dashboard.
 * @param {object} rollup
 */
function showDashboard(rollup) {
  const modal = document.getElementById('passphrase-modal');
  const dashboard = document.getElementById('dashboard-content');
  const errorBanner = document.getElementById('auth-error-message');

  if (modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  if (errorBanner) {
    errorBanner.classList.add('hidden');
  }

  if (dashboard) {
    dashboard.classList.remove('hidden');
    dashboard.setAttribute('aria-hidden', 'false');
  }

  renderDashboard(rollup);
}

/**
 * Transitions UI into locked state and displays password modal.
 */
function showModal() {
  const modal = document.getElementById('passphrase-modal');
  const dashboard = document.getElementById('dashboard-content');
  const input = document.getElementById('passphrase-input');
  const errorBanner = document.getElementById('auth-error-message');

  if (dashboard) {
    dashboard.classList.add('hidden');
    dashboard.setAttribute('aria-hidden', 'true');
  }

  if (errorBanner) {
    errorBanner.classList.add('hidden');
  }

  if (modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.remove('shake');
  }

  if (input) {
    input.value = '';
    input.removeAttribute('aria-invalid');
    input.focus();
  }
}

/**
 * Displays authentication error with shake animation.
 * @param {string} msg
 */
function showAuthError(msg) {
  const modal = document.getElementById('passphrase-modal');
  const modalContainer = modal ? modal.querySelector('.modal-card') || modal : null;
  const errorBanner = document.getElementById('auth-error-message');
  const input = document.getElementById('passphrase-input');

  if (errorBanner) {
    errorBanner.textContent = msg || 'Authentication failed. Invalid passphrase or corrupted data.';
    errorBanner.classList.remove('hidden');
  }

  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  }

  if (modalContainer) {
    modalContainer.classList.remove('shake');
    // Force DOM reflow to re-trigger animation
    void modalContainer.offsetWidth;
    modalContainer.classList.add('shake');
  }
}

/**
 * Handles Passphrase Submission.
 * @param {Event} e
 */
async function handlePassphraseSubmit(e) {
  if (e) e.preventDefault();

  const input = document.getElementById('passphrase-input');
  const submitBtn = document.getElementById('passphrase-submit');
  const passphrase = input ? input.value : '';

  if (!passphrase) {
    showAuthError('Please enter master passphrase.');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Decrypting...';
  }

  try {
    const wireData = await fetchEncryptedData();
    const { payload, rawKeyBase64 } = await decryptDashboardPayload(passphrase, wireData);

    // Save session in sessionStorage
    saveSession(rawKeyBase64, payload);

    // Display dashboard
    showDashboard(payload);
  } catch (err) {
    console.error('Decryption failed:', err);
    showAuthError('Authentication failed. Invalid passphrase or corrupted data.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock Vault';
    }
  }
}

/**
 * Locks the dashboard and clears all session state.
 */
function handleLockVault() {
  clearSession();
  activeRollup = null;
  showModal();
}

/**
 * Updates sport filter styling and re-renders relevant sections.
 * @param {string} sport
 */
function updateSportFilter(sport) {
  activeSportFilter = sport;

  const buttons = {
    all: document.getElementById('filter-btn-all'),
    running: document.getElementById('filter-btn-running'),
    cycling: document.getElementById('filter-btn-cycling'),
    strength: document.getElementById('filter-btn-strength')
  };

  Object.entries(buttons).forEach(([key, btn]) => {
    if (!btn) return;
    if (key === sport) {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 text-white shadow-sm';
    } else {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors';
    }
  });

  if (activeRollup) {
    renderWeeklyVolumeChart(activeRollup, activeUnit, activeSportFilter);
    setActivitySportFilter(activeSportFilter);
  }
}

/**
 * Toggles distance unit between kilometers and miles.
 */
function toggleDistanceUnit() {
  activeUnit = activeUnit === 'km' ? 'mi' : 'km';
  const toggleBtn = document.getElementById('unit-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = activeUnit.toUpperCase();
  }

  if (activeRollup) {
    renderDashboard(activeRollup);
  }
}

/**
 * Initializes Application and checks for reload bypass.
 */
export async function initApp() {
  setupActivityEventListeners();

  // Attach submit listeners
  const form = document.getElementById('passphrase-form');
  if (form) {
    form.addEventListener('submit', handlePassphraseSubmit);
  }

  const submitBtn = document.getElementById('passphrase-submit');
  if (submitBtn && !form) {
    submitBtn.addEventListener('click', handlePassphraseSubmit);
  }

  // Attach Lock Vault listener
  const lockBtn = document.getElementById('btn-lock-dashboard');
  if (lockBtn) {
    lockBtn.addEventListener('click', handleLockVault);
  }

  // Attach Unit toggle listener
  const unitBtn = document.getElementById('unit-toggle-btn');
  if (unitBtn) {
    unitBtn.addEventListener('click', toggleDistanceUnit);
  }

  // Attach Sport filter buttons
  const sportButtons = [
    { id: 'filter-btn-all', sport: 'all' },
    { id: 'filter-btn-running', sport: 'running' },
    { id: 'filter-btn-cycling', sport: 'cycling' },
    { id: 'filter-btn-strength', sport: 'strength' }
  ];

  sportButtons.forEach(({ id, sport }) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => updateSportFilter(sport));
    }
  });

  // Check for existing session (Reload bypass)
  const cachedPayload = getStoredPayload();
  const cachedKey = getStoredKey();

  if (cachedPayload) {
    showDashboard(cachedPayload);
    return;
  }

  if (cachedKey) {
    try {
      const wireData = await fetchEncryptedData();
      const payload = await decryptWithRawKey(cachedKey, wireData);
      saveSession(cachedKey, payload);
      showDashboard(payload);
      return;
    } catch (err) {
      console.warn('Cached session key invalid or payload modified. Resetting session.', err);
      clearSession();
    }
  }

  // Default: present locked password modal
  showModal();
}

// Bootstrap on DOM ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
