// @ts-nocheck
/* Achievement Manager 1.14.0. Adds a button next to "View My Achievements" that opens a Steam-styled window for unlocking and locking achievements. */
import { definePlugin, Field } from 'millennium';

const React = (window as any).SP_REACT;
const API = (window as any).MILLENNIUM_API;

/* Reads Steam's per-game stats schema (appcache/stats/UserGameStatsSchema_<appid>.bin), a binary KeyValues file.
 * The backend sends it as a hex string; this turns it into achievement definitions (API name, title, description,
 * icons, hidden flag). Pure functions: no Steam or DOM access. */

const KV_NONE = 0, KV_STRING = 1, KV_INT32 = 2, KV_FLOAT32 = 3, KV_PTR = 4, KV_WSTRING = 5,
  KV_COLOR = 6, KV_UINT64 = 7, KV_END = 8, KV_INT64 = 10, KV_END_ALT = 11;

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* → [{ name, type, value, children }] — the top level is a list, like the file itself.
 * A damaged or unfamiliar file does not throw: parsing stops where it cannot go on and what was read so far is
 * returned, with `.broken = true` on the list — a half-read schema still names most achievements. */
function parseBinaryKV(bytes) {
  let pos = 0;
  let broken = false;
  const utf8 = new TextDecoder('utf-8');
  const u16 = new TextDecoder('utf-16le');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const cstring = () => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    if (pos >= bytes.length) broken = true;     // no terminator: the file ends mid-string
    const text = utf8.decode(bytes.subarray(start, pos));
    pos++;                                       // the terminator
    return text;
  };
  const wstring = () => {
    const start = pos;
    while (pos + 1 < bytes.length && !(bytes[pos] === 0 && bytes[pos + 1] === 0)) pos += 2;
    if (pos + 1 >= bytes.length) broken = true;
    const text = u16.decode(bytes.subarray(start, pos));
    pos += 2;
    return text;
  };
  const room = n => { if (pos + n > bytes.length) { broken = true; return false; } return true; };

  const readList = depth => {
    const list = [];
    let closed = false;
    if (depth > 32) { broken = true; return list; }
    while (pos < bytes.length && !broken) {
      const type = bytes[pos++];
      if (type === KV_END || type === KV_END_ALT) { closed = true; break; }
      const name = cstring();
      let value = null, children = null;
      switch (type) {
        case KV_NONE: children = readList(depth + 1); break;
        case KV_STRING: value = cstring(); break;
        case KV_WSTRING: value = wstring(); break;
        case KV_INT32: case KV_PTR: case KV_COLOR:
          if (!room(4)) break;
          value = view.getInt32(pos, true); pos += 4; break;
        case KV_FLOAT32:
          if (!room(4)) break;
          value = view.getFloat32(pos, true); pos += 4; break;
        case KV_UINT64:
          if (!room(8)) break;
          value = view.getBigUint64(pos, true).toString(); pos += 8; break;
        case KV_INT64:
          if (!room(8)) break;
          value = view.getBigInt64(pos, true).toString(); pos += 8; break;
        default: broken = true;                  // a type this reader does not know
      }
      if (broken && type !== KV_NONE) break;     // a half-read value is dropped; a half-read subtree is kept
      list.push({ name, type, value, children });
    }
    if (!closed && depth > 0) broken = true;     // the file ended inside a block
    return list;
  };
  const roots = readList(0);
  roots.broken = broken;
  return roots;
}

const lower = s => String(s == null ? '' : s).toLowerCase();
const childOf = (node, name) => (node && node.children ? node.children.find(c => lower(c.name) === lower(name)) || null : null);
const textOf = (node, fallback) => (node && node.value != null ? String(node.value) : fallback);
const intOf = (node, fallback) => {
  if (!node || node.value == null) return fallback;
  const n = parseInt(node.value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const numOf = (node, fallback) => {
  if (!node || node.value == null) return fallback;
  const n = Number(node.value);
  return Number.isFinite(n) ? n : fallback;
};
const boolOf = node => {
  if (!node || node.value == null) return false;
  const v = lower(node.value);
  return v === '1' || v === 'true';
};

/* A display name is either a plain string or a table of languages. */
function localized(node, languages, fallback) {
  if (!node) return fallback;
  if (!node.children) return textOf(node, fallback);
  for (const lang of languages) {
    const hit = childOf(node, lang);
    if (hit && hit.value != null && String(hit.value) !== '') return String(hit.value);
  }
  const any = node.children.find(c => c.value != null && String(c.value) !== '' && lower(c.name) !== 'token');
  return any ? String(any.value) : fallback;
}

/* Steam names its languages, the client may report locale codes; best effort. */
const LOCALE_TO_STEAM = {
  en: 'english', de: 'german', fr: 'french', it: 'italian', ko: 'koreana', es: 'spanish', 'es-419': 'latam',
  'zh-cn': 'schinese', 'zh-hans': 'schinese', 'zh-tw': 'tchinese', 'zh-hant': 'tchinese', ru: 'russian', th: 'thai',
  ja: 'japanese', pt: 'portuguese', 'pt-br': 'brazilian', pl: 'polish', da: 'danish', nl: 'dutch', fi: 'finnish',
  no: 'norwegian', nb: 'norwegian', sv: 'swedish', hu: 'hungarian', cs: 'czech', ro: 'romanian', tr: 'turkish',
  bg: 'bulgarian', el: 'greek', uk: 'ukrainian', vi: 'vietnamese', ar: 'arabic', id: 'indonesian',
};
function steamLanguage(raw) {
  const key = lower(raw).replace(/_/g, '-');
  if (!key) return 'english';
  if (LOCALE_TO_STEAM[key]) return LOCALE_TO_STEAM[key];
  if (LOCALE_TO_STEAM[key.split('-')[0]]) return LOCALE_TO_STEAM[key.split('-')[0]];
  return key;              // already one of Steam's own names ("english", "schinese", ...)
}

/* → { api_name: { name, title, description, icon, iconGray, hidden } } */
function extractAchievements(roots, appId, language) {
  const languages = [steamLanguage(language), 'english'];
  const app = roots.find(n => n.name === String(appId)) || roots[0];
  const stats = childOf(app, 'stats');
  const out = {};
  if (!stats || !stats.children) return out;
  for (const stat of stats.children) {
    // Normally type_int 4 (achievements) or 5 (groups). Some schemas only carry a text `type` such as
    // "ACHIEVEMENTS", so that is accepted too — and anything holding a `bits` list of named entries is read.
    const typeNode = childOf(stat, 'type_int') || childOf(stat, 'type');
    const type = intOf(typeNode, 0);
    const typeText = lower(typeNode && typeNode.value);
    const looksLikeAchievements = type === 4 || type === 5 || /^(group)?achievements?$/.test(typeText) ||
      (stat.children || []).some(c => lower(c.name) === 'bits');
    if (!looksLikeAchievements) continue;
    for (const bits of (stat.children || []).filter(c => lower(c.name) === 'bits')) {
      for (const bit of bits.children || []) {
        const id = textOf(childOf(bit, 'name'), '');
        if (!id) continue;
        const display = childOf(bit, 'display');
        out[id] = {
          name: id,
          title: localized(childOf(display, 'name'), languages, id),
          description: localized(childOf(display, 'desc'), languages, ''),
          icon: textOf(childOf(display, 'icon'), ''),
          iconGray: textOf(childOf(display, 'icon_gray'), ''),
          hidden: boolOf(childOf(display, 'hidden')),
          permission: intOf(childOf(bit, 'permission'), 0),
          bit: bit.name,
        };
      }
    }
  }
  return out;
}

/* icons in the schema are bare file names (often without an extension) */
// Where Steam keeps achievement icons. Steam moved its community images to shared.<cdn>.steamstatic.com/community_assets/...
// (its store page serves a game's community image from there), and images uploaded for newer games may exist only at the
// new place, so the new hosts come first and the old cdn.* ones follow.
const ICON_BASES = [
  id => `https://shared.cloudflare.steamstatic.com/community_assets/images/apps/${id}/`,
  id => `https://shared.akamai.steamstatic.com/community_assets/images/apps/${id}/`,
  id => `https://shared.fastly.steamstatic.com/community_assets/images/apps/${id}/`,
  id => `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${id}/`,
  id => `https://cdn.steamstatic.com/steamcommunity/public/images/apps/${id}/`,
  id => `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${id}/`,
];
let preferredIconBase = '';   // the first base that loaded an image; later icons try it first

// The addresses to try for one achievement's icon, best first. `names` are the schema's icon values (the one to show first,
// then the other state's). A value may or may not carry an extension; a .jpg is tried as .png as well.
function iconCandidates(appId, names) {
  const out = [];
  const add = url => { if (url && out.indexOf(url) < 0) out.push(url); };
  const bases = ICON_BASES.map(make => make(appId));
  if (preferredIconBase) { const i = bases.indexOf(preferredIconBase); if (i > 0) { bases.splice(i, 1); bases.unshift(preferredIconBase); } }
  const list = (names || []).filter(Boolean);
  list.forEach((raw, position) => {
    if (/^https?:/i.test(raw)) { add(raw); return; }
    const hasExt = /\.[a-z0-9]{2,4}$/i.test(raw);
    const file = hasExt ? raw : raw + '.jpg';
    const swapped = file.replace(/\.[a-z0-9]{2,4}$/i, m => (m.toLowerCase() === '.jpg' ? '.png' : '.jpg'));
    bases.forEach(base => add(base + file));                                   // the icon as the schema names it, on every host
    if (position === 0) bases.slice(0, 3).forEach(base => add(base + swapped)); // the other extension, on the first hosts only
  });
  return out;
}

// An achievement's icon. When an address fails it tries the next one; when all fail it shows a plain tile instead of the
// browser's broken-image symbol.
function AchievementIcon({ appId, names, dim }) {
  const key = String(appId) + '|' + (names || []).join('|');
  const candidates = React.useMemo(() => iconCandidates(appId, names), [key]);
  const [tried, setTried] = React.useState({ key, index: 0 });
  const index = tried.key === key ? tried.index : 0;
  if (index >= candidates.length) return h('div', { className: 'amw-rowicon amw-rowicon-none', 'aria-hidden': 'true' });
  const url = candidates[index];
  return h('img', {
    className: 'amw-rowicon', src: url, alt: '', style: { opacity: dim ? 0.55 : 1 },
    onLoad: () => { preferredIconBase = url.slice(0, url.lastIndexOf('/') + 1); },
    onError: () => setTried({ key, index: index + 1 }),
  });
}

/* The button and the window.
 *
 * The button is a copy of Steam's "View My Achievements" button, so it keeps the theme's look, placed beside it. A
 * MutationObserver puts it back whenever Steam redraws the page. The window is built from the same parts as Steam's game
 * Properties window (navigation column, content column, dialog buttons), so themes style it like that window. */

const TITLE = 'Achievement Manager';
const h = React.createElement;

/* The "not allowed" symbol (a circle with a slash) shown next to protected achievements. Drawn in the text colour. */
function ProtectedIcon() {
  return h('svg', { className: 'amw-protecticon', width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 2.6 }),
    h('line', { x1: 5.8, y1: 5.8, x2: 18.2, y2: 18.2, stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }));
}

/* A number box with minus and plus buttons. It is built from plain elements with our own class names, on purpose: Steam's
 * TextField is restyled by themes (some put a search icon in every text field, some shrink it), which breaks a number box.
 * The colours come from the text colour (currentColor), so any theme, light or dark, gets a matching border. */
function Stepper({ def, text, current, known, bad, onChange }) {
  const disabled = def.locked || !known;
  const typed = String(text).trim();
  const parsed = Number(typed);
  const value = typed !== '' && Number.isFinite(parsed) ? parsed : (known ? current : 0);
  const range = def.min != null && def.max != null ? def.max - def.min : Infinity;
  const step = def.kind === 'i' ? 1 : (range <= 10 ? 0.1 : 1);
  let lo = def.min != null ? def.min : null;
  if (def.increment && known) lo = lo == null ? current : Math.max(lo, current);
  const hi = def.max != null ? def.max : null;
  const move = dir => {
    let n = value + dir * step;
    if (def.kind !== 'i') n = Math.round(n * 1e6) / 1e6;
    if (lo != null && n < lo) n = lo;
    if (hi != null && n > hi) n = hi;
    onChange(String(n));
  };
  return h('div', { className: 'amw-spin' + (disabled ? ' amw-spin-off' : '') + (bad ? ' amw-spin-bad' : '') },
    h('input', {
      className: 'amw-spinfield', type: 'text', inputMode: def.kind === 'i' ? 'numeric' : 'decimal', spellCheck: false,
      value: text, disabled,
      onChange: e => onChange(e.target.value),
      onKeyDown: e => {
        if (e.key === 'ArrowUp') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(-1); }
      },
    }),
    h('button', { type: 'button', className: 'amw-step', 'aria-label': 'Decrease', disabled: disabled || (lo != null && value <= lo), onClick: () => move(-1) }, '\u2212'),
    h('button', { type: 'button', className: 'amw-step', 'aria-label': 'Increase', disabled: disabled || (hi != null && value >= hi), onClick: () => move(1) }, '+'));
}

/* Stats: the numeric counters a game keeps (kills, distance, ...), defined in the same schema file as the achievements.
 * → [{ id, title, kind: 'i' | 'f' | 'a', min, max, increment, locked, reason }]; 'a' is an average-rate stat, which is
 * shown but never written. A stat is locked when the schema protects it (permission bit 2), when only the game's server may
 * set it, or when it is an average rate. */
function extractStats(roots, appId, language) {
  const languages = [steamLanguage(language), 'english'];
  const app = roots.find(n => n.name === String(appId)) || roots[0];
  const stats = childOf(app, 'stats');
  const out = [];
  if (!stats || !stats.children) return out;
  for (const stat of stats.children) {
    const typeNode = childOf(stat, 'type_int') || childOf(stat, 'type');
    const type = intOf(typeNode, 0);
    const typeText = lower(typeNode && typeNode.value);
    const kind = (type === 1 || /^int(eger)?$/.test(typeText)) ? 'i'
      : (type === 2 || typeText === 'float') ? 'f'
      : (type === 3 || /^avg|^average/.test(typeText)) ? 'a' : '';
    if (!kind) continue;
    const id = textOf(childOf(stat, 'name'), '');
    if (!id) continue;
    const display = childOf(stat, 'display');
    const protectedStat = (intOf(childOf(stat, 'permission'), 0) & 2) !== 0;
    const serverOnly = boolOf(childOf(stat, 'bSetByTrustedGS'));
    out.push({
      id, kind,
      title: localized(childOf(display, 'name'), languages, id),
      min: numOf(childOf(stat, 'min'), null),
      max: numOf(childOf(stat, 'max'), null),
      increment: boolOf(childOf(stat, 'incrementonly')),
      locked: protectedStat || serverOnly || kind === 'a',
      reason: kind === 'a' ? 'Average-rate stats can\'t be edited' : protectedStat ? 'Protected by the game' : serverOnly ? 'Only the game\'s server can change this' : '',
    });
  }
  return out;
}

/* Is the text typed for a stat acceptable? → { ok, value } or { ok: false, why } */
function checkStat(def, text, current) {
  const raw = String(text).trim();
  if (raw === '') return { ok: false, why: 'Enter a number' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, why: 'That is not a number' };
  if (def.kind === 'i') {
    if (!Number.isInteger(n)) return { ok: false, why: 'Whole numbers only' };
    if (Math.abs(n) > 2147483647) return { ok: false, why: 'That number is too large' };
  }
  if (def.min != null && n < def.min) return { ok: false, why: 'At least ' + def.min };
  if (def.max != null && n > def.max) return { ok: false, why: 'At most ' + def.max };
  if (def.increment && current != null && n < current) return { ok: false, why: 'This stat can only go up from ' + current };
  return { ok: true, value: n };
}

const FILTERS = [['All', 'All achievements'], ['Unlocked', 'Unlocked'], ['Locked', 'Locked'], ['Changed', 'Changed']];
const SORTS = ['Steam order', 'Name', 'Unlocked first', 'Locked first', 'Recently unlocked'];
const PAGE = 150;

/* ═════════════ backend calls ═════════════ */


async function callBackend(method, payload) {
  // the compiler turns literal `backend.<name>(...)` calls into calls to the Lua functions, so each is written out
  const arg = JSON.stringify(payload);
  let raw;
  if (method === 'am_apply') raw = await backend.am_apply(arg);
  else if (method === 'am_stats') raw = await backend.am_stats(arg);
  else if (method === 'am_stats_apply') raw = await backend.am_stats_apply(arg);
  else raw = await backend.am_status(arg);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (e) { return { ok: false, error: 'bad_response' }; }
}

const ERRORS = {
  steam_not_running: 'Steam did not answer. Make sure the Steam client is running and signed in.',
  steam_user_not_logged_in: 'No Steam account is signed in.',
  steam_game_refused: 'Steam is signed in, but would not open this game for your account. The account most likely does not own this game.',
  game_stats_not_owned_or_unavailable: 'Steam has no stats for this game on your account. It may not be owned, or it has no achievements.',
  request_current_stats_failed: 'Steam refused the stats request for this game.',
  steam_client_dll_not_found: 'Could not find the Steam client files.',
  csc_not_found: 'The .NET Framework 4 compiler (csc.exe) was not found; the helper could not be built.',
  compilation_failed: 'The helper program could not be built.',
  helper_source_missing: 'The plugin is missing its helper file in resources/ (steam_achievement_helper.cs on Windows, steam_achievement_helper.py on Linux).',
  python_not_found: 'Python 3 was not found. On Linux the helper needs python3 (3.6 or newer); install it with your distribution\'s package manager.',
  python_too_old: 'The installed Python is too old; the helper needs Python 3.6 or newer.',
  helper_failed: 'The helper stopped without giving an answer.',
  helper_write_failed: 'The helper could not be written to disk.',
  unsupported_platform: 'This operating system is not supported; the plugin works on Windows and Linux.',
  empty_output: 'The helper gave no answer (it may have timed out).',
  busy: 'Another request is still running. Try again in a moment.',
  store_stats_not_confirmed: 'Steam did not confirm that the changes were saved.',
  invalid_appid: 'This game has no usable app ID.',
  nothing_to_apply: 'There was nothing to write.',
  stats_unavailable: 'Stats can only be edited on Windows and Linux.',
  stats_compilation_failed: 'The stats helper program could not be built.',
  stats_failed: 'The stats helper could not run.',
};
const explain = res => {
  const code = res && res.error;
  const detail = res && res.detail ? String(res.detail) : '';
  if (ERRORS[code]) return detail ? `${ERRORS[code]} (${detail})` : ERRORS[code];
  return `Something went wrong (${code || 'unknown'}${detail ? ': ' + detail : ''}).`;
};


// Steam's logo, as a 24x24 SVG path (drawn in the loading screen)
const PLUGIN_VERSION = '1.14.0';   // keep in step with millennium.toml; shown in diagnose() reports

const STEAM_LOGO = 'M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z';

function steamLanguageNow() {
  try { return window.LocalizationManager.m_rgLocalesToUse[0]; } catch (e) { /* not exposed */ }
  return (navigator && navigator.language) || 'english';
}

// how many players have each achievement (Steam's public numbers): the backend hands over the Web API's answer as text
function sharesFrom(res) {
  const out = {};
  try {
    if (typeof res.percent_raw !== 'string') return out;
    const list = JSON.parse(res.percent_raw).achievementpercentages.achievements;
    (Array.isArray(list) ? list : []).forEach(a => { const p = a ? Number(a.percent) : NaN; if (a && a.name && isFinite(p)) out[a.name] = p; });
  } catch (e) { console.warn('[Achievement Manager] global percentages unreadable', e); }
  return out;
}

function rowsFrom(res, appId) {
  let defs = {};
  let statDefs = [];
  let broken = false;
  if (res.schema_found && res.schema_hex) {
    try {
      const tree = parseBinaryKV(hexToBytes(res.schema_hex));
      broken = !!tree.broken;
      defs = extractAchievements(tree, appId, steamLanguageNow());
      statDefs = extractStats(tree, appId, steamLanguageNow());
    } catch (e) { console.warn('[Achievement Manager] schema unreadable', e); }
  }
  const shares = sharesFrom(res);
  const rows = Object.keys(res.achievements || {}).map((name, order) => {
    const meta = defs[name];
    const state = res.achievements[name];
    const info = meta || {};
    return {
      name, order,
      known: !!meta,
      title: info.title || name,
      description: info.description || '',
      iconNames: state.achieved ? [info.icon, info.iconGray] : [info.iconGray || info.icon, info.icon],
      hidden: !!info.hidden,
      isProtected: (info.permission || 0) !== 0,   // the game sets this achievement itself; the schema says so with a non-zero permission
      achieved: !!state.achieved,
      unlockTime: state.unlock_time || 0,
      percent: Object.prototype.hasOwnProperty.call(shares, name) ? shares[name] : null,
    };
  });
  const missing = rows.filter(r => !r.known).length;
  console.log(`[Achievement Manager] app ${appId}: schema ${res.schema_found ? (res.schema_bytes || '?') + ' bytes' + (broken ? ' (partly unreadable)' : '') : 'not found'}, ` +
    `${rows.length - missing} of ${rows.length} achievements described`);
  return { rows, missing, schemaFound: !!res.schema_found, broken, statDefs, platform: res.platform || '' };
}

// Steam writes the schema file a moment after it answers; for a game opened for the first time, ask once more
const SCHEMA_RETRY_MS = 2500;


/* ═════════════ the window ═════════════ */

const CSS = `
@keyframes amw-ring{to{transform:rotate(360deg)}}

/* the modal Steam wraps around us: no padding, no colour of its own */
.amw-outer,.amw-modal{padding:0 !important;margin:0 !important;max-width:none !important;width:100% !important;height:100% !important}

/* The window is built from the same parts as Steam's game Properties window (the classes below are Steam's own), so the
   user's theme styles it the way it styles that window. Only the layout is ours. It fills the whole popup. */
.amw-root{position:fixed;inset:0;display:flex;flex-direction:row;box-sizing:border-box;height:auto;min-height:0;overflow:visible;font-family:"Motiva Sans",Arial,Helvetica,sans-serif}
.amw-root .amw-side{flex:0 0 220px;max-width:220px;min-width:0;min-height:0;box-sizing:border-box;overflow:visible}
.amw-root .amw-nav{flex:0 1 auto;min-height:0}
.amw-root .amw-nav-item{cursor:pointer;user-select:none}
.amw-root .amw-nav-item .amw-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.amw-root .amw-count{flex:none;margin-inline-start:8px;font-size:12px;opacity:.6}
.amw-root .amw-side-note{margin-top:auto;padding:12px 24px 16px;font-size:12px;line-height:1.4;opacity:.6;white-space:normal}
.amw-root .amw-main{flex:1 1 0;min-width:0;min-height:0;max-width:none;height:auto;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden}
.amw-root .amw-head{flex:none;padding:22px 72px 8px 24px}
.amw-root .amw-title{font-size:22px;font-weight:700;line-height:30px;color:var(--amw-title,#fff)}
.amw-root .amw-sub{margin-top:2px;font-size:13px;opacity:.65}
.amw-root .amw-bar{flex:none;padding:0 24px 12px}
.amw-root .amw-tools{flex:none;display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:10px;align-items:center;padding:0 24px 12px}
.amw-root .amw-list{flex:1 1 0;min-height:0;margin:0 !important;padding:6px 24px 22px !important;overflow-x:hidden;overflow-y:auto;gap:0;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent)}
.amw-root .amw-row{display:flex;align-items:center;gap:14px;box-sizing:border-box;margin:0 0 6px;padding:10px 16px 10px 12px;border-radius:var(--amw-rowr,4px);background:color-mix(in srgb, #fff 5%, transparent);border:1px solid color-mix(in srgb, #fff 8%, transparent)}
.amw-root .amw-rowicon{flex:none;display:block;width:40px;height:40px;border-radius:2px}
.amw-root .amw-rowicon-none{box-sizing:border-box;border:1px solid color-mix(in srgb, currentColor 18%, transparent);background:color-mix(in srgb, currentColor 6%, transparent)}
.amw-root .amw-rowtext{flex:1 1 auto;min-width:0}
.amw-root .amw-rowtitle{font-size:14px;line-height:19px;font-weight:600;color:#fff;overflow-wrap:anywhere}
.amw-root .amw-rowdesc{margin-top:2px;font-size:12px;line-height:16px;font-weight:400;color:rgba(255,255,255,.62);white-space:normal;overflow-wrap:anywhere}
.amw-root .amw-rowpct{margin-top:1px;font-size:12px;line-height:16px;font-weight:400;color:rgba(255,255,255,.45);white-space:normal;overflow-wrap:anywhere}
.amw-root .amw-statinput{flex:none;width:176px}
.amw-root .amw-spin{display:flex;align-items:stretch;box-sizing:border-box;height:34px;overflow:hidden;border:1px solid color-mix(in srgb, currentColor 24%, transparent);border-radius:var(--amw-rowr,4px);background:color-mix(in srgb, currentColor 5%, transparent)}
.amw-root .amw-spin:focus-within{border-color:color-mix(in srgb, currentColor 55%, transparent)}
.amw-root .amw-spin-off{opacity:.5}
.amw-root .amw-spin-bad{border-color:color-mix(in srgb, #e0605a 75%, transparent)}
.amw-root .amw-spinfield{flex:1 1 auto;min-width:0;width:auto !important;height:auto !important;box-sizing:border-box;margin:0 !important;padding:0 10px !important;border:0 !important;border-radius:0 !important;outline:0 !important;box-shadow:none !important;transform:none !important;background:transparent !important;background-image:none !important;color:inherit !important;font:inherit;font-size:14px;text-align:left}
.amw-root .amw-step{flex:none;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:34px;margin:0 !important;padding:0 !important;border:0 !important;border-left:1px solid color-mix(in srgb, currentColor 24%, transparent) !important;border-radius:0 !important;box-shadow:none !important;transform:none !important;background:transparent !important;color:inherit !important;font-size:18px;line-height:1;font-weight:400;cursor:pointer}
.amw-root .amw-step:hover:not(:disabled){background:color-mix(in srgb, currentColor 12%, transparent) !important}
.amw-root .amw-step:disabled{opacity:.35;cursor:default}
.amw-root .amw-statwhy{margin-top:2px;font-size:12px;line-height:16px}
.amw-root .amw-navsep{height:1px;margin:6px 12px;background:rgba(255,255,255,.12)}
.amw-root .amw-protecticon{flex:none;margin-right:10px;opacity:.75}
.amw-root .amw-protected .amw-protecticon{cursor:help}
.amw-root .amw-rowtoggle{flex:none;display:flex;align-items:center;justify-content:flex-end;min-width:48px}
.amw-root .amw-empty{padding:56px 0;text-align:center;opacity:.6}
.amw-root .amw-more{display:flex;justify-content:center;padding:14px 0 6px}
.amw-root .amw-more button{box-sizing:border-box;width:auto;min-width:160px;padding:0 18px}
.amw-root .amw-foot{flex:none;display:flex;flex-direction:column;gap:10px;padding:12px 24px 16px;box-sizing:border-box;border-top:1px solid color-mix(in srgb, currentColor 16%, transparent)}
.amw-root .amw-status{min-height:18px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;opacity:.75}
.amw-root .amw-status.amw-ok{color:#8fcf5a;opacity:1}
.amw-root .amw-status.amw-bad{color:#ee7a70;opacity:1}
.amw-root .amw-status.amw-warn{color:#ffc82c;opacity:1}
.amw-root .amw-actions{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}
.amw-root .amw-actions button{box-sizing:border-box;width:100% !important;min-width:0;margin:0;padding:0 8px}
.amw-root .amw-center{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:24px}
.amw-root .amw-center .amw-msg{max-width:520px;text-align:center;line-height:1.4;opacity:.75}

/* only when Steam's own styling of those classes is not there (a Steam update renamed them): a plain look of our own */
.amw-backdrop{position:fixed;inset:0;pointer-events:none}
.amw-fallback{background:#1a1f27;color:#dcdedf}
.amw-fallback .amw-side{background:#161b22;padding:36px 0 16px;display:flex;flex-direction:column}
.amw-fallback .amw-game{padding:0 24px 20px;color:#1a9fff;font-size:17px;font-weight:700;text-transform:uppercase}
.amw-fallback .amw-nav{display:flex;flex-direction:column}
.amw-fallback .amw-nav-item{display:flex;align-items:center;padding:10px 8px 10px 24px;font-size:14px;color:#b8bcbf}
.amw-fallback .amw-nav-item:hover{background:rgba(255,255,255,.07)}
.amw-fallback .amw-nav-item.amw-on{background:#3d4450;color:#fff}
.amw-fallback .amw-main{background:#1c222b}
`;

/* ═════════════ window designs ═════════════ */

// Which layout the window uses; chosen in the plugin's settings and read each time the window opens.
const DESIGNS = [
  ['classic', 'Classic', 'A navigation column on the left and one card per achievement, like Steam\'s game Properties window.'],
  ['showcase', 'Showcase', 'A grid of achievement tiles with a rarity bar. Click a tile to unlock or lock it.'],
  ['table', 'Table', 'A compact table with tick boxes, so many achievements can be unlocked or locked together.'],
  ['split', 'Split', 'A list on the left and a large detail pane on the right, with a rarity tier and one Unlock or Lock button.'],
];
const DESIGN_KEY = 'achievement-manager.design';
function readDesign() {
  try { const v = window.localStorage.getItem(DESIGN_KEY); if (DESIGNS.some(d => d[0] === v)) return v; } catch (e) { /* storage unavailable */ }
  return 'classic';
}
function writeDesign(id) {
  try { window.localStorage.setItem(DESIGN_KEY, id); } catch (e) { /* storage unavailable */ }
}

// extra rules for the three new designs; they sit on top of the shared CSS above and use only text-colour mixes
const ALT_CSS = `
.amw-root.amw-alt .amw-main{padding:0}
.amx-wrap{flex:1 1 0;min-height:0;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding:18px 22px 16px;font-size:14px}
.amx-wrap *{box-sizing:border-box}
.amx-head{flex:none;display:flex;align-items:center;gap:12px;min-height:32px;padding-right:48px}
.amx-titles{margin-right:auto;min-width:0}
.amx-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:20px;line-height:26px;font-weight:700}
.amx-subtitle{font-size:13px;line-height:18px;opacity:.65}
.amx-pill{flex:none;padding:3px 11px;border-radius:999px;font-size:12px;background:color-mix(in srgb,currentColor 12%,transparent)}
.amx-row{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.amx-grow{flex:1 1 auto}
.amx-seg{flex:none;display:inline-flex;gap:6px}
.amx-btn{box-sizing:border-box;width:auto;min-width:0;margin:0;padding:0 16px;white-space:nowrap}
.amx-btn.amx-on{background:color-mix(in srgb,currentColor 22%,transparent) !important;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 45%,transparent) !important}
.amx-search{flex:none;min-width:0}
.amx-row > .amx-search{flex:1 1 160px}
.amx-filter{flex:none;width:170px}
.amx-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
.amx-pair .amx-sort,.amx-pair .amx-filter{width:auto}
.amx-sort{flex:none;width:190px}
.amx-ok{color:#8fcf5a}.amx-bad{color:#ee7a70}.amx-warn{color:#ffc82c}
.amx-list{flex:1 1 0;min-height:0;margin:0 !important;padding:0 4px 0 0 !important;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.amx-grid > .amx-more{grid-column:1 / -1}
.amx-more{flex:none;display:flex;justify-content:center;padding:6px 0}
.amx-foot{flex:none;display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.amx-status{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:18px}
.amx-status .amx-ok{color:#8fcf5a}.amx-status .amx-bad{color:#ee7a70}.amx-status .amx-warn{color:#ffc82c}
.amx-statusnote{opacity:.6}
.amx-statusnote.amx-after{margin-left:10px}
.amx-bar{display:flex;align-items:center;gap:8px}
.amx-bar .amx-btn,.amx-bulk .amx-btn{flex:0 0 auto;width:auto !important;min-width:120px}
.amx-spacer{flex:1 1 0}
.amx-ctitle{font-weight:600;line-height:19px;overflow-wrap:anywhere}
.amx-sub{font-size:12px;line-height:16px;opacity:.65;overflow-wrap:anywhere}
.amx-text{flex:1 1 auto;min-width:0}
.amx-check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1.5px solid color-mix(in srgb,currentColor 45%,transparent);cursor:pointer}
.amx-check.amx-checked{background:color-mix(in srgb,currentColor 24%,transparent);border-color:currentColor}

/* showcase */
.amx-grid{flex:1 1 0;min-height:0;margin:0 !important;padding:2px 4px 8px 2px !important;overflow-x:hidden;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;align-content:start}
.amx-tile{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:6px;cursor:pointer;user-select:none;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);transition:background .12s ease,border-color .12s ease}
.amx-tile:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.amx-tile:focus-visible{outline:2px solid color-mix(in srgb,currentColor 60%,transparent);outline-offset:1px}
.amx-tile.amx-changed{border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,currentColor 11%,transparent)}
.amx-tile.amx-protected{cursor:not-allowed}
.amx-tile.amx-stat{cursor:default}
.amx-tile.amx-off .amw-rowicon{filter:grayscale(1)}
.amx-tilehead{display:flex;align-items:center;gap:12px;padding-right:26px}
.amw-root .amx-tile .amw-rowicon{width:52px;height:52px;border-radius:3px}
.amx-tile > .amx-check,.amx-tile > .amw-protecticon{position:absolute;top:10px;right:10px;margin:0}
.amx-tdesc{min-height:48px;font-size:12px;line-height:16px;opacity:.72;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.amx-rarity{display:flex;align-items:center;gap:8px;min-height:12px;font-size:11px;opacity:.85}
.amx-rbar{flex:1 1 auto;height:4px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,currentColor 14%,transparent)}
.amx-rfill{height:100%;background:currentColor;opacity:.7}
.amx-tile .amw-statinput{width:100%}

/* table */
.amx-trow{flex:none;display:grid;grid-template-columns:24px 30px minmax(0,1fr) 130px 120px 56px;align-items:center;gap:10px;padding:5px 10px;border-radius:3px}
.amx-trow.amx-statrow{grid-template-columns:minmax(0,1fr) 190px}
.amx-trow.amx-hd{padding-top:2px;padding-bottom:6px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:0;font-size:12px;font-weight:600;opacity:.75;user-select:none}
.amx-trow.amx-hd .amx-sortable{cursor:pointer}
.amx-trow.amx-hd .amx-sortable:hover{opacity:1}
.amx-body{flex:1 1 0;min-height:0;margin:0 !important;padding:0 4px 0 0 !important;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:0}
.amx-body > .amx-trow:nth-child(even){background:color-mix(in srgb,currentColor 4%,transparent)}
.amx-trow.amx-changed{box-shadow:inset 3px 0 0 color-mix(in srgb,currentColor 60%,transparent)}
.amx-trow.amx-sel{background:color-mix(in srgb,currentColor 10%,transparent) !important}
.amw-root .amx-trow .amw-rowicon{width:28px;height:28px;border-radius:2px}
.amx-trow .amx-ctitle,.amx-trow .amx-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.amx-trow .amx-ctitle{font-size:13px;line-height:17px}
.amx-cell{min-width:0;font-size:12px}
.amx-trow .amw-rowtoggle{min-width:0}
.amx-bulk{flex:none;display:flex;align-items:center;gap:8px;min-height:32px}
.amx-bulk .amx-sub{flex:1 1 auto;min-width:0;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* split */
.amx-split{flex:1 1 0;min-height:0;display:flex;gap:16px}
.amx-splitlist{flex:none;width:350px;display:flex;flex-direction:column;gap:10px;min-height:0}
.amx-srow{flex:none;display:flex;align-items:center;gap:10px;padding:6px 10px 6px 6px;border-radius:4px;cursor:pointer;border:1px solid transparent}
.amx-srow:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.amx-srow.amx-picked{background:color-mix(in srgb,currentColor 14%,transparent);border-color:color-mix(in srgb,currentColor 30%,transparent)}
.amx-srow.amx-changed{box-shadow:inset 3px 0 0 color-mix(in srgb,currentColor 60%,transparent)}
.amx-srow:focus-visible{outline:2px solid color-mix(in srgb,currentColor 60%,transparent);outline-offset:1px}
.amw-root .amx-srow .amw-rowicon{width:36px;height:36px;border-radius:3px}
.amx-srow .amx-ctitle{font-size:13px;line-height:17px}
.amx-srow .amx-ctitle,.amx-srow .amx-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.amx-srow .amw-rowtoggle{flex:none;min-width:0}
.amx-pane{flex:1 1 0;min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:22px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 6%,transparent)}
.amx-panehead{display:flex;align-items:center;gap:18px}
.amw-root .amx-pane .amw-rowicon{width:96px;height:96px;border-radius:6px}
.amx-pane .amx-ctitle{font-size:20px;line-height:26px}
.amx-tier{display:inline-block;align-self:flex-start;margin-top:6px;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:600;background:color-mix(in srgb,currentColor 14%,transparent)}
.amx-panedesc{font-size:14px;line-height:20px;opacity:.88;overflow-wrap:anywhere}
.amx-pane .amx-rbar{height:8px;border-radius:4px}
.amx-pane .amx-rarity{font-size:12px;opacity:1}
.amx-facts{display:flex;flex-direction:column;gap:4px;font-size:13px;opacity:.75}

`;

const fmtWhen = t => (t ? new Date(t * 1000).toLocaleString() : '');

// what a layout needs to know about one achievement / one stat
function rowInfo(m, row) {
  const now = m.wanted(row);
  const edited = m.has(row.name);
  return {
    now, edited,
    desc: row.description || (row.hidden ? 'Hidden achievement' : ''),
    unlocked: row.achieved && row.unlockTime ? 'Unlocked ' + fmtWhen(row.unlockTime) : '',
    will: edited ? (now ? 'Will be unlocked' : 'Will be locked') : '',
    pct: row.percent != null ? row.percent : null,
  };
}
function statInfo(m, def) {
  const known = m.hasStat(def.id);
  const edited = Object.prototype.hasOwnProperty.call(m.statEdits, def.id);
  const text = edited ? m.statEdits[def.id] : (known ? String(m.statValues[def.id]) : '');
  const check = edited ? checkStat(def, text, known ? m.statValues[def.id] : null) : null;
  const meta = [def.kind === 'i' ? 'Whole number' : def.kind === 'f' ? 'Decimal number' : 'Average rate'];
  if (def.title !== def.id) meta.push(def.id);
  if (def.min != null && def.min > -1e9) meta.push('min ' + def.min);
  if (def.max != null && def.max < 1e9) meta.push('max ' + def.max);
  if (def.increment) meta.push('can only go up');
  if (def.locked) meta.push(def.reason);
  if (!known) meta.push('Steam does not report this stat');
  return { known, edited, text, check, meta: meta.join('  ·  ') };
}
const statStepper = (m, def, i) => h(Stepper, { def, text: i.text, current: i.known ? m.statValues[def.id] : null, known: i.known, bad: !!(i.check && !i.check.ok), onChange: t => m.setStatText(def, t) });

// Steam's own buttons, like the Classic design, so themes style them
const AltButton = API.DialogButton || API.Button;
const AltPrimary = API.DialogButtonPrimary || AltButton;
const altBtn = (label, onClick, o = {}) => h(o.primary ? AltPrimary : AltButton, {
  key: o.key, title: o.title, disabled: !!o.disabled, onClick, className: 'amx-btn' + (o.on ? ' amx-on' : ''),
}, label);

const checkMark = () => h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true' },
  h('path', { d: 'M3 8.5l3.2 3.2L13 5', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
const checkBox = (on, onClick, key) => h('span', {
  key, role: 'checkbox', 'aria-checked': on, className: 'amx-check' + (on ? ' amx-checked' : ''),
  onClick: e => { e.stopPropagation(); if (onClick) onClick(); },
}, on ? checkMark() : null);

const altStatusClass = st => (st.cls ? 'amx-' + st.cls.replace('amw-', '') : '');
function altInStats(m) { return m.view === 'stats' && m.statsAvailable; }

// stats that are still being read (or failed to read): shown instead of the list
function altWaiting(m) {
  if (!altInStats(m) || m.statsPhase === 'ready') return null;
  if (m.statsPhase === 'error') {
    return h('div', { className: 'amw-center' }, h('div', { className: 'amw-msg' }, m.statsProblem), h(m.DButton, { onClick: () => m.setStatsPhase('idle') }, 'Try again'));
  }
  return h('div', { className: 'amw-center' }, h('div', { className: 'amw-msg' }, 'Reading stats from Steam...'));
}

function altViewTabs(m, cls) {
  if (!m.statsAvailable) return null;
  return h('div', { className: cls },
    altBtn('Achievements', () => m.switchView('achievements'), { key: 'a', on: m.view === 'achievements' }),
    altBtn('Stats', () => m.switchView('stats'), { key: 's', on: m.view === 'stats' }));
}
function altFilter(m) {
  return h('div', { key: 'filter', className: 'amx-filter' },
    h(API.Dropdown, {
      rgOptions: FILTERS.map(([key, label]) => ({ label: (key === 'All' ? 'All' : label) + ' (' + m.counts[key] + ')', data: key })),
      selectedOption: m.filter, onChange: o => { m.setFilter(o.data); m.setLimit(PAGE); }, contextMenuPositionOptions: { bMatchWidth: false },
    }));
}
// Steam's TextField, as in the Classic design (themes give it the search icon)
function altSearch(m) {
  const stats = altInStats(m);
  return h('div', { key: 'search', className: 'amx-search' },
    h(API.TextField, {
      value: stats ? m.statSearch : m.search, placeholder: stats ? 'Search stats...' : 'Search achievements...',
      onChange: e => { if (stats) m.setStatSearch(e.target.value); else { m.setSearch(e.target.value); m.setLimit(PAGE); } },
    }));
}
function altSort(m) {
  return h('div', { key: 'sort', className: 'amx-sort' },
    h(API.Dropdown, { rgOptions: SORTS.map(s => ({ label: s, data: s })), selectedOption: m.sort, onChange: o => m.setSort(o.data), contextMenuPositionOptions: { bMatchWidth: false } }));
}
function altMore(m) {
  return m.visible.length > m.shown.length
    ? h('div', { key: 'more', className: 'amx-more' }, altBtn('Show ' + (m.visible.length - m.shown.length) + ' more', () => m.setLimit(l => l + PAGE)))
    : null;
}
const altEmpty = (m, stats) => h('div', { className: 'amw-empty' },
  stats ? 'No stat matches the search.' : (m.rows.length ? 'No achievement matches the search and filter.' : 'Steam reports no achievements for this game.'));

// bottom row: Revert and Apply (with the bulk buttons in the showcase and split designs)
function altFooter(m, opts) {
  const stats = altInStats(m);
  const st = stats ? m.statStatus : m.status;
  const confirming = stats ? m.statConfirming : m.confirming;
  const edits = stats ? Object.keys(m.statEdits).length : m.changed;
  const canApply = stats ? m.statWrites.length > 0 : m.changed > 0;
  const bulkAll = m.filter === 'All' && !m.search.trim();   // the list is every achievement, so the buttons can say "all"
  return h('div', { className: 'amx-foot' },
    // the status first (while there is one), then the note Classic shows in its side column
    h('div', { key: 'st', className: 'amx-status' },
      st.text ? h('span', { className: altStatusClass(st) }, st.text) : null,
      h('span', { className: 'amx-statusnote' + (st.text ? ' amx-after' : '') }, 'Changes are applied to your Steam account and can be reverted at any time.')),
    h('div', { key: 'bar', className: 'amx-bar' },
      !stats && opts.bulk ? [
        altBtn(bulkAll ? 'Unlock all' : `Unlock these (${m.visible.length})`, () => m.changeMany(m.visible, true), { key: 'u', title: 'Stage every achievement in the list for unlocking', disabled: m.working || m.visible.length === 0 }),
        altBtn(bulkAll ? 'Lock all' : `Lock these (${m.visible.length})`, () => m.changeMany(m.visible, false), { key: 'l', title: 'Stage every achievement in the list for locking', disabled: m.working || m.visible.length === 0 }),
      ] : null,
      h('div', { key: 'sp', className: 'amx-spacer' }),
      !stats && m.coverage.missing > 0 ? altBtn('Reload', m.reload, { key: 'r', disabled: m.working }) : null,
      altBtn('Discard', stats ? m.revertStats : m.revert, { key: 'v', title: 'Throw away the changes that are not applied yet', disabled: m.working || edits === 0 }),
      altBtn(confirming ? 'Confirm' : 'Apply', stats ? m.applyStats : m.apply, { key: 'a', primary: true, disabled: m.working || !canApply })));
}
// a stat as a tile (Showcase)
function statTileEl(m, def) {
  const i = statInfo(m, def);
  return h('div', { key: def.id, className: 'amx-tile amx-stat' + (i.edited ? ' amx-changed' : '') },
    h('div', { className: 'amx-ctitle' }, def.title),
    h('div', { className: 'amx-tdesc' }, i.meta),
    i.check && !i.check.ok ? h('div', { className: 'amx-sub amx-bad' }, i.check.why) : null,
    h('div', { className: 'amw-statinput' }, statStepper(m, def, i)));
}

/* ───── design: showcase (a grid of tiles) ───── */

function ShowcaseLayout({ m }) {
  const stats = altInStats(m);
  const waiting = altWaiting(m);
  const st = stats ? m.statStatus : m.status;
  const tile = row => {
    const i = rowInfo(m, row);
    const toggle = () => { if (!row.isProtected) m.setWanted(row, !i.now); };
    return h('div', {
      key: row.name, role: 'button', tabIndex: 0, onClick: toggle,
      onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
      title: row.isProtected ? 'This achievement is protected.' : (i.now ? 'Click to lock' : 'Click to unlock'),
      className: 'amx-tile' + (i.now ? ' amx-on' : ' amx-off') + (i.edited ? ' amx-changed' : '') + (row.isProtected ? ' amx-protected' : ''),
    },
      h('div', { className: 'amx-tilehead' },
        h(AchievementIcon, { appId: m.appId, names: row.iconNames, dim: !i.now }),
        h('div', { className: 'amx-text' },
          h('div', { className: 'amx-ctitle' }, row.title),
          h('div', { className: 'amx-sub' }, i.edited ? i.will : (i.now ? (i.unlocked || 'Unlocked') : 'Locked')))),
      row.isProtected ? h(ProtectedIcon) : h('span', { className: 'amx-check' + (i.now ? ' amx-checked' : '') }, i.now ? checkMark() : null),
      h('div', { className: 'amx-tdesc', title: i.desc }, i.desc),
      h('div', { className: 'amx-rarity' + (i.pct == null ? ' amx-none' : ''), title: i.pct == null ? undefined : i.pct.toFixed(1) + '% of players have this achievement' },
        i.pct == null ? null : [
          h('div', { key: 'bar', className: 'amx-rbar' }, h('div', { className: 'amx-rfill', style: { width: Math.max(0, Math.min(100, i.pct)) + '%' } })),
          h('span', { key: 'n' }, i.pct.toFixed(1) + '%')]));
  };
  const grid = stats
    ? (m.listedStats.length ? h('div', { key: 'grid', className: 'amx-grid DialogBody' }, m.listedStats.map(def => statTileEl(m, def))) : h('div', { key: 'grid', className: 'amx-list DialogBody' }, altEmpty(m, true)))
    : (m.shown.length
      ? h('div', { key: 'grid', className: 'amx-grid DialogBody' }, m.shown.map(tile), altMore(m))
      : h('div', { key: 'grid', className: 'amx-list DialogBody' }, altEmpty(m, false)));
  return h('div', { className: 'amx-wrap amx-showcase' },
    h('div', { className: 'amx-head' },
      h('div', { className: 'amx-titles' },
        h('div', { className: 'amx-title' }, m.gameName || TITLE),
        h('div', { className: 'amx-subtitle' }, stats ? `${m.statDefs.length} stat${m.statDefs.length === 1 ? '' : 's'}` : `${m.unlockedNow} of ${m.rows.length} unlocked (${m.percent}%)`)),
      altViewTabs(m, 'amx-seg')),
    stats ? null : h('div', { key: 'progress', style: { flex: 'none' } }, h(API.ProgressBar, { nProgress: m.percent })),
    waiting || [
      h('div', { key: 'tools', className: 'amx-row', style: { flexWrap: 'nowrap' } },
        altSearch(m), stats ? null : altFilter(m), stats ? null : altSort(m)),
      grid,
      altFooter(m, { bulk: true, status: true }),
    ]);
}

/* ───── design: table (compact, with tick boxes) ───── */

function TableLayout({ m }) {
  const stats = altInStats(m);
  const waiting = altWaiting(m);
  const [sel, setSel] = React.useState({});             // achievement name -> ticked
  const ticked = m.rows.filter(r => sel[r.name] && !r.isProtected);
  const tickable = m.visible.filter(r => !r.isProtected);
  const allOn = tickable.length > 0 && tickable.every(r => sel[r.name]);
  const tickAll = () => setSel(prev => { const next = { ...prev }; tickable.forEach(r => { if (allOn) delete next[r.name]; else next[r.name] = true; }); return next; });
  const tickOne = row => setSel(prev => { const next = { ...prev }; if (next[row.name]) delete next[row.name]; else next[row.name] = true; return next; });
  // a header click sorts by that column; clicking it again goes back to Steam's order
  const sortBy = name => () => m.setSort(m.sort === name ? 'Steam order' : name);
  const arrow = names => (names.includes(m.sort) ? (m.sort === 'Locked first' ? ' \u2191' : ' \u2193') : '');
  const head = stats
    ? h('div', { key: 'hd', className: 'amx-trow amx-statrow amx-hd' }, h('div', null, 'Stat'), h('div', null, 'Value'))
    : h('div', { key: 'hd', className: 'amx-trow amx-hd' },
      checkBox(allOn, tickAll, 'all'), h('div', { key: 'i' }),
      h('div', { key: 'n', className: 'amx-sortable', onClick: sortBy('Name') }, 'Achievement' + arrow(['Name'])),
      h('div', { key: 'r' }, 'Rarity'),
      h('div', { key: 'u', className: 'amx-sortable', onClick: sortBy('Recently unlocked') }, 'Unlocked' + arrow(['Recently unlocked'])),
      h('div', { key: 's', className: 'amx-sortable', onClick: () => m.setSort(m.sort === 'Unlocked first' ? 'Locked first' : (m.sort === 'Locked first' ? 'Steam order' : 'Unlocked first')) }, 'State' + arrow(['Unlocked first', 'Locked first'])));
  const trow = row => {
    const i = rowInfo(m, row);
    return h('div', { key: row.name, className: 'amx-trow' + (i.edited ? ' amx-changed' : '') + (sel[row.name] ? ' amx-sel' : '') },
      row.isProtected ? h('span', { key: 'p' }) : checkBox(!!sel[row.name], () => tickOne(row), 'c'),
      h(AchievementIcon, { appId: m.appId, names: row.iconNames, dim: !i.now }),
      h('div', { className: 'amx-text' },
        h('div', { className: 'amx-ctitle', title: row.title }, row.title),
        h('div', { className: 'amx-sub', title: i.desc }, i.edited ? i.will : i.desc)),
      h('div', { className: 'amx-cell' }, i.pct == null ? '' : h('div', { className: 'amx-rarity' },
        h('div', { className: 'amx-rbar' }, h('div', { className: 'amx-rfill', style: { width: Math.max(0, Math.min(100, i.pct)) + '%' } })),
        h('span', null, i.pct.toFixed(1) + '%'))),
      h('div', { className: 'amx-cell', title: i.unlocked }, row.achieved && row.unlockTime ? new Date(row.unlockTime * 1000).toLocaleDateString() : '\u2014'),
      h('div', { className: 'amw-rowtoggle' + (row.isProtected ? ' amw-protected' : ''), title: row.isProtected ? 'This achievement is protected.' : undefined },
        row.isProtected ? h(ProtectedIcon) : null,
        h(API.Toggle, { value: i.now, disabled: !!row.isProtected, onChange: v => m.setWanted(row, v) })));
  };
  const srow = def => {
    const i = statInfo(m, def);
    return h('div', { key: def.id, className: 'amx-trow amx-statrow' + (i.edited ? ' amx-changed' : '') },
      h('div', { className: 'amx-text' },
        h('div', { className: 'amx-ctitle' }, def.title),
        h('div', { className: 'amx-sub', title: i.meta }, i.check && !i.check.ok ? i.check.why : i.meta)),
      h('div', { className: 'amw-statinput', style: { width: '100%' } }, statStepper(m, def, i)));
  };
  const rowsEl = stats
    ? (m.listedStats.length ? m.listedStats.map(srow) : altEmpty(m, true))
    : (m.shown.length ? [m.shown.map(trow), altMore(m)] : altEmpty(m, false));
  return h('div', { className: 'amx-wrap amx-table' },
    h('div', { className: 'amx-head' },
      h('div', { className: 'amx-title' }, m.gameName || TITLE),
      h('span', { className: 'amx-pill' }, stats ? `${m.statDefs.length} stats` : `${m.unlockedNow} of ${m.rows.length} unlocked (${m.percent}%)`),
      altViewTabs(m, 'amx-seg')),
    waiting || [
      h('div', { key: 'tools', className: 'amx-row', style: { flexWrap: 'nowrap' } }, altSearch(m), stats ? null : altFilter(m)),
      stats ? null : h('div', { key: 'bulk', className: 'amx-bulk' },
        h('div', { className: 'amx-sub' }, ticked.length ? `${ticked.length} selected` : 'Select achievements with the boxes to change several at once.'),
        altBtn('Unlock selected', () => m.changeMany(ticked, true), { key: 'u', disabled: m.working || ticked.length === 0 }),
        altBtn('Lock selected', () => m.changeMany(ticked, false), { key: 'l', disabled: m.working || ticked.length === 0 }),
        altBtn('Clear', () => setSel({}), { key: 'c', title: 'Clear the selection', disabled: ticked.length === 0 })),
      head,
      h('div', { key: 'body', className: 'amx-body DialogBody' }, rowsEl),
      altFooter(m, { bulk: false, status: true }),
    ]);
}

/* ───── design: split (a list and a detail pane) ───── */

const rarityTier = pct => (pct == null ? '' : pct >= 50 ? 'Common' : pct >= 20 ? 'Uncommon' : pct >= 5 ? 'Rare' : 'Ultra rare');

function SplitLayout({ m }) {
  const stats = altInStats(m);
  const waiting = altWaiting(m);
  const [sel, setSel] = React.useState('');
  // the pinned row if it is still listed, otherwise the first one
  const focus = m.visible.find(r => r.name === sel) || m.visible[0] || null;
  const info = focus ? rowInfo(m, focus) : null;
  const toggle = row => { if (!row.isProtected) m.setWanted(row, !m.wanted(row)); };
  const srow = row => {
    const i = rowInfo(m, row);
    return h('div', {
      key: row.name, role: 'button', tabIndex: 0, onClick: () => setSel(row.name),
      onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(row.name); } },
      className: 'amx-srow' + (focus && focus.name === row.name ? ' amx-picked' : '') + (i.edited ? ' amx-changed' : ''),
    },
      h(AchievementIcon, { appId: m.appId, names: row.iconNames, dim: !i.now }),
      h('div', { className: 'amx-text' },
        h('div', { className: 'amx-ctitle', title: row.title }, row.title),
        h('div', { className: 'amx-sub' }, i.edited ? i.will : (i.now ? 'Unlocked' : 'Locked'))),
      h('div', { className: 'amw-rowtoggle' + (row.isProtected ? ' amw-protected' : ''), onClick: e => e.stopPropagation(), title: row.isProtected ? 'This achievement is protected.' : undefined },
        row.isProtected ? h(ProtectedIcon) : null,
        h(API.Toggle, { value: i.now, disabled: !!row.isProtected, onChange: v => m.setWanted(row, v) })));
  };
  const pane = h('div', { key: 'pane', className: 'amx-pane DialogBody' },
    !focus ? h('div', { className: 'amw-empty' }, m.rows.length ? 'No achievement matches the search and filter.' : 'Steam reports no achievements for this game.') : [
      h('div', { key: 'head', className: 'amx-panehead' },
        h(AchievementIcon, { appId: m.appId, names: focus.iconNames, dim: !info.now }),
        h('div', { className: 'amx-text' },
          h('div', { className: 'amx-ctitle' }, focus.title),
          h('div', { className: 'amx-sub' }, info.edited ? info.will : (info.now ? 'Unlocked' : 'Locked')),
          info.pct != null ? h('span', { className: 'amx-tier' }, rarityTier(info.pct)) : null)),
      info.desc ? h('div', { key: 'desc', className: 'amx-panedesc' }, info.desc) : null,
      info.pct != null ? h('div', { key: 'pct', className: 'amx-rarity' },
        h('div', { className: 'amx-rbar' }, h('div', { className: 'amx-rfill', style: { width: Math.max(0, Math.min(100, info.pct)) + '%' } })),
        h('span', null, info.pct.toFixed(1) + '% of players')) : null,
      info.unlocked ? h('div', { key: 'facts', className: 'amx-facts' }, h('div', null, info.unlocked)) : null,
      h('div', { key: 'act', className: 'amx-row' },
        altBtn(focus.isProtected ? 'Protected' : info.edited ? 'Undo' : info.now ? 'Lock' : 'Unlock', () => toggle(focus),
          { primary: true, disabled: !!focus.isProtected, title: focus.isProtected ? 'This achievement is protected.' : undefined }))]);
  const list = h('div', { key: 'list', className: 'amx-splitlist' },
    altSearch(m),
    h('div', { className: 'amx-pair' }, altFilter(m), altSort(m)),
    h('div', { className: 'amx-list DialogBody' }, m.shown.length ? [m.shown.map(srow), altMore(m)] : altEmpty(m, false)));
  const statsGrid = h('div', { key: 'grid', className: 'amx-grid DialogBody' }, m.listedStats.length ? m.listedStats.map(def => statTileEl(m, def)) : altEmpty(m, true));
  return h('div', { className: 'amx-wrap amx-splitwrap' },
    h('div', { className: 'amx-head' },
      h('div', { className: 'amx-titles' },
        h('div', { className: 'amx-title' }, m.gameName || TITLE),
        h('div', { className: 'amx-subtitle' }, stats ? `${m.statDefs.length} stat${m.statDefs.length === 1 ? '' : 's'}` : `${m.unlockedNow} of ${m.rows.length} unlocked (${m.percent}%)`)),
      altViewTabs(m, 'amx-seg')),
    waiting || [
      stats ? [h('div', { key: 'tools', className: 'amx-row' }, altSearch(m)), statsGrid]
        : h('div', { key: 'split', className: 'amx-split' }, list, pane),
      altFooter(m, { bulk: true, status: true }),
    ]);
}

const ALT_LAYOUTS = { showcase: ShowcaseLayout, table: TableLayout, split: SplitLayout };

function ManagerWindow({ appId, gameName, closeModal }) {
  const [phase, setPhase] = React.useState('loading');       // loading | ready | error
  const [problem, setProblem] = React.useState('');
  const [rows, setRows] = React.useState([]);
  const [coverage, setCoverage] = React.useState({ missing: 0, schemaFound: true, broken: false });
  const [edits, setEdits] = React.useState({});                // name -> wanted state, only where it differs
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState('All');
  const [sort, setSort] = React.useState('Steam order');
  const [limit, setLimit] = React.useState(PAGE);
  const [working, setWorking] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [notice, setNotice] = React.useState(null);            // { ok, text }
  const alive = React.useRef(true);
  const confirmTimer = React.useRef(0);
  const retried = React.useRef(false);
  const [view, setView] = React.useState('achievements');       // achievements | stats
  const [platform, setPlatform] = React.useState('');
  const [statDefs, setStatDefs] = React.useState([]);
  const [statValues, setStatValues] = React.useState({});       // stat id -> current number, for the stats Steam reports
  const [statEdits, setStatEdits] = React.useState({});         // stat id -> text typed, only where it differs
  const [statsPhase, setStatsPhase] = React.useState('idle');   // idle | loading | ready | error
  const [statsProblem, setStatsProblem] = React.useState('');
  const [statSearch, setStatSearch] = React.useState('');
  const [statConfirming, setStatConfirming] = React.useState(false);
  const design = React.useMemo(readDesign, []);                // classic | showcase | table | split, chosen in the plugin's settings

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(confirmTimer.current); }; }, []);

  // Two things are checked once the window is drawn: whether Steam's own styling reached our navigation column (if not, our
  // plain fallback look is switched on), and whether the theme has an accent colour for headings (Minimal Dark does).
  const rootRef = React.useRef(null);
  const [look, setLook] = React.useState({ fallback: false, title: '', radius: '', backdropColor: '', backdropImage: '' });
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) return;
    try {
      const view = el.ownerDocument.defaultView;
      const side = el.querySelector('.amw-side');
      const bg = side ? view.getComputedStyle(side).backgroundColor : '';
      const accent = view.getComputedStyle(el).getPropertyValue('--minimal_dark_color').trim();
      // the colour the dialog behind us is painted with (the theme's, or Steam's own): the outermost wrapper that has one,
      // short of the page itself, because the inner wrappers carry the panel colour and the outer one the window colour
      let backdropColor = '', backdropImage = '';
      for (let node = el.parentElement; node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement; node = node.parentElement) {
        const c = view.getComputedStyle(node);
        const m = /rgba?\(([^)]*)\)/.exec(c.backgroundColor || '');
        const opaque = !!m && (m[1].split(',').length < 4 || parseFloat(m[1].split(',')[3]) > 0.9);
        const image = c.backgroundImage && c.backgroundImage !== 'none' ? c.backgroundImage : '';
        if (opaque || image) { backdropColor = opaque ? c.backgroundColor : ''; backdropImage = image; }
      }
      const navItem = el.querySelector('.amw-nav-item');
      const radius = navItem ? view.getComputedStyle(navItem).borderTopLeftRadius : '';
      const next = { fallback: design === 'classic' && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent'), title: accent, radius, backdropColor, backdropImage };
      setLook(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch (e) { /* keep the defaults */ }
  }, [phase]);

  const ask = React.useCallback(async () => {
    try { return await callBackend('am_status', { steam_app_id: String(appId) }); }
    catch (e) { return { ok: false, error: 'backend_unreachable', detail: String((e && e.message) || e) }; }
  }, [appId]);

  const load = React.useCallback(async () => {
    setPhase('loading'); setProblem('');
    let res = await ask();
    if (!alive.current) return;
    if (res && res.ok && !res.schema_found && !retried.current) {
      retried.current = true;
      await new Promise(r => setTimeout(r, SCHEMA_RETRY_MS));
      if (!alive.current) return;
      res = await ask();
      if (!alive.current) return;
    }
    if (!res || !res.ok) { setProblem(explain(res)); setPhase('error'); return; }
    const built = rowsFrom(res, appId);
    setRows(built.rows);
    setCoverage({ missing: built.missing, schemaFound: built.schemaFound, broken: built.broken });
    setEdits({}); setConfirming(false); setLimit(PAGE);
    setStatDefs(built.statDefs); setPlatform(built.platform);
    setStatValues({}); setStatEdits({}); setStatConfirming(false); setStatsPhase('idle');
    setPhase('ready');
  }, [appId, ask]);

  React.useEffect(() => { load(); }, [load]);

  const has = name => Object.prototype.hasOwnProperty.call(edits, name);
  const wanted = row => (has(row.name) ? edits[row.name] : row.achieved);

  const setWanted = (row, value) => {
    if (row.isProtected) return;
    setConfirming(false); setNotice(null);
    setEdits(prev => {
      const next = { ...prev };
      if (value === row.achieved) delete next[row.name]; else next[row.name] = value;
      return next;
    });
  };
  const changeMany = (list, value) => {
    setConfirming(false); setNotice(null);
    setEdits(prev => {
      const next = { ...prev };
      for (const row of list.filter(r => !r.isProtected)) { if (value === row.achieved) delete next[row.name]; else next[row.name] = value; }
      return next;
    });
  };

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = rows.filter(r => {
      if (needle && !(r.title.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))) return false;
      const now = Object.prototype.hasOwnProperty.call(edits, r.name) ? edits[r.name] : r.achieved;
      if (filter === 'Unlocked') return now;
      if (filter === 'Locked') return !now;
      if (filter === 'Changed') return Object.prototype.hasOwnProperty.call(edits, r.name);
      return true;
    });
    const by = {
      'Steam order': (a, b) => a.order - b.order,
      'Name': (a, b) => a.title.localeCompare(b.title),
      'Unlocked first': (a, b) => (b.achieved - a.achieved) || (a.order - b.order),
      'Locked first': (a, b) => (a.achieved - b.achieved) || (a.order - b.order),
      'Recently unlocked': (a, b) => (b.unlockTime - a.unlockTime) || (a.order - b.order),
    }[sort];
    return list.slice().sort(by);
  }, [rows, edits, search, filter, sort]);

  const unlockedNow = rows.filter(r => wanted(r)).length;
  const changed = Object.keys(edits).length;
  const toUnlock = Object.keys(edits).filter(n => edits[n]);
  const toLock = Object.keys(edits).filter(n => !edits[n]);

  const apply = async () => {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => { if (alive.current) setConfirming(false); }, 6000);
      return;
    }
    setConfirming(false);
    setWorking(true);
    setNotice(null);
    let res;
    try { res = await callBackend('am_apply', { steam_app_id: String(appId), unlock: toUnlock, lock: toLock }); }
    catch (e) { res = { ok: false, error: 'backend_unreachable', detail: String((e && e.message) || e) }; }
    if (!alive.current) return;
    setWorking(false);
    if (res && res.ok) {
      const text = `Saved: ${res.unlocked_count || 0} unlocked, ${res.locked_count || 0} locked.`;
      await load();
      if (alive.current) setNotice({ ok: true, text });
    } else {
      setNotice({ ok: false, text: explain(res) });
    }
  };

  /* ───── stats ───── */

  const loadStats = React.useCallback(async () => {
    setStatsPhase('loading'); setStatsProblem('');
    let res;
    try { res = await callBackend('am_stats', { steam_app_id: String(appId), stats: statDefs.map(d => ({ kind: d.kind, name: d.id })) }); }
    catch (e) { res = { ok: false, error: 'backend_unreachable', detail: String((e && e.message) || e) }; }
    if (!alive.current) return;
    if (!res || !res.ok) { setStatsProblem(explain(res)); setStatsPhase('error'); return; }
    const values = {};
    Object.keys(res.stats || {}).forEach(id => { const raw = res.stats[id] && res.stats[id].value; const v = raw == null ? NaN : Number(raw); if (Number.isFinite(v)) values[id] = v; });
    setStatValues(values); setStatEdits({}); setStatsPhase('ready');
  }, [appId, statDefs]);

  React.useEffect(() => {
    if (view === 'stats' && statsPhase === 'idle' && statDefs.length > 0) loadStats();
  }, [view, statsPhase, statDefs, loadStats]);

  const statById = React.useMemo(() => { const m = {}; statDefs.forEach(d => { m[d.id] = d; }); return m; }, [statDefs]);
  const hasStat = id => Object.prototype.hasOwnProperty.call(statValues, id);
  const setStatText = (def, text) => {
    setStatConfirming(false); setNotice(null);
    setStatEdits(prev => {
      const next = { ...prev };
      if (hasStat(def.id) && String(text) === String(statValues[def.id])) delete next[def.id]; else next[def.id] = text;
      return next;
    });
  };
  // the edits that can be written (valid, and different from what Steam holds), and how many typed values are not acceptable
  const statChecks = Object.keys(statEdits).map(id => ({ def: statById[id], result: statById[id] ? checkStat(statById[id], statEdits[id], hasStat(id) ? statValues[id] : null) : { ok: false } }));
  const statWrites = statChecks.filter(c => c.def && c.result.ok && c.result.value !== statValues[c.def.id]);
  const statInvalid = statChecks.filter(c => !c.result.ok).length;

  const applyStats = async () => {
    if (!statConfirming) {
      setStatConfirming(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => { if (alive.current) setStatConfirming(false); }, 6000);
      return;
    }
    setStatConfirming(false);
    setWorking(true);
    setNotice(null);
    let res;
    try { res = await callBackend('am_stats_apply', { steam_app_id: String(appId), set: statWrites.map(c => ({ kind: c.def.kind, name: c.def.id, value: c.result.value })) }); }
    catch (e) { res = { ok: false, error: 'backend_unreachable', detail: String((e && e.message) || e) }; }
    if (!alive.current) return;
    setWorking(false);
    if (res && res.stats) {                          // what Steam holds now, whether or not everything was accepted
      const values = { ...statValues };
      Object.keys(res.stats).forEach(id => { const raw = res.stats[id] && res.stats[id].value; const v = raw == null ? NaN : Number(raw); if (Number.isFinite(v)) values[id] = v; });
      setStatValues(values); setStatEdits({});
    }
    if (res && res.ok) {
      const refused = Array.isArray(res.not_changed) ? res.not_changed : [];
      setNotice({ ok: refused.length === 0, text: `Saved ${res.changed || 0} of ${res.requested || 0} stat${res.requested === 1 ? '' : 's'}.` +
        (refused.length ? ` Steam did not change ${refused.length}: ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''}.` : '') });
    } else setNotice({ ok: false, text: explain(res) });
  };

  /* ───── pieces ───── */

  // Steam's dialog buttons; a plain Button stands in on a Millennium that does not offer them
  const DButton = API.DialogButton || API.Button;
  const DPrimary = API.DialogButtonPrimary || API.DialogButton || API.Button;

  // Steam's own class names for the parts of its Properties window (see the comment at CSS); ours are added next to them
  const statsAvailable = (platform === 'windows' || platform === 'linux') && statDefs.length > 0;
  const viewItem = (key, label, count) => h('div', {
    key: 'view-' + key, role: 'button',
    className: 'amw-nav-item _1-vlriAtKYDViAEunue4VO Focusable' + (view === key ? ' amw-on _2DpXjzK3WWsOtUWUrcuOG7' : ''),
    onClick: () => { setView(key); setConfirming(false); setStatConfirming(false); setNotice(null); },
  }, h('div', { className: 'amw-label _2PPbMrzl8PKBwpkjYs9b0i' }, label), phase === 'ready' ? h('div', { className: 'amw-count' }, String(count)) : null);

  const sideColumn = h('div', { className: 'amw-side PageListColumn Panel _2kwFFHckg8jvnwJfg9-la8' },
    h('div', { className: 'amw-game _2rjVTGz8aLvqOdz5v2gq5C' }, gameName || 'Achievements'),
    h('div', { className: 'amw-nav _18QCu-7MTzd51UpVbYysDy' },
      statsAvailable ? [viewItem('achievements', 'Achievements', rows.length), viewItem('stats', 'Stats', statDefs.length), h('div', { key: 'navsep', className: 'amw-navsep' })] : null,
      (view === 'achievements' || !statsAvailable) ? FILTERS.map(([key, label]) => {
        const count = key === 'All' ? rows.length
          : key === 'Unlocked' ? unlockedNow
          : key === 'Locked' ? rows.length - unlockedNow
          : changed;
        return h('div', {
          key, role: 'button',
          className: 'amw-nav-item _1-vlriAtKYDViAEunue4VO Focusable' + (filter === key ? ' amw-on _2DpXjzK3WWsOtUWUrcuOG7' : ''),
          onClick: () => { setFilter(key); setLimit(PAGE); },
        }, h('div', { className: 'amw-label _2PPbMrzl8PKBwpkjYs9b0i' }, label), phase === 'ready' ? h('div', { className: 'amw-count' }, String(count)) : null);
      }) : null),
    h('div', { className: 'amw-side-note' }, 'Changes are applied to your Steam account and can be reverted at any time.'));

  const frame = main => [
    h('div', { key: 'backdrop', className: 'amw-backdrop', style: { backgroundColor: look.backdropColor || undefined, backgroundImage: look.backdropImage || undefined } }),
    h('div', {
        key: 'root', ref: rootRef,
        className: 'amw-root _2sssIwe0duyIrFvat2oXzH' + (look.fallback ? ' amw-fallback' : '') + (design === 'classic' ? '' : ' amw-alt amx-design-' + design),
        style: (look.title || look.radius) ? { '--amw-title': look.title || undefined, '--amw-rowr': look.radius || undefined } : undefined,
      },
      h('style', null, design === 'classic' ? CSS : CSS + ALT_CSS),
      design === 'classic' ? sideColumn : null, h('div', { className: 'amw-main DialogContent_InnerWidth' }, main)),
  ];

  // one line at the bottom: the question while confirming, otherwise the last result or the number of changes
  const percent = rows.length ? Math.round((unlockedNow / rows.length) * 1000) / 10 : 0;
  let status = { cls: '', text: changed ? `${changed} change${changed === 1 ? '' : 's'} not saved yet` : '' };
  if (confirming) status = { cls: 'amw-warn', text: `Unlock ${toUnlock.length}, lock ${toLock.length}? Press Confirm to save to your Steam account.` };
  else if (working) status = { cls: '', text: 'Saving to your Steam account...' };
  else if (notice) status = { cls: notice.ok ? 'amw-ok' : 'amw-bad', text: notice.text };
  else if (!changed && coverage.missing > 0) status = { cls: 'amw-warn', text: coverage.schemaFound ? `${coverage.missing} of ${rows.length} names and icons are missing; their ID is shown.` : 'Steam has not saved this game\'s achievement list yet, so IDs are shown. Reload in a moment.' };
  let statStatus = { cls: '', text: Object.keys(statEdits).length ? `${Object.keys(statEdits).length} change${Object.keys(statEdits).length === 1 ? '' : 's'} not saved yet` : '' };
  if (statConfirming) statStatus = { cls: 'amw-warn', text: `Write ${statWrites.length} stat${statWrites.length === 1 ? '' : 's'}? Press Confirm to save to your Steam account.` };
  else if (working) statStatus = { cls: '', text: 'Saving to your Steam account...' };
  else if (notice) statStatus = { cls: notice.ok ? 'amw-ok' : 'amw-bad', text: notice.text };
  else if (statInvalid) statStatus = { cls: 'amw-warn', text: `${statInvalid} value${statInvalid === 1 ? ' is' : 's are'} not acceptable and will be skipped.` };

  if (phase === 'loading') {
    // the loader Steam shows when it waits on something: its logo, a ring turning around it, a line of text.
    // The turning arc takes Millennium's accent colour (--SystemAccentColor), white when none is set.
    return frame(h('div', { className: 'amw-center' },
      h('div', { style: { position: 'relative', width: 96, height: 96 } },
        h('svg', { viewBox: '0 0 96 96', width: 96, height: 96, style: { position: 'absolute', left: 0, top: 0, animation: 'amw-ring 1.1s linear infinite' } },
          h('circle', { cx: 48, cy: 48, r: 46, fill: 'none', stroke: 'rgba(255,255,255,0.12)', strokeWidth: 2 }),
          h('circle', { cx: 48, cy: 48, r: 46, fill: 'none', stroke: '#ffffff', strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '72 217',
            style: { stroke: 'var(--SystemAccentColor, #ffffff)' } })),
        h('svg', { viewBox: '0 0 24 24', width: 68, height: 68, fill: '#ffffff', style: { position: 'absolute', left: 14, top: 14 } },
          h('path', { d: STEAM_LOGO }))),
      h('div', { style: { fontSize: 18, opacity: 0.85 } }, 'Loading Achievements...')));
  }

  if (phase === 'error') {
    return frame(h('div', { className: 'amw-center' },
      h('div', { className: 'amw-title' }, TITLE),
      h('div', { className: 'amw-msg' }, problem),
      h(DButton, { onClick: load }, 'Try again')));
  }

  // the other designs share all state and actions with the classic one and only draw them differently
  if (design !== 'classic') {
    const needle = statSearch.trim().toLowerCase();
    const model = {
      appId, gameName, DButton, rows, visible, shown: visible.slice(0, limit), setLimit,
      filter, setFilter, search, setSearch, sort, setSort, view, statsAvailable,
      statDefs, statsPhase, statsProblem, setStatsPhase, statValues, statEdits, statSearch, setStatSearch, setStatText, hasStat,
      listedStats: statDefs.filter(d => !needle || d.title.toLowerCase().includes(needle) || d.id.toLowerCase().includes(needle)),
      counts: { All: rows.length, Unlocked: unlockedNow, Locked: rows.length - unlockedNow, Changed: changed },
      unlockedNow, changed, percent, wanted, has, setWanted, changeMany, working, confirming, statConfirming, status, statStatus, statWrites, coverage,
      apply, applyStats,
      switchView: key => { setView(key); setConfirming(false); setStatConfirming(false); setNotice(null); },
      revert: () => { setEdits({}); setConfirming(false); setNotice(null); },
      revertStats: () => { setStatEdits({}); setStatConfirming(false); setNotice(null); },
      reload: () => { retried.current = false; load(); },
    };
    return frame(h(ALT_LAYOUTS[design] || ShowcaseLayout, { m: model }));
  }

  if (view === 'stats' && statsAvailable) {
    if (statsPhase !== 'ready') {
      if (statsPhase === 'error') {
        return frame(h('div', { className: 'amw-center' },
          h('div', { className: 'amw-title' }, 'Stats'),
          h('div', { className: 'amw-msg' }, statsProblem),
          h(DButton, { onClick: () => setStatsPhase('idle') }, 'Try again')));
      }
      return frame(h('div', { className: 'amw-center' }, h('div', { className: 'amw-msg' }, 'Reading stats from Steam...')));
    }
    const needle = statSearch.trim().toLowerCase();
    const listed = statDefs.filter(d => !needle || d.title.toLowerCase().includes(needle) || d.id.toLowerCase().includes(needle));
    const statRow = def => {
      const known = hasStat(def.id);
      const edited = Object.prototype.hasOwnProperty.call(statEdits, def.id);
      const text = edited ? statEdits[def.id] : (known ? String(statValues[def.id]) : '');
      const check = edited ? checkStat(def, text, known ? statValues[def.id] : null) : null;
      const meta = [def.kind === 'i' ? 'Whole number' : def.kind === 'f' ? 'Decimal number' : 'Average rate'];
      if (def.title !== def.id) meta.push(def.id);
      if (def.min != null && def.min > -1e9) meta.push('min ' + def.min);
      if (def.max != null && def.max < 1e9) meta.push('max ' + def.max);
      if (def.increment) meta.push('can only go up');
      if (def.locked) meta.push(def.reason);
      if (!known) meta.push('Steam does not report this stat');
      return h('div', { key: def.id, className: 'amw-row amw-statrow' + (edited ? ' amw-row-changed' : '') },
        h('div', { className: 'amw-rowtext' },
          h('div', { className: 'amw-rowtitle' }, def.title),
          h('div', { className: 'amw-rowdesc' }, meta.join('  ·  ')),
          check && !check.ok ? h('div', { className: 'amw-statwhy amw-bad' }, check.why) : null),
        h('div', { className: 'amw-statinput' },
          h(Stepper, { def, text, current: known ? statValues[def.id] : null, known, bad: !!(check && !check.ok), onChange: t => setStatText(def, t) })));
    };
    return frame([
      h('div', { key: 'head', className: 'amw-head' },
        h('div', { className: 'amw-title' }, 'Stats'),
        h('div', { className: 'amw-sub' }, `${statDefs.length} stat${statDefs.length === 1 ? '' : 's'}. A game may overwrite an edited stat, and Steam applies its own limits.`)),
      h('div', { key: 'tools', className: 'amw-tools' },
        h('div', { className: 'amw-search' },
          h(API.TextField, { value: statSearch, placeholder: 'Search stats...', onChange: e => setStatSearch(e.target.value) }))),
      h('div', { key: 'list', className: 'amw-list DialogBody' },
        listed.length === 0 ? h('div', { className: 'amw-empty' }, 'No stat matches the search.') : listed.map(statRow)),
      h('div', { key: 'foot', className: 'amw-foot' },
        h('div', { className: 'amw-status ' + statStatus.cls }, statStatus.text),
        h('div', { className: 'amw-actions' },
          h(DButton, { onClick: () => { setStatEdits({}); setStatConfirming(false); setNotice(null); }, disabled: working || Object.keys(statEdits).length === 0 }, 'Revert'),
          h(DPrimary, { className: 'amw-primary', onClick: applyStats, disabled: working || statWrites.length === 0 }, statConfirming ? 'Confirm' : 'Apply'))),
    ]);
  }

  const shown = visible.slice(0, limit);
  const fmtDate = t => (t ? new Date(t * 1000).toLocaleString() : '');
  const current = FILTERS.find(f => f[0] === filter);

  const rowEl = row => {
    const now = wanted(row);
    const isChanged = has(row.name);
    const lines = [];
    if (row.description) lines.push(row.description);
    else if (row.hidden) lines.push('Hidden achievement');
    if (row.achieved && row.unlockTime) lines.push('Unlocked ' + fmtDate(row.unlockTime));
    if (isChanged) lines.push(now ? 'Will be unlocked' : 'Will be locked');
    return h('div', { key: row.name, className: 'amw-row ' + (now ? 'amw-row-on' : 'amw-row-off') + (isChanged ? ' amw-row-changed' : '') },
      h(AchievementIcon, { appId, names: row.iconNames, dim: !now }),
      h('div', { className: 'amw-rowtext' },
        h('div', { className: 'amw-rowtitle' }, row.title),
        lines.length ? h('div', { className: 'amw-rowdesc' }, lines.join('  ·  ')) : null,
        row.percent != null ? h('div', { className: 'amw-rowpct' }, `${row.percent.toFixed(1)}% of players have this achievement`) : null),
      h('div', { className: 'amw-rowtoggle' + (row.isProtected ? ' amw-protected' : ''), title: row.isProtected ? 'This achievement is protected.' : undefined },
        row.isProtected ? h(ProtectedIcon) : null,
        h(API.Toggle, { value: now, disabled: !!row.isProtected, onChange: v => setWanted(row, v) })));
  };

  return frame([
    h('div', { key: 'head', className: 'amw-head' },
      h('div', { className: 'amw-title' }, current ? current[1] : TITLE),
      h('div', { className: 'amw-sub' }, `${unlockedNow} of ${rows.length} unlocked (${percent}%)`)),
    h('div', { key: 'bar', className: 'amw-bar' }, h(API.ProgressBar, { nProgress: percent })),
    h('div', { key: 'tools', className: 'amw-tools' },
      h('div', { className: 'amw-search' },
        h(API.TextField, { value: search, placeholder: 'Search achievements...', onChange: e => { setSearch(e.target.value); setLimit(PAGE); } })),
      h('div', { className: 'amw-sort' },
        h(API.Dropdown, { rgOptions: SORTS.map(s => ({ label: s, data: s })), selectedOption: sort, onChange: o => setSort(o.data), contextMenuPositionOptions: { bMatchWidth: false } }))),
    h('div', { key: 'list', className: 'amw-list DialogBody' },
      shown.length === 0
        ? h('div', { className: 'amw-empty' }, rows.length ? 'No achievement matches the search and filter.' : 'Steam reports no achievements for this game.')
        : shown.map(rowEl),
      visible.length > shown.length
        ? h('div', { className: 'amw-more' }, h(DButton, { onClick: () => setLimit(l => l + PAGE) }, `Show ${visible.length - shown.length} more`))
        : null),
    h('div', { key: 'foot', className: 'amw-foot' },
      h('div', { className: 'amw-status ' + status.cls }, status.text),
      h('div', { className: 'amw-actions' },
        coverage.missing > 0 ? h(DButton, { onClick: () => { retried.current = false; load(); }, disabled: working }, 'Reload') : null,
        h(DButton, { onClick: () => changeMany(visible, true), disabled: working || visible.length === 0 }, 'Unlock shown'),
        h(DButton, { onClick: () => changeMany(visible, false), disabled: working || visible.length === 0 }, 'Lock shown'),
        h(DButton, { onClick: () => { setEdits({}); setConfirming(false); setNotice(null); }, disabled: working || changed === 0 }, 'Revert'),
        h(DPrimary, { className: 'amw-primary', onClick: apply, disabled: working || changed === 0 }, confirming ? 'Confirm' : 'Apply'))),
  ]);
}

// the modal wrapper Steam gives a dialog (a plain element stands in when this Millennium has none)
function WindowRoot(props) {
  const inner = Guard ? h(Guard, null, h(ManagerWindow, props)) : h(ManagerWindow, props);
  if (!API.ModalRoot) return inner;
  return h(API.ModalRoot, { closeModal: props.closeModal, onCancel: props.closeModal, bAllowFullSize: true, className: 'amw-outer', modalClassName: 'amw-modal' }, inner);
}

function libraryWindow() {
  try {
    const popup = window.g_PopupManager.GetExistingPopup('SP Desktop_uid0');
    const win = popup && (popup.window || popup.m_popup || popup.m_window);
    return popup && win ? { popup, win } : null;
  } catch (e) { return null; }
}

// a tiny error boundary: if the window cannot be drawn, say why instead of showing nothing
function makeGuard() {
  if (!React.Component) return null;
  return class Guard extends React.Component {
    constructor(props) { super(props); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    componentDidCatch(err) { console.error('[Achievement Manager] the window could not be drawn', err); }
    render() {
      if (this.state.err) return h('div', { style: { padding: 28, color: '#fff', fontSize: 15, lineHeight: 1.4 } },
        'Achievement Manager could not draw its window: ' + String((this.state.err && this.state.err.message) || this.state.err));
      return this.props.children;
    }
  };
}
const Guard = makeGuard();

function openWindow(appId, gameName) {
  const show = API.showModal || window.showModal;
  if (typeof show !== 'function') throw new Error('showModal is not available');
  const lib = libraryWindow();
  const element = h(WindowRoot, { appId: String(appId), gameName: gameName || '' });
  const options = { strTitle: TITLE, popupWidth: 960, popupHeight: 660, bNeverPopOut: false };
  // a separate window like Steam's Properties dialog. The second argument of showModal is the parent WINDOW (the library
  // window itself); handing it the popup object made Steam fail inside GetModalManager ("reading 'title'")
  console.log('[Achievement Manager] opening the window for app', appId, lib ? '(parent: library window)' : '(no library window found)');
  if (!lib) return show(element, undefined, options);
  try { return show(element, lib.win, options); }
  catch (e) {
    console.error('[Achievement Manager] showModal with the library window failed, trying without a parent', e);
    return show(element, undefined, options);
  }
}

/* ═════════════ the button ═════════════ */

const BTN_ATTR = 'data-achievement-manager';

const isShown = el => {
  try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; } catch (e) { return false; }
};

/* The word for "achievement" in each of Steam's languages (stems, so plurals match). Steam translates the button, so
 * English alone isn't enough; the table is picked by the language Steam reports (like the Easy Restart plugin does). */
const ACHIEVEMENT_WORDS = {
  arabic: ['نجاز'], bulgarian: ['постижени', 'достижени'], schinese: ['成就'], tchinese: ['成就'],
  czech: ['úspěch', 'úspěš'], danish: ['bedrift', 'præstation'], dutch: ['prestatie'], finnish: ['saavutu'],
  french: ['succès', 'réussite', 'accomplissement'], german: ['errungenschaft'], greek: ['επιτεύγμ', 'επίτευγμ'], hungarian: ['teljesítmény', 'eredmény'],
  indonesian: ['pencapaian'], italian: ['obiettiv'], japanese: ['実績'], koreana: ['도전', '업적'],
  latam: ['logro'], norwegian: ['prestasjon'], polish: ['osiągni'], portuguese: ['conquista'], brazilian: ['conquista'],
  romanian: ['realiz'], russian: ['достижени'], spanish: ['logro'], swedish: ['prestation'], thai: ['ความสำเร็จ'],
  turkish: ['başar'], ukrainian: ['досягнен'], vietnamese: ['thành tích', 'thành tựu'],
};

// lower case and without accents, so "Succès" and "succes" both match; applied to the stems and to the button text alike
const fold = text => {
  const t = String(text || '');
  try { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); } catch (e) { return t.toLowerCase(); }
};
const WORDS = {};
Object.keys(ACHIEVEMENT_WORDS).forEach(k => { WORDS[k] = ACHIEVEMENT_WORDS[k].map(fold); });
const ALL_WORDS = [].concat(...Object.keys(WORDS).map(k => WORDS[k]));

// the language Steam shows (a Steam name such as "german"); read again on every tick, so it follows the setting
let steamUiLanguage = 'english';
async function readSteamLanguage() {
  try {
    const settings = window.SteamClient && window.SteamClient.Settings;
    const result = settings && typeof settings.GetCurrentLanguage === 'function' ? settings.GetCurrentLanguage() : null;
    const value = result && typeof result.then === 'function' ? await result : result;
    if (value) return steamLanguage(String(value));
  } catch (e) { /* ask the next source */ }
  try { const l = window.LocalizationManager.m_rgLocalesToUse[0]; if (l) return steamLanguage(String(l)); } catch (e) { /* not exposed */ }
  return steamLanguage((navigator && navigator.language) || 'english');
}
async function refreshLanguage() {
  try { steamUiLanguage = await readSteamLanguage(); } catch (e) { /* keep the last one */ }
}

let lastTier = '';
const noteTier = tier => {
  if (tier === lastTier) return;
  lastTier = tier;
  console.log('[Achievement Manager] button found by: ' + tier + ' (Steam language: ' + steamUiLanguage + ')');
};

// the shown buttons of a page whose text is short enough to be "View My Achievements" in any language
function shortButtons(doc) {
  const out = [];
  doc.querySelectorAll('button, [role="button"]').forEach(n => {
    if (n.getAttribute(BTN_ATTR)) return;
    const text = (n.textContent || '').trim();
    if (text.length > 0 && text.length < 60 && isShown(n)) out.push({ node: n, text, folded: fold(text) });
  });
  return out;
}

// A copy may only go beside Steam's real "View My Achievements" button, never beside a filter, a collection header or a menu
// entry. So a candidate must sit in the achievements section of a game's page (or belong to a game, which we can tell from its
// React props), and nothing inside a menu, list, dialog or tooltip counts. The looser word searches require the section itself.
const NOT_HERE = '[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[role="dialog"],[role="tooltip"],[class*="contextmenu" i],[class*="dropdown" i]';
function gate(node, strict) {
  try {
    if (node.closest(NOT_HERE)) return false;
    if (node.closest('[class*="achievementssection" i]')) return true;
    return !strict && !!appFromElement(node);
  } catch (e) { return false; }
}

// Finds "View My Achievements" in Steam's language, skipping hidden ones (a copy of a hidden button would be hidden too).
// Three passes: the English wording, then the words of Steam's current language, then the words of every language (in case
// the language couldn't be read). The last pass only counts inside the achievements section.
function findAnchor(doc) {
  const buttons = shortButtons(doc);
  // of several candidates the one inside the achievements section wins
  const pick = list => list.find(b => { try { return !!b.node.closest('[class*="achievementssection" i]'); } catch (e) { return false; } }) || list[0] || null;
  const english = pick(buttons.filter(b => b.folded.length < 40 && b.folded.startsWith('view') && b.folded.includes('achievement') && gate(b.node, false)));
  if (english) { noteTier('English wording'); return english.node; }
  const own = WORDS[steamUiLanguage] || [];
  if (own.length) {
    const hit = pick(buttons.filter(b => own.some(w => b.folded.includes(w)) && gate(b.node, false)));
    if (hit) { noteTier('words of ' + steamUiLanguage); return hit.node; }
  }
  const any = pick(buttons.filter(b => ALL_WORDS.some(w => b.folded.includes(w)) && gate(b.node, true)));
  if (any) { noteTier('words of another language'); return any.node; }
  return null;
}

// Last resort when no wording matched (a language missing from the table): a button inside an element whose class mentions
// achievements, on a game's page.
function findLooseAnchor(doc) {
  for (const b of shortButtons(doc)) {
    let area = false, el = b.node.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      if (/achievement/i.test(el.getAttribute('class') || '')) { area = true; break; }
    }
    if (!area || !gate(b.node, false)) continue;
    let info = null;
    try { info = appFromElement(b.node); } catch (e) { info = null; }
    if (info) { noteTier('a button in the achievements area'); return b.node; }
  }
  return null;
}

// Why is an achievement not unlocking? Console helper (Steam's shared JS context):
//   copy((await __achievementManager.diagnose(863550)).join('\n'))                  a report for the game
//   copy((await __achievementManager.diagnose(863550, 'Title or ACH_NAME')).join('\n'))   plus a verdict for one or more achievements (title or API name)
// Read-only. It runs the status helper once (Steam may show you as in-game for a moment) and compares what the game's schema,
// Steam's own list for your account and Steam's public numbers say. Returns the report as an array of lines.
async function diagnose(appId, names) {
  const out = [];
  const say = t => out.push(String(t));
  const when = sec => (sec ? new Date(sec * 1000).toLocaleString() : '');
  const list = (title, items) => { if (items.length) say(`${title} (${items.length}): ${items.slice(0, 25).join(', ')}${items.length > 25 ? ', ...' : ''}`); };
  try {
    const match = String(appId == null ? '' : appId).match(/\d+/);
    const id = match ? match[0] : '';
    say('Achievement Manager diagnostics, plugin ' + PLUGIN_VERSION);
    say('time: ' + new Date().toISOString());
    say('steam language: ' + steamUiLanguage + ' | ' + String(navigator.userAgent || '').slice(0, 140));
    if (!id) { say('No app id given. Use diagnose(<appid>).'); return out; }
    let gameName = '';
    try {                                   // the game's name, when Steam's UI can tell it (helps to spot a wrong app id)
      const overview = window.appStore && window.appStore.GetAppOverviewByAppID && window.appStore.GetAppOverviewByAppID(Number(id));
      gameName = (overview && (overview.display_name || overview.name)) || '';
    } catch (e) { gameName = ''; }
    say('app: ' + id + (gameName ? ' (' + gameName + ')' : ''));

    let res;
    try { res = await callBackend('am_status', { steam_app_id: id }); }
    catch (e) { res = { ok: false, error: 'backend_unreachable', detail: String((e && e.message) || e) }; }
    if (!res || !res.ok) {
      say('STATUS FAILED: ' + ((res && res.error) || 'no answer') + (res && res.detail ? ' [' + res.detail + ']' : ''));
      say('meaning: ' + explain(res));
      return out;
    }
    const steamNames = Object.keys(res.achievements || {});
    const achieved = steamNames.filter(n => res.achievements[n].achieved);
    say(`helper: ok on ${res.platform || 'unknown system'}. Steam lists ${steamNames.length} achievements for this account: ${achieved.length} unlocked, ${steamNames.length - achieved.length} locked`);

    let defs = {};
    let tree = null;
    if (res.schema_found && res.schema_hex) {
      try { tree = parseBinaryKV(hexToBytes(res.schema_hex)); defs = extractAchievements(tree, id, steamLanguageNow()); } catch (e) { say('schema could not be read: ' + ((e && e.message) || e)); }
    }
    const defNames = Object.keys(defs);
    say(`schema: ${res.schema_found ? (res.schema_bytes || '?') + ' bytes' + (tree && tree.broken ? ' (partly unreadable)' : '') : 'NOT FOUND'}, ${defNames.length} achievements defined`);
    const shares = sharesFrom(res);
    say(`global percentages: ${Object.keys(shares).length ? Object.keys(shares).length + ' known' : 'not available (offline, or Steam has none for this game)'}`);

    const schemaOnly = defNames.filter(n => !res.achievements[n]);
    const unknownToSchema = steamNames.filter(n => !defs[n]);
    const protectedLocked = steamNames.filter(n => defs[n] && defs[n].permission !== 0 && !res.achievements[n].achieved);
    list('in the schema but not listed by Steam for this account, so they cannot be unlocked from here (DLC not owned, archived, or another game version)', schemaOnly);
    list('listed by Steam but missing from the schema (shown without a title)', unknownToSchema);
    list('locked, with a non-zero permission in the schema (the game sets these itself; Steam usually refuses them from a client)', protectedLocked);

    const wanted = (names == null ? [] : (Array.isArray(names) ? names : [names])).map(String);
    const allNames = Array.from(new Set(steamNames.concat(defNames)));
    const titleOf = n => String((defs[n] && defs[n].title) || '').toLowerCase();
    for (const asked of wanted) {
      const q = asked.toLowerCase();
      // an API name (exact, then ignoring case), otherwise the title shown in Steam
      let found = allNames.filter(n => n === asked);
      let how = '';
      if (!found.length) { found = allNames.filter(n => n.toLowerCase() === q); how = ' (matched the API name ignoring case)'; }
      if (!found.length) { found = allNames.filter(n => titleOf(n) === q); how = ' (matched by title)'; }
      if (!found.length) { found = allNames.filter(n => titleOf(n).includes(q)); how = ' (matched part of the title)'; }
      if (!found.length) {
        const near = allNames.filter(n => n.toLowerCase().includes(q)).slice(0, 5);
        say('');
        say(`[${asked}] not found: no achievement has that API name or title in the schema or in Steam's list${near.length ? '; similar names: ' + near.join(', ') : ''}. Check that this is the right game (${id}${gameName ? ', ' + gameName : ''}).`);
        continue;
      }
      for (const name of found.slice(0, 5)) {
        const d = defs[name], st = res.achievements[name];
        say('');
        say(`[${name}]${how} ${d ? 'title "' + d.title + '"' : 'no title in the schema'}${d && d.hidden ? ', hidden' : ''}`);
        say(`  in the schema: ${d ? 'yes (bit ' + d.bit + ', permission ' + d.permission + (d.permission !== 0 ? ', protected' : '') + ')' : 'no'}`);
        say(`  listed by Steam for this account: ${st ? 'yes' : 'NO'}`);
        if (st) say(`  state: ${st.achieved ? 'unlocked' + (st.unlock_time ? ' on ' + when(st.unlock_time) : '') : 'locked'}`);
        say(`  share of players: ${Object.prototype.hasOwnProperty.call(shares, name) ? shares[name].toFixed(1) + '%' : 'unknown'}`);
        if (d) {
          const urls = iconCandidates(id, st && st.achieved ? [d.icon, d.iconGray] : [d.iconGray || d.icon, d.icon]);
          say(`  icon values in the schema: icon "${d.icon || ''}", icon_gray "${d.iconGray || ''}"`);
          say(`  icon addresses tried in order (${urls.length}): ${urls.slice(0, 3).join('  ')}${urls.length > 3 ? '  ...' : ''}`);
        }
        let verdict;
        if (!st) verdict = 'Steam does not list this achievement for your account, so an unlock request is ignored. Usually DLC you do not own, an archived achievement, or a different version of the game.';
        else if (st.achieved) verdict = 'Already unlocked on your account. If Steam\'s page still shows it locked, refresh the Steam UI.';
        else if (d && d.permission !== 0) verdict = 'Protected: the schema marks it with permission ' + d.permission + ', meaning the game itself sets this achievement. Steam usually refuses it from a client, and the window locks its toggle.';
        else verdict = 'Nothing visible prevents it. Unlock it in the window and press Apply; if it stays locked the window names it under "Steam did not change", which means Steam refused it.';
        say('  verdict: ' + verdict);
      }
      if (found.length > 5) say(`  (${found.length - 5} more matches not shown; use the API name)`);
    }
    say('');
    say('end of report');
  } catch (e) {
    say('diagnose failed: ' + ((e && e.stack) || e));
  }
  return out;
}

// for bug reports: what Steam's language is and which buttons the page has (__achievementManager.buttons())
function describeButtons() {
  const lib = libraryWindow();
  const doc = lib && lib.win.document;
  if (!doc) return { language: steamUiLanguage, error: 'the library window was not found' };
  const found = findAnchor(doc);
  return {
    language: steamUiLanguage,
    words: WORDS[steamUiLanguage] || null,
    found: found ? (found.textContent || '').trim() : null,
    buttons: shortButtons(doc).map(b => b.text),
  };
}

// the achievements section of the game page, for when there is no usable "View My Achievements" button
function findSection(doc) {
  const nodes = doc.querySelectorAll('[class*="achievementssection" i]');
  for (const n of nodes) { if (isShown(n) && !n.getAttribute(BTN_ATTR)) return n; }
  return null;
}

const positiveInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

// the game this button belongs to: walk up the React fibers of the button until one holds the app
function appFromElement(el) {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
  let fiber = key ? el[key] : null;
  let depth = 0, appId = 0, name = '';
  while (fiber && depth++ < 80) {
    const p = fiber.memoizedProps;
    if (p && typeof p === 'object') {
      const direct = positiveInt(p.appid) || positiveInt(p.appID) || positiveInt(p.nAppID) || positiveInt(p.unAppID);
      if (direct) { appId = direct; name = typeof p.name === 'string' ? p.name : ''; }
      if (!appId) {
        // an object prop that describes the app: overview, app, appOverview, details ...
        for (const k of Object.keys(p)) {
          const v = p[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const id = positiveInt(v.appid) || positiveInt(v.app_id) || positiveInt(v.appID);
            if (id) { appId = id; name = v.display_name || v.name || ''; break; }
          }
        }
      }
      if (appId) break;
    }
    fiber = fiber.return;
  }
  return appId ? { appId, name: typeof name === 'string' ? name : '' } : null;
}

// fallback: the page's own artwork has the app id in its address (.../apps/<id>/... or .../assets/<id>/...)
function appFromImages(doc) {
  const counts = new Map();
  const note = text => {
    const m = /\/(?:apps|assets)\/(\d{2,10})\//.exec(text || '');
    if (m) counts.set(Number(m[1]), (counts.get(Number(m[1])) || 0) + 1);
  };
  doc.querySelectorAll('img').forEach(img => note(img.currentSrc || img.src));
  doc.querySelectorAll('[style*="url("]').forEach(el => note(el.getAttribute('style')));
  let best = 0, hits = 0;
  counts.forEach((n, id) => { if (n > hits) { best = id; hits = n; } });
  return best ? { appId: best, name: '' } : null;
}

function findApp(anchor) {
  let info = null;
  try { info = appFromElement(anchor); } catch (e) { /* try the next way */ }
  if (!info) { try { info = appFromImages(anchor.ownerDocument); } catch (e) { /* none */ } }
  if (info && !info.name) { try { info.name = window.appStore.GetAppOverviewByAppID(info.appId).display_name || ''; } catch (e) { /* no name */ } }
  return info;
}

// show a short message on the button itself (the console is not where people look)
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { if (btn.getAttribute(BTN_ATTR)) btn.textContent = old === text ? TITLE : old; }, 3500);
}

// The copy is pinned to the original: its position is recalculated from the original's box whenever that changes (a size
// watcher, page redraws, and a check every 250 ms), so it can't drift or lag. The mode is decided fresh each time:
//   'left'   beside the original, on its left;
//   'below'  under the original, only when there is no room on the left (it never overlaps the original or sticks out of a
//            clipping parent, and goes back to the left once there is room);
//   'inside' at the end of the achievements section, when there is no usable button to sit beside.
const GAP = 8, HYSTERESIS = 12;

// would a button of this width, to the left of the original, be cut off by the window or by a parent that clips its content?
function clipsAt(anchor, width) {
  try {
    const view = anchor.ownerDocument.defaultView;
    const left = anchor.getBoundingClientRect().left - width - GAP;
    if (left < 0) return true;
    for (let el = anchor.parentElement; el && el !== anchor.ownerDocument.body; el = el.parentElement) {
      if (/(hidden|auto|scroll|clip)/.test(view.getComputedStyle(el).overflowX) && left < el.getBoundingClientRect().left - 1) return true;
    }
  } catch (e) { /* cannot tell */ }
  return false;
}

const setStyle = (el, props) => { for (const k of Object.keys(props)) { if (el.style[k] !== props[k]) el.style[k] = props[k]; } };

function pin(btn, anchor) {
  try {
    const mode = btn.getAttribute('data-amw-mode');
    if (mode === 'inside' || !anchor.parentNode) return;
    if (!btn.__amwWidth) {                                   // its own width, measured once, loose in the page
      setStyle(btn, { position: 'absolute', margin: '0', width: '', left: '0px', zIndex: '0' });
      btn.__amwWidth = btn.offsetWidth || 0;
    }
    const width = btn.__amwWidth;
    const wasBelow = mode === 'below';
    const room = anchor.offsetLeft - width - GAP;            // where its left edge would be, in the original's own container
    const fits = width > 0 && room >= (wasBelow ? HYSTERESIS : 0) && !clipsAt(anchor, width + (wasBelow ? HYSTERESIS : 0));

    if (!fits) {
      if (mode !== 'below') btn.setAttribute('data-amw-mode', 'below');
      if (anchor.nextElementSibling !== btn) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      setStyle(btn, { position: 'static', display: 'block', margin: '6px 0 0', left: '', top: '', height: '', zIndex: '0',
        width: anchor.offsetWidth ? anchor.offsetWidth + 'px' : '' });
      return;
    }
    if (mode !== 'left') btn.setAttribute('data-amw-mode', 'left');
    if (btn.nextElementSibling !== anchor) anchor.parentNode.insertBefore(btn, anchor);
    setStyle(btn, { position: 'absolute', display: '', margin: '0', right: 'auto', bottom: 'auto', width: '', zIndex: '0',
      left: room + 'px', top: anchor.offsetTop + 'px', height: anchor.offsetHeight ? anchor.offsetHeight + 'px' : '' });
  } catch (e) { /* layout not available */ }
}

// the copy that sits beside this original (before it, or after it when there was no room)
function mineBeside(anchor) {
  const prev = anchor.previousElementSibling, next = anchor.nextElementSibling;
  return prev && prev.getAttribute(BTN_ATTR) ? prev : (next && next.getAttribute(BTN_ATTR) ? next : null);
}

// keep the copy locked while the original lives: a size watcher on it and on what holds it, and a quick check
let sizeWatcher = null, watchedAnchor = null, pinTimer = 0;
function unwatch() {
  try { if (sizeWatcher) sizeWatcher.disconnect(); } catch (e) { /* ignore */ }
  sizeWatcher = null; watchedAnchor = null;
}
function watch(anchor, win) {
  if (watchedAnchor === anchor) return;
  unwatch();
  watchedAnchor = anchor;
  try {
    const RO = (win && win.ResizeObserver) || window.ResizeObserver;
    if (!RO) return;
    sizeWatcher = new RO(() => { const b = mineBeside(anchor); if (b) pin(b, anchor); });
    sizeWatcher.observe(anchor);
    if (anchor.parentElement) sizeWatcher.observe(anchor.parentElement);
    const section = anchor.closest('[class*="achievementssection" i]');
    if (section) sizeWatcher.observe(section);
  } catch (e) { /* no size watcher: the quick check still runs */ }
}
function quickPin() {
  const anchor = watchedAnchor;
  if (!anchor) return;
  const mine = anchor.isConnected ? mineBeside(anchor) : null;
  if (!anchor.isConnected || !isShown(anchor)) {              // the original is gone or hidden (another page): so is the copy
    try { const doc = anchor.ownerDocument; if (doc) doc.querySelectorAll('[' + BTN_ATTR + ']').forEach(n => n.remove()); } catch (e) { /* ignore */ }
    unwatch();
    return;
  }
  if (mine) pin(mine, anchor);
}

function onButtonClick(btn, doc, fallbackSource) {
  return event => {
    event.preventDefault(); event.stopPropagation();
    console.log('[Achievement Manager] button clicked');
    try {
      const source = findAnchor(doc) || findSection(doc) || fallbackSource;
      const info = findApp(source);
      if (!info) { console.error('[Achievement Manager] could not tell which game this page is for'); flash(btn, 'Game not found'); return; }
      console.log('[Achievement Manager] game', info.appId, info.name);
      openWindow(info.appId, info.name);
    } catch (e) {
      console.error('[Achievement Manager] could not open the window', e);
      flash(btn, 'Could not open');
    }
  };
}

function ensureButton(doc) {
  const anchor = findAnchor(doc) || (findSection(doc) ? null : findLooseAnchor(doc));
  const all = Array.prototype.slice.call(doc.querySelectorAll('[' + BTN_ATTR + ']'));

  if (anchor && anchor.parentNode) {
    const mine = mineBeside(anchor);
    all.forEach(n => { if (n !== mine) n.remove(); });                           // never more than one, and only beside the real button
    if (mine) { pin(mine, anchor); watch(anchor, doc.defaultView); return; }     // already there; keep it locked beside the original

    const btn = anchor.cloneNode(false);                                          // same classes: the theme's own look for Steam's buttons
    btn.removeAttribute('id');
    btn.setAttribute(BTN_ATTR, '1');
    btn.setAttribute('data-amw-mode', 'left');
    btn.textContent = TITLE;
    btn.addEventListener('click', onButtonClick(btn, doc, anchor));
    anchor.parentNode.insertBefore(btn, anchor);
    pin(btn, anchor);
    watch(anchor, doc.defaultView);
    const view = doc.defaultView;
    (view && view.requestAnimationFrame ? view.requestAnimationFrame.bind(view) : setTimeout)(() => pin(btn, anchor));
    return;
  }
  unwatch();

  // no usable button: a theme that hides it still shows the achievements section, so put our own button in that
  const section = findSection(doc);
  if (!section) { all.forEach(n => n.remove()); return; }                         // nothing of Steam's achievements here: no button either
  if (section.querySelector('[' + BTN_ATTR + ']')) { all.forEach(n => { if (!section.contains(n)) n.remove(); }); return; }
  all.forEach(n => n.remove());
  const btn = doc.createElement('button');
  btn.className = 'DialogButton _DialogLayout Secondary Focusable';                // Steam's own dialog button classes, so a theme styles it
  btn.setAttribute('role', 'button');
  btn.setAttribute(BTN_ATTR, '1');
  btn.setAttribute('data-amw-mode', 'inside');
  btn.textContent = TITLE;
  btn.style.display = 'block'; btn.style.margin = '8px 0 0'; btn.style.width = '100%'; btn.style.boxSizing = 'border-box';
  btn.addEventListener('click', onButtonClick(btn, doc, section));
  section.appendChild(btn);
}

let observer = null, observedDoc = null, poll = 0, debounce = 0;

function detach() {
  try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
  try { if (observedDoc) observedDoc.querySelectorAll('[' + BTN_ATTR + ']').forEach(n => n.remove()); } catch (e) { /* window gone */ }
  observer = null; observedDoc = null;
  unwatch();
}

function attach(doc, win) {
  if (observedDoc === doc) return;
  detach();
  observedDoc = doc;
  const Observer = win.MutationObserver || window.MutationObserver;
  observer = new Observer(() => { clearTimeout(debounce); debounce = setTimeout(() => { try { ensureButton(doc); } catch (e) { /* ignore */ } }, 150); });
  observer.observe(doc.body, { childList: true, subtree: true });
}

function start() {
  const tick = () => {
    refreshLanguage();
    const lib = libraryWindow();
    const doc = lib && lib.win.document;
    if (doc && doc.body) {
      attach(doc, lib.win);
      try { ensureButton(doc); } catch (e) { console.error('[Achievement Manager] could not add the button', e); }
    } else if (observedDoc) detach();
  };
  refreshLanguage().then(tick, tick);            // know Steam's language before the first look for the button
  // the library window can be closed and opened again, and Steam can redraw the page without a visible change
  poll = setInterval(tick, 1500);
  pinTimer = setInterval(quickPin, 250);
}

function dispose() {
  clearInterval(poll); clearInterval(pinTimer); clearTimeout(debounce);
  detach();
  try { if (urlHandle && typeof urlHandle.unregister === 'function') urlHandle.unregister(); } catch (e) { /* ignore */ }
  urlHandle = null;
}

/* ═════════════ steam:// link ═════════════ */

/* steam://achievementmanager/open/<appid> opens the manager for that game (like Extendium's steam://extendium/manager),
 * for when the button is missing. */
let lastUrl = '', lastUrlAt = 0, urlHandle = null;
function handleSteamUrl(_, url) {
  const now = Date.now();
  if (url === lastUrl && now - lastUrlAt < 800) return;   // Steam can deliver one link twice (or twice after a plugin reload)
  lastUrl = url; lastUrlAt = now;
  const parts = String(url || '').replace(/^steam:\/{1,2}/i, '/').split('/').filter(r => r).slice(1);
  const action = (parts[0] || '').toLowerCase();
  try {
    if (action === 'open' && /^\d+$/.test(parts[1] || '')) openWindow(parts[1], '');
    else console.warn('[Achievement Manager] unknown link:', url);
  } catch (e) { console.error('[Achievement Manager] could not handle the link', url, e); }
}
function registerSteamUrl() {
  try {
    const reg = window.SteamClient && window.SteamClient.URL && window.SteamClient.URL.RegisterForRunSteamURL;
    if (typeof reg === 'function') urlHandle = reg.call(window.SteamClient.URL, 'achievementmanager', handleSteamUrl);
    else console.warn('[Achievement Manager] SteamClient.URL.RegisterForRunSteamURL is not available; the steam:// links will not work');
  } catch (e) { console.error('[Achievement Manager] could not register the steam:// links', e); }
}

/* ═════════════ theming reference (shown in the plugin's settings) ═════════════ */

// every class name the window uses, for theme authors; the settings page and the CSS skeleton are made from this list
const CLASS_DOCS = [
  {
    "group": "Window",
    "blurb": "The popup itself and its background",
    "items": [
      {
        "selector": ".amw-root",
        "about": "The whole window. It is fixed and fills the popup. Steam's own Properties-window root class is on it too (_2sssIwe0duyIrFvat2oXzH)."
      },
      {
        "selector": ".amw-backdrop",
        "about": "A full-window layer under the window, painted with the colour of the dialog behind it. Restyle it if your theme draws the window background differently."
      },
      {
        "selector": ".amw-fallback",
        "about": "Added to .amw-root only when Steam's own styling of the classes below is missing (a Steam update renamed them). Not present normally."
      }
    ]
  },
  {
    "group": "Navigation column",
    "blurb": "The left column: game name and the filter entries",
    "items": [
      {
        "selector": ".amw-side",
        "about": "The navigation column. Also has .PageListColumn, .Panel and ._2kwFFHckg8jvnwJfg9-la8."
      },
      {
        "selector": ".amw-game",
        "about": "The game name at the top of the column. Also has ._2rjVTGz8aLvqOdz5v2gq5C."
      },
      {
        "selector": ".amw-nav",
        "about": "The list of entries. Also has ._18QCu-7MTzd51UpVbYysDy."
      },
      {
        "selector": ".amw-nav-item",
        "about": "One entry (All achievements, Unlocked, Locked, Changed). Also has ._1-vlriAtKYDViAEunue4VO and .Focusable."
      },
      {
        "selector": ".amw-nav-item.amw-on",
        "about": "The selected entry. Also has ._2DpXjzK3WWsOtUWUrcuOG7."
      },
      {
        "selector": ".amw-label",
        "about": "The entry's text. Also has ._2PPbMrzl8PKBwpkjYs9b0i."
      },
      {
        "selector": ".amw-count",
        "about": "The number on the right of an entry."
      },
      {
        "selector": ".amw-side-note",
        "about": "The small note at the bottom of the column."
      }
    ]
  },
  {
    "group": "Content panel",
    "blurb": "Title, progress bar, search, sort and the list",
    "items": [
      {
        "selector": ".amw-main",
        "about": "The content panel. Also has .DialogContent_InnerWidth."
      },
      {
        "selector": ".amw-head",
        "about": "The block with the title and the count."
      },
      {
        "selector": ".amw-title",
        "about": "The page title (All achievements, Unlocked, ...). Colour comes from the variable --amw-title (set from the theme's accent where there is one)."
      },
      {
        "selector": ".amw-sub",
        "about": "The line under the title (4 of 34 unlocked)."
      },
      {
        "selector": ".amw-bar",
        "about": "Wrapper of the progress bar (Steam's own ProgressBar inside)."
      },
      {
        "selector": ".amw-tools",
        "about": "The row with the search box and the sort dropdown."
      },
      {
        "selector": ".amw-search",
        "about": "Wrapper of the search box (Steam's TextField inside)."
      },
      {
        "selector": ".amw-sort",
        "about": "Wrapper of the sort dropdown (Steam's Dropdown inside)."
      },
      {
        "selector": ".amw-list",
        "about": "The scrolling list of achievements. Also has .DialogBody. Its bottom edge fades out with a mask."
      },
      {
        "selector": ".amw-empty",
        "about": "The message shown when no achievement matches."
      },
      {
        "selector": ".amw-more",
        "about": "The row with the Show N more button."
      }
    ]
  },
  {
    "group": "Achievement rows",
    "blurb": "One card per achievement, with state classes",
    "items": [
      {
        "selector": ".amw-row",
        "about": "One achievement (a card). Gets .amw-row-on or .amw-row-off, and .amw-row-changed while a change is staged."
      },
      {
        "selector": ".amw-row-on",
        "about": "The achievement is (or will be) unlocked."
      },
      {
        "selector": ".amw-row-off",
        "about": "The achievement is (or will be) locked."
      },
      {
        "selector": ".amw-row-changed",
        "about": "A change is staged for this achievement and not saved yet."
      },
      {
        "selector": ".amw-rowicon",
        "about": "The achievement icon (an img, 40 x 40). If an address fails the next one is tried."
      },
      {
        "selector": ".amw-rowicon-none",
        "about": "The plain tile shown (a div, also .amw-rowicon) when no icon address worked, instead of the browser's broken-image symbol."
      },
      {
        "selector": ".amw-rowtext",
        "about": "The block holding the title and the description."
      },
      {
        "selector": ".amw-rowtitle",
        "about": "The achievement name."
      },
      {
        "selector": ".amw-rowdesc",
        "about": "The description and the unlock date."
      },
      {
        "selector": ".amw-rowpct",
        "about": "The line under the description with the share of all players who have the achievement (Steam's public numbers). Left out when Steam has none for the game."
      },
      {
        "selector": ".amw-rowtoggle",
        "about": "Wrapper of the toggle (Steam's Toggle inside, which themes already style). Gets .amw-protected on a protected achievement."
      },
      {
        "selector": ".amw-protecticon",
        "about": "The not-allowed symbol next to the toggle of a protected achievement (the game sets it itself, so the toggle is disabled). Its tooltip reads \"This achievement is protected.\" It is drawn in the text colour."
      }
    ]
  },
  {
    "group": "Footer",
    "blurb": "The status line and the action buttons",
    "items": [
      {
        "selector": ".amw-foot",
        "about": "The bottom block (status line and buttons)."
      },
      {
        "selector": ".amw-status",
        "about": "The status line. Also .amw-ok (saved), .amw-bad (error) or .amw-warn (needs attention)."
      },
      {
        "selector": ".amw-actions",
        "about": "The grid with the buttons (Steam's DialogButton, so themes style them). Buttons: Reload (sometimes), Unlock shown, Lock shown, Revert, Apply."
      }
    ]
  },
  {
    "group": "Loading and error screens",
    "blurb": "What shows while loading or when something fails",
    "items": [
      {
        "selector": ".amw-center",
        "about": "The centred block of the loading and error screens."
      },
      {
        "selector": ".amw-msg",
        "about": "The error text."
      }
    ]
  },
  {
    "group": "Button on the game page",
    "blurb": "The button next to View My Achievements",
    "items": [
      {
        "selector": "[data-achievement-manager]",
        "about": "The Achievement Manager button next to View My Achievements. It is a copy of that button, so it already has the same classes and your theme's button style."
      },
      {
        "selector": "[data-amw-mode=\"left\"]",
        "about": "Placed to the left of View My Achievements."
      },
      {
        "selector": "[data-amw-mode=\"below\"]",
        "about": "Placed under it (when there is no room on the left)."
      },
      {
        "selector": "[data-amw-mode=\"inside\"]",
        "about": "Added at the end of the achievements section (when there is no usable View My Achievements button)."
      }
    ]
  },
  {
    "group": "Stats view",
    "blurb": "Windows and Linux; shown when the game has stats",
    "items": [
      {
        "selector": ".amw-navsep",
        "about": "The thin line under the Achievements / Stats switch in the navigation column."
      },
      {
        "selector": ".amw-statrow",
        "about": "One stat (a card, also .amw-row). Gets .amw-row-changed while an edit is staged."
      },
      {
        "selector": ".amw-statinput",
        "about": "The box on the right of a stat card that holds the number box."
      },
      {
        "selector": ".amw-spin",
        "about": "The number box: one bordered group with the value field and the minus and plus buttons. Also gets .amw-spin-off (locked) or .amw-spin-bad (value not acceptable). Its colours come from the text colour, so it follows any theme."
      },
      {
        "selector": ".amw-spinfield",
        "about": "The value field inside the number box. A plain input, not Steam's text field, so themes that decorate Steam's text fields do not touch it."
      },
      {
        "selector": ".amw-step",
        "about": "The minus and plus buttons of the number box (plain buttons)."
      },
      {
        "selector": ".amw-statwhy",
        "about": "The line under a stat that says why the typed value is not acceptable (also .amw-bad)."
      }
    ]
  },
  {
    "group": "Other designs: shared",
    "blurb": "Window design set to Showcase, Table or Split",
    "items": [
      {
        "selector": ".amw-alt",
        "about": "Added to .amw-root in every design except Classic, together with .amx-design-showcase, .amx-design-table or .amx-design-split. These designs have no navigation column."
      },
      {
        "selector": ".amx-wrap",
        "about": "The content of the window (padding and spacing). Also has .amx-showcase, .amx-table or .amx-splitwrap."
      },
      {
        "selector": ".amx-head",
        "about": "The top row with the game name (.amx-title), the progress line and the Achievements / Stats buttons."
      },
      {
        "selector": ".amx-btn",
        "about": "Every button of these designs (Steam's DialogButton, so themes style them). Gets .amx-on while it is the open view (Achievements / Stats). .amx-seg holds the two view buttons."
      },
      {
        "selector": ".amx-search",
        "about": "Wrapper of the search box (Steam's TextField inside, as in Classic). .amx-filter and .amx-sort wrap the two dropdowns."
      },
      {
        "selector": ".amx-foot",
        "about": "The bottom area: the status line (.amx-status, with the note about changes being applied to the account in .amx-statusnote) above the row of buttons (.amx-bar)."
      },
      {
        "selector": ".amx-check",
        "about": "A selection circle. Gets .amx-checked when selected."
      }
    ]
  },
  {
    "group": "Showcase design",
    "blurb": "A grid of tiles",
    "items": [
      {
        "selector": ".amx-grid",
        "about": "The scrolling grid of tiles (also has Steam's .DialogBody)."
      },
      {
        "selector": ".amx-tile",
        "about": "One achievement or stat. Gets .amx-on / .amx-off, .amx-changed while staged and .amx-protected for protected achievements."
      },
      {
        "selector": ".amx-rarity",
        "about": "The share-of-players line; .amx-rbar is the track and .amx-rfill the filled part."
      }
    ]
  },
  {
    "group": "Table design",
    "blurb": "Rows with columns and tick boxes",
    "items": [
      {
        "selector": ".amx-trow",
        "about": "One row of the table; the same class is used for the header row (.amx-hd). Gets .amx-changed while staged and .amx-sel while selected."
      },
      {
        "selector": ".amx-body",
        "about": "The scrolling rows (also has Steam's .DialogBody)."
      },
      {
        "selector": ".amx-bulk",
        "about": "The line with Unlock selected / Lock selected / Clear."
      }
    ]
  },
  {
    "group": "Split design",
    "blurb": "A list on the left, a detail pane on the right",
    "items": [
      {
        "selector": ".amx-splitlist",
        "about": "The left column with the filters, search, sort and the list of rows."
      },
      {
        "selector": ".amx-srow",
        "about": "One row of the list. Gets .amx-picked while shown in the pane and .amx-changed while a change is staged."
      },
      {
        "selector": ".amx-pane",
        "about": "The detail pane (also has Steam's .DialogBody). .amx-panehead holds the big icon and title, .amx-tier the rarity tier and .amx-panedesc the description."
      }
    ]
  },
  {
    "group": "Variables set on .amw-root",
    "blurb": "Custom properties a theme can override",
    "items": [
      {
        "selector": "--amw-title",
        "about": "Colour for .amw-title. Set from the theme's accent colour where the plugin knows one (Minimal Dark); otherwise white."
      },
      {
        "selector": "--amw-rowr",
        "about": "Corner radius of the achievement cards. Read from the theme's navigation entries, so cards match the theme's rounding."
      }
    ]
  }
];

function cssSkeleton() {
  const lines = ['/* Achievement Manager: all selectors, ready to fill in. Put the rules in your theme\'s CSS. */', ''];
  for (const g of CLASS_DOCS) {
    lines.push('/* ' + g.group + ' */');
    for (const it of g.items) {
      lines.push('/* ' + it.about + ' */');
      lines.push(it.selector.startsWith('--') ? '.amw-root { ' + it.selector + ': ; }' : it.selector + ' { }');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Copies text to the clipboard from the window that was clicked (a window without focus is refused): the clipboard API first,
// the old copy command second.
function copyText(text, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return Promise.reject(new Error('no document to copy from'));
  const view = d.defaultView || window;
  const viaApi = () => (view.navigator.clipboard && view.navigator.clipboard.writeText
    ? view.navigator.clipboard.writeText(text)
    : Promise.reject(new Error('no clipboard api')));
  const viaCommand = () => new Promise((resolve, reject) => {
    try {
      const box = d.createElement('textarea');
      box.value = text; box.setAttribute('readonly', '');
      box.style.position = 'fixed'; box.style.top = '0'; box.style.left = '0'; box.style.opacity = '0';
      d.body.appendChild(box); box.focus(); box.select();
      const ok = d.execCommand('copy');
      box.remove();
      ok ? resolve() : reject(new Error('copy refused'));
    } catch (e) { reject(e); }
  });
  let first;
  try { first = viaApi(); } catch (e) { first = Promise.reject(e); }
  return first.catch(() => viaCommand());
}

const SETTINGS_CSS = `
.amd-wrap{box-sizing:border-box;max-width:100%;overflow-x:hidden}
.amd-wrap .amd-sections{margin-top:18px;padding-top:2px}
.amd-wrap .amd-section{margin:0 0 10px;border:1px solid color-mix(in srgb, currentColor 14%, transparent);border-radius:6px;overflow:hidden;background:color-mix(in srgb, #fff 3%, transparent)}
.amd-wrap .amd-head{display:flex;align-items:center;gap:12px;margin:0;padding:12px 14px;cursor:pointer;user-select:none;transition:background .15s ease}
.amd-wrap .amd-head:hover{background:color-mix(in srgb, #fff 6%, transparent)}
.amd-wrap .amd-chev{flex:none;display:flex;transition:transform .2s ease}
.amd-wrap .amd-chev.amd-open{transform:rotate(90deg)}
.amd-wrap .amd-titles{flex:1 1 auto;min-width:0}
.amd-wrap .amd-name{font-size:15px;font-weight:600;line-height:20px}
.amd-wrap .amd-blurb{margin-top:1px;font-size:12px;font-weight:400;line-height:16px;color:rgba(255,255,255,.58)}
.amd-wrap .amd-pill{flex:none;font-size:11px;font-weight:600;line-height:16px;padding:1px 9px;border-radius:999px;background:color-mix(in srgb, currentColor 16%, transparent)}
.amd-wrap .amd-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s ease}
.amd-wrap .amd-collapse.amd-open{grid-template-rows:1fr}
.amd-wrap .amd-inner{overflow:hidden;min-height:0}
.amd-wrap .amd-item{display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-top:1px solid color-mix(in srgb, currentColor 10%, transparent)}
.amd-wrap .amd-text{flex:1 1 auto;min-width:0}
.amd-wrap .amd-sel{display:inline-block;max-width:100%;padding:2px 8px;border-radius:4px;background:color-mix(in srgb, currentColor 14%, transparent);color:#fff;font-family:Consolas,"Courier New",monospace;font-size:12.5px;line-height:18px;cursor:pointer;word-break:break-all}
.amd-wrap .amd-desc{margin-top:6px;font-size:12.5px;font-weight:400;line-height:1.45;color:rgba(255,255,255,.66)}
.amd-wrap .amd-copy{flex:none;align-self:center;padding:3px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.75);font-size:11px;line-height:16px;cursor:pointer;user-select:none;transition:background .15s ease,color .15s ease}
.amd-wrap .amd-copy:hover{background:rgba(255,255,255,.12);color:#fff}
.amd-wrap.amd-narrow .amd-item{flex-direction:column;gap:8px}
.amd-wrap.amd-narrow .amd-copy{align-self:flex-start}
.amd-wrap.amd-narrow .amd-head{padding:10px 12px}
.amd-wrap.amd-narrow .amd-item{padding:10px 12px}
`;

function SettingsPanel(props) {
  const [copied, setCopied] = React.useState('');
  // The settings pane can be narrow: below about 560 px the buttons go under the text and the rows stack.
  const wrapRef = React.useRef(null);
  const [narrow, setNarrow] = React.useState(!!(props && props.forceNarrow));
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) return undefined;
    const view = el.ownerDocument.defaultView;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < 560);
    measure();
    if (!view.ResizeObserver) return undefined;
    const watcher = new view.ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  const [open, setOpen] = React.useState({});          // group name -> expanded; every section starts collapsed
  const [manual, setManual] = React.useState('');      // text to copy by hand when the clipboard refuses
  const copy = (text, what, event) => {
    let doc;
    try { doc = event && event.currentTarget && event.currentTarget.ownerDocument; } catch (e) { doc = undefined; }
    copyText(text, doc).then(() => { setManual(''); setCopied(what); }, () => { setManual(text); setCopied(''); });
    setTimeout(() => setCopied(''), 2500);
  };
  const toggle = name => setOpen(prev => ({ ...prev, [name]: !prev[name] }));
  const setAll = value => setOpen(() => Object.fromEntries(CLASS_DOCS.map(g => [g.group, value])));
  const Btn = API.DialogButton || API.Button;
  const small = { flex: 'none', width: 'auto', whiteSpace: 'nowrap', padding: '0 14px' };
  const layout = narrow ? 'below' : 'inline';

  const [design, setDesign] = React.useState(readDesign);
  const chosen = DESIGNS.find(d => d[0] === design) || DESIGNS[0];
  const top = [
    h(API.Field, { key: 'design', childrenLayout: layout, label: 'Window design', description: chosen[2] + ' Applies the next time the window opens.' },
      h('div', { style: { minWidth: 200 } },
        h(API.Dropdown, { rgOptions: DESIGNS.map(d => ({ label: d[1], data: d[0] })), selectedOption: design, onChange: o => { writeDesign(o.data); setDesign(o.data); } }))),
    h(API.Field, { key: 'intro', label: 'Theming Achievement Manager',
      description: 'The window is built from the same parts as Steam\'s game Properties window, so a theme that styles that window styles this one too. To refine it, use the class names below. Click a selector to copy it.' }, null),
    h(API.Field, { key: 'copyall', childrenLayout: layout, label: 'CSS skeleton', description: 'Every selector below with an empty rule and a comment, ready to paste into your theme.' },
      h(Btn, { onClick: e => copy(cssSkeleton(), 'CSS skeleton copied', e), style: small }, 'Copy CSS')),
    h(API.Field, { key: 'tip', label: 'Tip', description: 'Scope your rules with .amw-root so they only affect this window. Open the window, then use Steam\'s DevTools to inspect it.' }, null),
    h(API.Field, { key: 'sections', childrenLayout: layout, label: 'Class names', description: 'Open a section to see its class names.' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        h(Btn, { onClick: () => setAll(true), style: small }, 'Expand all'),
        h(Btn, { onClick: () => setAll(false), style: small }, 'Collapse all'))),
  ];

  // Steam's own section classes (the ones its Properties window and Millennium's settings use), so the theme styles the heading:
  // DialogControlsSection holds a section, SettingsDialogSubHeader is its heading
  const sections = CLASS_DOCS.map(g => {
    const isOpen = !!open[g.group];
    return h('div', { key: 'g-' + g.group, className: 'DialogControlsSection amd-section' },
      h('div', { className: 'SettingsDialogSubHeader amd-head amw-doc-head', role: 'button', 'aria-expanded': isOpen, onClick: () => toggle(g.group) },
        h('span', { className: 'amd-chev' + (isOpen ? ' amd-open' : '') },
          h('svg', { viewBox: '0 0 16 16', width: 14, height: 14 },
            h('path', { d: 'M6 3l5 5-5 5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        h('div', { className: 'amd-titles' },
          h('div', { className: 'amd-name' }, g.group),
          g.blurb ? h('div', { className: 'amd-blurb' }, g.blurb) : null),
        h('span', { className: 'amd-pill' }, String(g.items.length))),
      h('div', { className: 'amd-collapse' + (isOpen ? ' amd-open' : ''), 'data-open': String(isOpen), 'aria-hidden': !isOpen },
        h('div', { className: 'amd-inner' },
          g.items.map(it => h('div', { key: it.selector, className: 'amd-item' },
            h('div', { className: 'amd-text' },
              h('span', { className: 'amd-sel', title: 'Click to copy', onClick: e => copy(it.selector, it.selector + ' copied', e) }, it.selector),
              h('div', { className: 'amd-desc' }, it.about)),
            h('span', { className: 'amd-copy', role: 'button', onClick: e => copy(it.selector, it.selector + ' copied', e) }, 'Copy'))))));
  });

  return h('div', { ref: wrapRef, className: 'amd-wrap' + (narrow ? ' amd-narrow' : ''), style: { paddingBottom: 24 } },
    h('style', null, SETTINGS_CSS),
    copied ? h('div', { style: { position: 'sticky', top: 0, zIndex: 2, padding: '6px 12px', background: 'rgba(0,0,0,.65)', color: '#8fcf5a', fontSize: 13 } }, copied) : null,
    manual ? h('div', { style: { margin: '8px 0 12px', padding: 12, background: 'rgba(0,0,0,.35)', borderRadius: 4 } },
      h('div', { style: { marginBottom: 8, fontSize: 13 } }, 'Steam did not allow copying automatically. The text is selected: press Ctrl+C to copy it.'),
      h('textarea', {
        readOnly: true, value: manual, rows: Math.min(10, manual.split('\n').length + 1),
        ref: el => { if (el) { el.focus(); el.select(); } },
        onFocus: e => e.target.select(),
        style: { width: '100%', boxSizing: 'border-box', fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, background: 'rgba(0,0,0,.4)', color: 'inherit', border: '1px solid rgba(255,255,255,.2)', padding: 8 },
      }),
      h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => setManual(''), style: small }, 'Close'))) : null,
    top, h('div', { className: 'amd-sections' }, sections));
}

async function main() {
  try { if (window.__achievementManager && window.__achievementManager.dispose) window.__achievementManager.dispose(); } catch (e) { /* ignore */ }
  window.__achievementManager = {
    dispose,
    open: (appId, name) => openWindow(appId, name || ''),
    // every class name the window uses (also in the plugin's settings): __achievementManager.classes()
    classes: () => CLASS_DOCS,
    // Steam's language and the buttons of the library page, for bug reports when the button does not show: __achievementManager.buttons()
    buttons: describeButtons,
    // a report for "why is this achievement not unlocking": copy((await __achievementManager.diagnose(appId, 'ACH_NAME')).join('\n'))
    diagnose,
    // what the window found in its own page (for bug reports): are Steam's Properties-window classes styled, and the theme accent
    look: () => { const el = document.querySelector('.amw-root'); return el ? { classes: el.className, fallback: el.classList.contains('amw-fallback') } : null; },
  };
  // the library window is built by Steam's UI, so wait until its services are up
  try {
    if (typeof App !== 'undefined' && App.WaitForServicesInitialized) await App.WaitForServicesInitialized();
    else await new Promise(r => setTimeout(r, 3000));
  } catch (e) { /* carry on */ }
  registerSteamUrl();
  start();
}


export default definePlugin(() => {
  main();
  return {
    title: 'Achievement Manager',
    icon: React.createElement('span', null),
    content: React.createElement(SettingsPanel),
  };
});
