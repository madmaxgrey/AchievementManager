// @ts-nocheck
/* Achievement Manager 1.11.2 — Starlight build. Steam's beta removed the tabs of the achievements window, so
 * the manager now opens from a button next to "View My Achievements" in its own Steam-styled window. */
import { definePlugin, Field } from 'millennium';

const React = (window as any).SP_REACT;
const API = (window as any).MILLENNIUM_API;

/* Steam's per-game stats schema: appcache/stats/UserGameStatsSchema_<appid>.bin
 *
 * A binary KeyValues file. The backend sends it over as a hex string (it cannot put raw
 * bytes in JSON); this turns it into achievement definitions: API name, title,
 * description, icon names, hidden flag. Same layout SteamAchievementManager reads.
 * Pure functions, no Steam or DOM access — scripts/test-schema.mjs exercises them.
 */

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
        };
      }
    }
  }
  return out;
}

/* icons in the schema are bare file names (often without an extension) */
function iconUrl(appId, icon) {
  if (!icon) return '';
  if (/^https?:/i.test(icon)) return icon;
  const file = /\.[a-z0-9]{2,4}$/i.test(icon) ? icon : icon + '.jpg';
  return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${file}`;
}

/* Achievement Manager — frontend (1.11.2).
 *
 * Steam's beta removed the tabs of the achievements window, so the manager now opens from its own button,
 * placed next to "View My Achievements" on a game's library page, and shows a window built to look like
 * Steam's own dialogs (the game's Properties window: a left navigation column, a content column, dialog
 * buttons at the bottom). Rows, toggles, the search box, the dropdown and the progress bar are Steam's own
 * controls; the layout around them is a small stylesheet.
 *
 * The button is made by copying the "View My Achievements" button (so it keeps Steam's own look) and
 * inserting the copy after it; a MutationObserver on the library window puts it back whenever Steam redraws
 * the page. The game is read from the React fiber of that button.
 */

const TITLE = 'Achievement Manager';
const h = React.createElement;

const FILTERS = [['All', 'All achievements'], ['Unlocked', 'Unlocked'], ['Locked', 'Locked'], ['Changed', 'Changed']];
const SORTS = ['Steam order', 'Name', 'Unlocked first', 'Locked first', 'Recently unlocked'];
const PAGE = 150;

/* ═════════════ backend calls ═════════════ */


async function callBackend(method, payload) {
  // the compiler turns literal `backend.<name>(...)` calls into calls to the Lua functions, so each is written out
  const arg = JSON.stringify(payload);
  const raw = method === 'am_apply' ? await backend.am_apply(arg) : await backend.am_status(arg);
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
  helper_source_missing: 'The plugin is missing resources/steam_achievement_helper.cs.',
  empty_output: 'The helper gave no answer (it may have timed out).',
  busy: 'Another request is still running. Try again in a moment.',
  store_stats_not_confirmed: 'Steam did not confirm that the changes were saved.',
  invalid_appid: 'This game has no usable app ID.',
};
const explain = res => ERRORS[res && res.error] || `Something went wrong (${(res && res.error) || 'unknown'}${res && res.detail ? ': ' + res.detail : ''}).`;


// Steam's logo, as a 24x24 SVG path (drawn in the loading screen)
const STEAM_LOGO = 'M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z';

function steamLanguageNow() {
  try { return window.LocalizationManager.m_rgLocalesToUse[0]; } catch (e) { /* not exposed */ }
  return (navigator && navigator.language) || 'english';
}

function rowsFrom(res, appId) {
  let defs = {};
  let broken = false;
  if (res.schema_found && res.schema_hex) {
    try {
      const tree = parseBinaryKV(hexToBytes(res.schema_hex));
      broken = !!tree.broken;
      defs = extractAchievements(tree, appId, steamLanguageNow());
    } catch (e) { console.warn('[Achievement Manager] schema unreadable', e); }
  }
  const rows = Object.keys(res.achievements || {}).map((name, order) => {
    const meta = defs[name];
    const state = res.achievements[name];
    const info = meta || {};
    return {
      name, order,
      known: !!meta,
      title: info.title || name,
      description: info.description || '',
      icon: iconUrl(appId, state.achieved ? info.icon : (info.iconGray || info.icon)),
      hidden: !!info.hidden,
      achieved: !!state.achieved,
      unlockTime: state.unlock_time || 0,
    };
  });
  const missing = rows.filter(r => !r.known).length;
  console.log(`[Achievement Manager] app ${appId}: schema ${res.schema_found ? (res.schema_bytes || '?') + ' bytes' + (broken ? ' (partly unreadable)' : '') : 'not found'}, ` +
    `${rows.length - missing} of ${rows.length} achievements described`);
  return { rows, missing, schemaFound: !!res.schema_found, broken };
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
.amw-root .amw-rowtext{flex:1 1 auto;min-width:0}
.amw-root .amw-rowtitle{font-size:14px;line-height:19px;font-weight:600;color:#fff;overflow-wrap:anywhere}
.amw-root .amw-rowdesc{margin-top:2px;font-size:12px;line-height:16px;font-weight:400;color:rgba(255,255,255,.62);white-space:normal;overflow-wrap:anywhere}
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
      const next = { fallback: bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent', title: accent, radius, backdropColor, backdropImage };
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
    setPhase('ready');
  }, [appId, ask]);

  React.useEffect(() => { load(); }, [load]);

  const has = name => Object.prototype.hasOwnProperty.call(edits, name);
  const wanted = row => (has(row.name) ? edits[row.name] : row.achieved);

  const setWanted = (row, value) => {
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
      for (const row of list) { if (value === row.achieved) delete next[row.name]; else next[row.name] = value; }
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

  /* ───── pieces ───── */

  // Steam's dialog buttons; a plain Button stands in on a Millennium that does not offer them
  const DButton = API.DialogButton || API.Button;
  const DPrimary = API.DialogButtonPrimary || API.DialogButton || API.Button;

  // Steam's own class names for the parts of its Properties window (see the comment at CSS); ours are added next to them
  const sideColumn = h('div', { className: 'amw-side PageListColumn Panel _2kwFFHckg8jvnwJfg9-la8' },
    h('div', { className: 'amw-game _2rjVTGz8aLvqOdz5v2gq5C' }, gameName || 'Achievements'),
    h('div', { className: 'amw-nav _18QCu-7MTzd51UpVbYysDy' },
      FILTERS.map(([key, label]) => {
        const count = key === 'All' ? rows.length
          : key === 'Unlocked' ? unlockedNow
          : key === 'Locked' ? rows.length - unlockedNow
          : changed;
        return h('div', {
          key, role: 'button',
          className: 'amw-nav-item _1-vlriAtKYDViAEunue4VO Focusable' + (filter === key ? ' amw-on _2DpXjzK3WWsOtUWUrcuOG7' : ''),
          onClick: () => { setFilter(key); setLimit(PAGE); },
        }, h('div', { className: 'amw-label _2PPbMrzl8PKBwpkjYs9b0i' }, label), phase === 'ready' ? h('div', { className: 'amw-count' }, String(count)) : null);
      })),
    h('div', { className: 'amw-side-note' }, 'Changes are written to your real Steam account.'));

  const frame = main => [
    h('div', { key: 'backdrop', className: 'amw-backdrop', style: { backgroundColor: look.backdropColor || undefined, backgroundImage: look.backdropImage || undefined } }),
    h('div', {
        key: 'root', ref: rootRef,
        className: 'amw-root _2sssIwe0duyIrFvat2oXzH' + (look.fallback ? ' amw-fallback' : ''),
        style: (look.title || look.radius) ? { '--amw-title': look.title || undefined, '--amw-rowr': look.radius || undefined } : undefined,
      },
      h('style', null, CSS), sideColumn, h('div', { className: 'amw-main DialogContent_InnerWidth' }, main)),
  ];

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

  const percent = rows.length ? Math.round((unlockedNow / rows.length) * 1000) / 10 : 0;
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
      row.icon ? h('img', { className: 'amw-rowicon', src: row.icon, alt: '', style: { opacity: now ? 1 : 0.55 } }) : null,
      h('div', { className: 'amw-rowtext' },
        h('div', { className: 'amw-rowtitle' }, row.title),
        lines.length ? h('div', { className: 'amw-rowdesc' }, lines.join('  ·  ')) : null),
      h('div', { className: 'amw-rowtoggle' }, h(API.Toggle, { value: now, onChange: v => setWanted(row, v) })));
  };

  // one line at the bottom: the question while confirming, otherwise the last result or the number of changes
  let status = { cls: '', text: changed ? `${changed} change${changed === 1 ? '' : 's'} not saved yet` : '' };
  if (confirming) status = { cls: 'amw-warn', text: `Unlock ${toUnlock.length}, lock ${toLock.length}? Press Confirm to save to your Steam account.` };
  else if (working) status = { cls: '', text: 'Saving to your Steam account...' };
  else if (notice) status = { cls: notice.ok ? 'amw-ok' : 'amw-bad', text: notice.text };
  else if (!changed && coverage.missing > 0) status = { cls: 'amw-warn', text: coverage.schemaFound ? `${coverage.missing} of ${rows.length} names and icons are missing; their ID is shown.` : 'Steam has not saved this game\'s achievement list yet, so IDs are shown. Reload in a moment.' };

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

/* The word for "achievement" in each of Steam's languages (stems, so plurals and cases match). Steam translates the button
 * ("View My Achievements"), so the English words cannot be relied on. Like the Easy Restart plugin, this goes by the language
 * Steam reports (SteamClient.Settings.GetCurrentLanguage) and looks the text up in a table per language. */
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

// "View My Achievements", in the language Steam shows; a hidden one is skipped, because a copy of it would be hidden too
// (some themes hide it and show the achievements somewhere else). Looked for in three steps: the English wording, then the
// words of Steam's current language, then the words of every language (in case the language could not be read).
function findAnchor(doc) {
  const buttons = shortButtons(doc);
  const english = buttons.find(b => b.folded.length < 40 && b.folded.startsWith('view') && b.folded.includes('achievement'));
  if (english) { noteTier('English wording'); return english.node; }
  const own = WORDS[steamUiLanguage] || [];
  if (own.length) {
    const hit = buttons.find(b => own.some(w => b.folded.includes(w)));
    if (hit) { noteTier('words of ' + steamUiLanguage); return hit.node; }
  }
  const any = buttons.find(b => ALL_WORDS.some(w => b.folded.includes(w)));
  if (any) { noteTier('words of another language'); return any.node; }
  return null;
}

// last resort when no wording matched (a language missing from the table): a button that sits inside an element whose class
// mentions achievements, on a page that is a game's (the game can be told from the button)
function findLooseAnchor(doc) {
  for (const b of shortButtons(doc)) {
    let area = false, el = b.node.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      if (/achievement/i.test(el.getAttribute('class') || '')) { area = true; break; }
    }
    if (!area) continue;
    let info = null;
    try { info = appFromElement(b.node); } catch (e) { info = null; }
    if (info) { noteTier('a button in the achievements area'); return b.node; }
  }
  return null;
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

// is the button cut off by a parent that clips its content, or outside the window?
function isClipped(btn) {
  try {
    const view = btn.ownerDocument.defaultView;
    const r = btn.getBoundingClientRect();
    if (r.left < 0) return true;
    for (let el = btn.parentElement; el && el !== btn.ownerDocument.body; el = el.parentElement) {
      if (/(hidden|auto|scroll|clip)/.test(view.getComputedStyle(el).overflowX) && r.left < el.getBoundingClientRect().left - 1) return true;
    }
  } catch (e) { /* cannot tell */ }
  return false;
}

// Where the copy goes. 'left': beside the original, to its left, whatever the page's layout is (row, column, pinned to a corner).
// 'below': under the original, full width of it, in the page's flow (themes that move the achievements into a narrow panel).
// 'inside': at the end of the achievements section (there is no usable button to sit beside).
function place(btn, anchor) {
  try {
    const mode = btn.getAttribute('data-amw-mode');
    if (mode === 'inside') return;
    if (mode === 'below') {
      btn.style.position = 'static'; btn.style.display = 'block'; btn.style.margin = '6px 0 0';
      btn.style.left = ''; btn.style.top = ''; btn.style.height = '';
      btn.style.width = anchor.offsetWidth ? anchor.offsetWidth + 'px' : '';
      return;
    }
    btn.style.position = 'absolute';
    btn.style.margin = '0';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    btn.style.left = Math.max(0, anchor.offsetLeft - btn.offsetWidth - 8) + 'px';
    btn.style.top = anchor.offsetTop + 'px';
    if (anchor.offsetHeight) btn.style.height = anchor.offsetHeight + 'px';
    if (isClipped(btn)) {                       // no room on the left: go under the original instead
      btn.setAttribute('data-amw-mode', 'below');
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      place(btn, anchor);
    }
  } catch (e) { /* layout not available */ }
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

  if (anchor && anchor.parentNode) {
    const prev = anchor.previousElementSibling, next = anchor.nextElementSibling;
    const mine = prev && prev.getAttribute(BTN_ATTR) ? prev : (next && next.getAttribute(BTN_ATTR) ? next : null);
    if (mine) { place(mine, anchor); return; }                                   // already there; keep it beside the original
    doc.querySelectorAll('[' + BTN_ATTR + ']').forEach(n => n.remove());         // a copy left from a page Steam has redrawn

    const below = false;

    const btn = anchor.cloneNode(false);                                          // same classes: the theme's own look for Steam's buttons
    btn.setAttribute(BTN_ATTR, '1');
    btn.setAttribute('data-amw-mode', below ? 'below' : 'left');
    btn.textContent = TITLE;
    btn.addEventListener('click', onButtonClick(btn, doc, anchor));
    anchor.parentNode.insertBefore(btn, below ? anchor.nextSibling : anchor);
    place(btn, anchor);
    const view = doc.defaultView;
    (view && view.requestAnimationFrame ? view.requestAnimationFrame.bind(view) : setTimeout)(() => place(btn, anchor));
    return;
  }

  // no usable button: a theme that hides it still shows the achievements section, so put our own button in that
  const section = findSection(doc);
  if (!section) return;
  if (section.querySelector('[' + BTN_ATTR + ']')) return;
  doc.querySelectorAll('[' + BTN_ATTR + ']').forEach(n => n.remove());
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
}

function dispose() {
  clearInterval(poll); clearTimeout(debounce);
  detach();
  try { if (urlHandle && typeof urlHandle.unregister === 'function') urlHandle.unregister(); } catch (e) { /* ignore */ }
  urlHandle = null;
}

/* ═════════════ steam:// link ═════════════ */

/* A Steam link of the plugin, like Extendium's steam://extendium/manager (it works in a browser's address bar and in Win + R):
 *   steam://achievementmanager/open/<appid>   the manager for that game, for when the button is missing */
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
        "about": "The achievement icon (an img, 40 x 40)."
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
        "selector": ".amw-rowtoggle",
        "about": "Wrapper of the toggle (Steam's Toggle inside, which themes already style)."
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

// Copy text to the clipboard. It runs in the window that was clicked (that is the one with the focus; the clipboard is refused
// to a window that does not have it), tries the clipboard API first and the older copy command second.
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
  // The settings pane can be narrow (a small window, no theme). Below ~560px the buttons go under the text and the rows stack.
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

  const top = [
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
