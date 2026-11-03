/**
 * frontend/src/charts/backup_vault.js
 *
 * Multi-Year Hetzner Storage Box Backup Vault Explorer UI.
 * Displays long-term archival health, chronological YYYY/MM partitioning status,
 * multi-year activity counts, and backed-up raw file formats (FIT, GPX, JSON).
 */

/**
 * Computes backup vault metadata with fallback derivation from activities list
 * if an older rollup payload lacks `backup_vault`.
 * @param {object} rollup
 * @returns {object}
 */
export function resolveBackupVaultMetadata(rollup) {
  const activities = rollup?.activities || [];
  const rawVault = rollup?.backup_vault || {};

  const derivedByYear = {};
  for (const act of activities) {
    const dateStr = String(act.date || '');
    const yr = dateStr.length >= 4 && /^\d{4}/.test(dateStr) ? dateStr.slice(0, 4) : '2026';
    derivedByYear[yr] = (derivedByYear[yr] || 0) + 1;
  }

  const byYear =
    rawVault.activities_by_year && Object.keys(rawVault.activities_by_year).length > 0
      ? rawVault.activities_by_year
      : derivedByYear;

  const totalActivities =
    Number(rawVault.total_activities) > 0
      ? Number(rawVault.total_activities)
      : activities.length;

  return {
    status: rawVault.status || 'healthy',
    storage_provider: rawVault.storage_provider || 'Hetzner Storage Box (SFTP Port 23)',
    archive_structure: 'garmin_archive/activities/{YYYY}/{MM}/',
    total_activities: totalActivities,
    activities_by_year: byYear,
    last_backup_datetime: rawVault.last_backup_datetime || rollup?.generated_at || null,
    formats: Array.isArray(rawVault.formats) && rawVault.formats.length > 0
      ? rawVault.formats
      : ['FIT', 'GPX', 'JSON'],
    verified_integrity: rawVault.verified_integrity !== false
  };
}

/**
 * Renders the Multi-Year Hetzner Backup Vault Explorer panel.
 * @param {object} rollup
 * @param {function} [onSelectYear] - Optional callback when user clicks a year card to filter activities
 */
export function renderBackupVaultExplorer(rollup, onSelectYear = null) {
  const container = document.getElementById('backup-vault-explorer');
  if (!container) return;

  const vault = resolveBackupVaultMetadata(rollup);

  const statusEl = document.getElementById('vault-status-badge');
  if (statusEl) {
    const isHealthy = vault.status === 'healthy';
    statusEl.textContent = isHealthy ? 'ARCHIVAL HEALTHY' : String(vault.status).toUpperCase();
    statusEl.className = isHealthy
      ? 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-amber-400 border-amber-500/30 bg-amber-500/10';
  }

  const providerEl = document.getElementById('vault-provider-label');
  if (providerEl) {
    providerEl.textContent = `${vault.storage_provider} • ${vault.archive_structure}`;
  }

  const totalEl = document.getElementById('vault-total-activities');
  if (totalEl) {
    totalEl.textContent = `${vault.total_activities.toLocaleString()} workouts`;
  }

  const lastSyncEl = document.getElementById('vault-last-sync');
  if (lastSyncEl) {
    if (vault.last_backup_datetime) {
      const dt = new Date(vault.last_backup_datetime);
      lastSyncEl.textContent = Number.isNaN(dt.getTime())
        ? String(vault.last_backup_datetime)
        : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } else {
      lastSyncEl.textContent = 'Synced via GitHub Actions (6h cron)';
    }
  }

  const formatsEl = document.getElementById('vault-formats-list');
  if (formatsEl) {
    formatsEl.innerHTML = '';
    vault.formats.forEach(fmt => {
      const badge = document.createElement('span');
      badge.className = 'px-2 py-0.5 rounded bg-[#18181b] border border-[#1f1f24] text-[10px] font-mono text-zinc-300';
      badge.textContent = `.${String(fmt).toLowerCase()}`;
      formatsEl.appendChild(badge);
    });
  }

  const yearsGrid = document.getElementById('vault-years-grid');
  if (yearsGrid) {
    yearsGrid.innerHTML = '';
    const years = Object.keys(vault.activities_by_year).sort((a, b) => b.localeCompare(a));
    const maxCount = Math.max(1, ...Object.values(vault.activities_by_year).map(n => Number(n) || 0));

    years.forEach(yr => {
      const count = Number(vault.activities_by_year[yr]) || 0;
      const pct = Math.min(100, Math.max(8, Math.round((count / maxCount) * 100)));

      const card = document.createElement('div');
      card.className = 'bg-[#18181b]/60 hover:bg-[#1f1f24]/80 border border-[#1f1f24] rounded-lg p-3 transition cursor-pointer';
      card.setAttribute('data-archive-year', yr);
      card.innerHTML = `
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-xs font-semibold font-mono text-white">${yr} Archive</span>
          <span class="text-[11px] font-mono text-emerald-400 tabular-nums">${count} files</span>
        </div>
        <div class="w-full h-1.5 bg-[#09090b] rounded-full overflow-hidden">
          <div class="h-full bg-emerald-400/80 rounded-full" style="width: ${pct}%"></div>
        </div>
        <div class="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
          <span>/activities/${yr}/01..12</span>
          <span>FIT • GPX • JSON</span>
        </div>
      `;

      if (typeof onSelectYear === 'function') {
        card.addEventListener('click', () => onSelectYear(yr));
      }
      yearsGrid.appendChild(card);
    });
  }
}
