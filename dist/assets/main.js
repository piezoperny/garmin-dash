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
import {
  renderBackupVaultExplorer
} from './charts/backup_vault.js';
import {
  renderWellnessDashboard,
  loadWellnessLayout,
  saveWellnessLayout,
  setupWellnessEventListeners,
  DEFAULT_WELLNESS_LAYOUT
} from './charts/wellness.js';

const CUSTOMIZATION_STORAGE_KEY = 'garmin_dash_customization';

// Application State
let activeRollup = null;
let activeUnit = 'km'; // 'km' or 'mi'
let activeSportFilter = 'all'; // 'all', 'running', 'cycling', 'strength', etc.
let activeCustomization = {
  wellness_layout: JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT)),
  hidden_cards: [],
  thresholds: {
    max_hr: null,
    lthr: null,
    cycling_ftp: null
  }
};

/**
 * Safely loads customization preferences from localStorage/sessionStorage.
 * @returns {object}
 */
export function loadCustomizationPreferences() {
  try {
    const store = typeof localStorage !== 'undefined' ? localStorage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    if (!store) return activeCustomization;
    const raw = store.getItem(CUSTOMIZATION_STORAGE_KEY);
    if (!raw) return activeCustomization;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      activeCustomization = {
        wellness_layout: parsed.wellness_layout || loadWellnessLayout(),
        hidden_cards: Array.isArray(parsed.hidden_cards) ? parsed.hidden_cards : [],
        thresholds: {
          max_hr: Number(parsed.thresholds?.max_hr) > 0 ? Number(parsed.thresholds.max_hr) : null,
          lthr: Number(parsed.thresholds?.lthr) > 0 ? Number(parsed.thresholds.lthr) : null,
          cycling_ftp: Number(parsed.thresholds?.cycling_ftp) > 0 ? Number(parsed.thresholds.cycling_ftp) : null
        }
      };
    }
  } catch (e) {
    // Graceful recovery from corrupted localStorage
  }
  return activeCustomization;
}

/**
 * Saves customization preferences to localStorage/sessionStorage.
 */
function saveCustomizationPreferences() {
  try {
    const store = typeof localStorage !== 'undefined' ? localStorage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    if (store) {
      store.setItem(CUSTOMIZATION_STORAGE_KEY, JSON.stringify(activeCustomization));
    }
  } catch (e) {
    // Ignore storage quota errors
  }
}

/**
 * Applies card visibility preferences to DOM elements without removing required DOM nodes.
 */
function applyCardVisibility() {
  const configurableCards = [
    'card-weekly-volume',
    'card-training-load',
    'card-hr-zone',
    'card-power-zone',
    'card-pace-zone',
    'card-threshold-trends',
    'card-backup-vault'
  ];
  const hiddenSet = new Set(activeCustomization.hidden_cards || []);
  configurableCards.forEach(cardId => {
    const el = document.getElementById(cardId);
    if (!el) return;
    if (hiddenSet.has(cardId)) {
      el.classList.add('hidden');
    } else {
      el.classList.remove('hidden');
    }
  });
}

/**
 * Dynamically populates sport filter buttons for any additional sports present in activities.
 * @param {Array} activities
 */
function syncDynamicSportFilterButtons(activities) {
  const filterBar = document.getElementById('sport-filter-bar');
  if (!filterBar) return;

  // Remove previously injected dynamic sport buttons
  const existingDynamic = filterBar.querySelectorAll ? filterBar.querySelectorAll('[data-dynamic-sport]') : [];
  existingDynamic.forEach(btn => btn.remove());

  const coreSports = new Set(['all', 'cycling', 'cycle', 'hiking', 'strength', 'weights']);
  const extraSports = new Set();
  for (const act of activities || []) {
    const sp = String(act.sport || '').toLowerCase().trim();
    if (sp && !coreSports.has(sp)) {
      extraSports.add(sp);
    }
  }

  Array.from(extraSports).sort().forEach(sp => {
    const btn = document.createElement('button');
    btn.id = `filter-btn-dyn-${sp}`;
    btn.setAttribute('data-dynamic-sport', sp);
    btn.className = 'px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition';
    btn.textContent = sp.charAt(0).toUpperCase() + sp.slice(1).replace(/_/g, ' ');
    btn.addEventListener('click', () => updateSportFilter(sp));
    filterBar.appendChild(btn);
  });
}

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

  loadCustomizationPreferences();
  applyCardVisibility();
  syncDynamicSportFilterButtons(rollup.activities || []);

  // 0. Health & Fitness Dashboard (Garmin Connect Web Layout: In Focus & At a Glance)
  renderWellnessDashboard(rollup);

  // 1. KPI Cards (reacts to active unit and sport filter)
  renderKPICards(rollup, activeUnit, activeSportFilter);

  // 2. Endurance & Training Load
  renderWeeklyVolumeChart(rollup, activeUnit, activeSportFilter);
  renderTrainingLoadChart(rollup);

  // 3. Physiological Distribution (respecting custom HR / Cycling FTP thresholds)
  renderHeartRateZoneChart(rollup, activeCustomization.thresholds);
  renderPowerZoneChart(rollup, activeCustomization.thresholds);
  renderThresholdTrendsChart(rollup, activeCustomization.thresholds);
  renderPaceZoneChart(rollup);

  // 4. Activity Drill-Down
  renderActivityTable(rollup.activities || [], activeUnit);
  setActivitySportFilter(activeSportFilter);

  // 5. Multi-Year Hetzner Backup Vault Explorer
  renderBackupVaultExplorer(rollup, year => {
    const searchInput = document.getElementById('activity-search');
    if (searchInput) {
      searchInput.value = String(year);
      searchInput.dispatchEvent(new Event('input'));
      const tableEl = document.getElementById('activity-table');
      if (tableEl && typeof tableEl.scrollIntoView === 'function') {
        tableEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
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

  const buttonMap = [
    { id: 'filter-btn-all', match: ['all'] },
    { id: 'filter-btn-cycling', match: ['cycling', 'cycle'] },
    { id: 'filter-btn-running', match: ['running', 'run'] },
    { id: 'filter-btn-walking', match: ['walking', 'walk'] },
    { id: 'filter-btn-hiking', match: ['hiking', 'hike'] },
    { id: 'filter-btn-strength', match: ['strength', 'weights'] },
    { id: 'filter-btn-weights', match: ['strength', 'weights'] }
  ];

  const normalized = (sport || 'all').toLowerCase();

  buttonMap.forEach(({ id, match }) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const isAlias = id === 'filter-btn-weights';
    if (isAlias) {
      btn.className = 'hidden';
      return;
    }
    if (match.includes(normalized)) {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#1f1f24] text-white shadow-sm';
    } else {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition-colors';
    }
  });

  const filterBar = document.getElementById('sport-filter-bar');
  if (filterBar && filterBar.querySelectorAll) {
    filterBar.querySelectorAll('[data-dynamic-sport]').forEach(btn => {
      const sp = btn.getAttribute('data-dynamic-sport');
      if (sp === normalized) {
        btn.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#1f1f24] text-white shadow-sm';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition-colors';
      }
    });
  }

  if (activeRollup) {
    renderKPICards(activeRollup, activeUnit, activeSportFilter);
    renderWeeklyVolumeChart(activeRollup, activeUnit, activeSportFilter);
    setActivitySportFilter(activeSportFilter);
  }
}

/**
 * Sets up the Customize Dashboard & Thresholds modal interactions.
 */
function setupCustomizationModalListeners() {
  const openBtn = document.getElementById('btn-customize-dashboard');
  const closeBtn = document.getElementById('btn-close-customize');
  const saveBtn = document.getElementById('btn-save-customize');
  const resetBtn = document.getElementById('btn-reset-customize');
  const modal = document.getElementById('customize-modal');

  if (!modal) return;

  const syncModalFields = () => {
    loadCustomizationPreferences();
    const hiddenSet = new Set(activeCustomization.hidden_cards || []);
    if (modal.querySelectorAll) {
      modal.querySelectorAll('[data-card-target]').forEach(cb => {
        const cardId = cb.getAttribute('data-card-target');
        cb.checked = !hiddenSet.has(cardId);
      });

      const layout = activeCustomization.wellness_layout || loadWellnessLayout();
      modal.querySelectorAll('[data-wellness-select]').forEach(sel => {
        const metric = sel.getAttribute('data-wellness-select');
        if (layout.in_focus?.includes(metric)) {
          sel.value = 'in_focus';
        } else if (layout.hidden?.includes(metric)) {
          sel.value = 'hidden';
        } else {
          sel.value = 'at_a_glance';
        }
      });
    }
    const maxHrInput = document.getElementById('input-custom-max-hr');
    const lthrInput = document.getElementById('input-custom-lthr');
    const ftpInput = document.getElementById('input-custom-ftp');

    if (maxHrInput) maxHrInput.value = activeCustomization.thresholds?.max_hr || '';
    if (lthrInput) lthrInput.value = activeCustomization.thresholds?.lthr || '';
    if (ftpInput) ftpInput.value = activeCustomization.thresholds?.cycling_ftp || '';
  };

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      syncModalFields();
      modal.classList.remove('hidden');
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const hidden = [];
      if (modal.querySelectorAll) {
        modal.querySelectorAll('[data-card-target]').forEach(cb => {
          const cardId = cb.getAttribute('data-card-target');
          if (!cb.checked && cardId) {
            hidden.push(cardId);
          }
        });
      }

      const newWellnessLayout = { in_focus: [], at_a_glance: [], hidden: [] };
      if (modal.querySelectorAll) {
        modal.querySelectorAll('[data-wellness-select]').forEach(sel => {
          const metric = sel.getAttribute('data-wellness-select');
          const val = sel.value;
          if (metric && newWellnessLayout[val]) {
            newWellnessLayout[val].push(metric);
          }
        });
      }
      if (newWellnessLayout.in_focus.length === 0 && newWellnessLayout.at_a_glance.length === 0) {
        newWellnessLayout.in_focus = activeCustomization.wellness_layout?.in_focus || [...DEFAULT_WELLNESS_LAYOUT.in_focus];
        newWellnessLayout.at_a_glance = activeCustomization.wellness_layout?.at_a_glance || [...DEFAULT_WELLNESS_LAYOUT.at_a_glance];
      }

      const maxHrVal = Number(document.getElementById('input-custom-max-hr')?.value || 0);
      const lthrVal = Number(document.getElementById('input-custom-lthr')?.value || 0);
      const ftpVal = Number(document.getElementById('input-custom-ftp')?.value || 0);

      activeCustomization = {
        wellness_layout: newWellnessLayout,
        hidden_cards: hidden,
        thresholds: {
          max_hr: maxHrVal >= 120 ? maxHrVal : null,
          lthr: lthrVal >= 100 ? lthrVal : null,
          cycling_ftp: ftpVal >= 50 ? ftpVal : null
        }
      };
      saveCustomizationPreferences();
      saveWellnessLayout(newWellnessLayout);
      modal.classList.add('hidden');
      if (activeRollup) {
        renderDashboard(activeRollup);
      } else {
        applyCardVisibility();
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      activeCustomization = {
        wellness_layout: JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT)),
        hidden_cards: [],
        thresholds: { max_hr: null, lthr: null, cycling_ftp: null }
      };
      saveCustomizationPreferences();
      saveWellnessLayout(activeCustomization.wellness_layout);
      syncModalFields();
      if (activeRollup) {
        renderDashboard(activeRollup);
      } else {
        applyCardVisibility();
      }
    });
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
  setupCustomizationModalListeners();
  setupWellnessEventListeners();

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
    { id: 'filter-btn-cycling', sport: 'cycling' },
    { id: 'filter-btn-running', sport: 'running' },
    { id: 'filter-btn-walking', sport: 'walking' },
    { id: 'filter-btn-hiking', sport: 'hiking' },
    { id: 'filter-btn-strength', sport: 'strength' },
    { id: 'filter-btn-weights', sport: 'strength' }
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
