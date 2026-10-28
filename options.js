import { DEFAULT_SETTINGS } from './lib/util.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let statusTimer;

function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}

function fill() {
  $('defaultFormat').value = settings.defaultFormat;
  $('subfolder').value = settings.subfolder;
  $('saveAs').checked = !!settings.saveAs;
  $('minSizeKB').value = settings.minSizeKB;
  $('blocklist').value = (settings.blocklist || []).join('\n');
  $('theme').value = settings.theme;
  $('badgeStyle').value = settings.badgeStyle;
  applyTheme();
}

async function save() {
  settings = {
    defaultFormat: $('defaultFormat').value,
    subfolder: $('subfolder').value.trim(),
    saveAs: $('saveAs').checked,
    minSizeKB: Math.max(0, Number($('minSizeKB').value) || 0),
    blocklist: $('blocklist').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    theme: $('theme').value,
    badgeStyle: $('badgeStyle').value,
  };
  await chrome.storage.local.set({ settings });
  applyTheme();
  $('status').textContent = 'Saved';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status').textContent = ''; }, 1500);
}

chrome.storage.local.get('settings').then((r) => {
  settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  fill();
  for (const id of ['defaultFormat', 'saveAs', 'theme', 'badgeStyle']) $(id).addEventListener('change', save);
  for (const id of ['subfolder', 'minSizeKB', 'blocklist']) $(id).addEventListener('change', save);
});
