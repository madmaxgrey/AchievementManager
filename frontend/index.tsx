// @ts-nocheck
/* Achievement Manager 1.10 — Starlight build. The logic is the same as 1.0.9 (schema.js + index.js joined);
 * only the entry point and the backend call changed. */
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
  bg: 'bulgarian', el: 'greek', uk: 'ukrainian', vi: 'vietnamese',
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

/* Achievement Manager — frontend.
 *
 * Adds an "Achievement Manager" tab to the achievements window of a game's library page
 * (the one with My Achievements / Global Achievements). The tab is made only of Steam's own
 * controls (Field, ButtonItem, Toggle, Dropdown, TextField, ProgressBar) — no custom
 * windows or dialogs. The tab is added the way the Achievement Groups plugin adds its own:
 * the React JSX runtime is patched, and when the tab container is created a tab is appended.
 * (That technique is modelled on Achievement Groups, MIT, BossSloth — see LICENSE.)
 *
 * schema.js (parsing Steam's stats schema) is concatenated in front of this file by build.mjs.
 *   API  window.MILLENNIUM_API      React  window.SP_REACT
 */

const TAB_ID = 'achievement-manager';
const TAB_TITLE = 'Achievement Manager';
const h = React.createElement;

// Every action is a ButtonItem: Steam's own clickable settings row. (A Field with a button stands in on a
// Millennium that does not offer it.) Whether a ButtonItem wires a mouse click to its whole row or only to a
// button inside it differs between builds, so the click is also caught on a wrapper around the row. The row and
// the wrapper can then both report the same click; the guard lets it count once (Apply must not skip its
// confirmation step because one click was seen twice).
function action(props) {
  const { key, onClick, disabled } = props;
  let last = 0;
  const fire = event => {
    if (disabled) return;
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    if (onClick) onClick(event);
  };
  const row = API.ButtonItem
    ? h(API.ButtonItem, { ...props, key: undefined, onClick: fire })
    : h(API.Field, { label: props.label, description: props.description },
      h(API.Button, { onClick: fire, disabled }, 'Run'));
  return h('div', { key, onClick: fire, style: { cursor: disabled ? 'default' : 'pointer' } }, row);
}

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

/* ═════════════ the tab ═════════════ */

const FILTERS = ['All', 'Unlocked', 'Locked', 'Changed'];
const SORTS = ['Steam order', 'Name', 'Unlocked first', 'Locked first', 'Recently unlocked'];
const PAGE = 150;

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

function ManagerTab({ appId }) {
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

  const wanted = row => (Object.prototype.hasOwnProperty.call(edits, row.name) ? edits[row.name] : row.achieved);

  const setWanted = (row, value) => {
    setConfirming(false);
    setNotice(null);
    setEdits(prev => {
      const next = { ...prev };
      if (value === row.achieved) delete next[row.name]; else next[row.name] = value;
      return next;
    });
  };

  const changeMany = (list, value) => {
    setConfirming(false);
    setNotice(null);
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
    list = list.slice().sort(by);
    return list;
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
      setNotice({ ok: true, text: `Saved: ${res.unlocked_count || 0} unlocked, ${res.locked_count || 0} locked. Reopen the achievements window if the other tabs still show the old state.` });
      await load();
    } else {
      setNotice({ ok: false, text: explain(res) });
    }
  };

  /* ───── render ───── */

  if (phase === 'loading') {
    // the same loader Steam shows when it waits on something: its logo, a ring turning around it, a line of text.
    // The turning arc takes Millennium's accent colour (--SystemAccentColor), white when none is set.
    return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, padding: '56px 0 40px' } },
      h('style', null, '@keyframes am-ring{to{transform:rotate(360deg)}}'),
      h('div', { style: { position: 'relative', width: 96, height: 96 } },
        h('svg', { viewBox: '0 0 96 96', width: 96, height: 96, style: { position: 'absolute', left: 0, top: 0, animation: 'am-ring 1.1s linear infinite' } },
          h('circle', { cx: 48, cy: 48, r: 46, fill: 'none', stroke: 'rgba(255,255,255,0.12)', strokeWidth: 2 }),
          h('circle', { cx: 48, cy: 48, r: 46, fill: 'none', stroke: '#ffffff', strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '72 217',
            style: { stroke: 'var(--SystemAccentColor, #ffffff)' } })),
        h('svg', { viewBox: '0 0 24 24', width: 68, height: 68, fill: '#ffffff', style: { position: 'absolute', left: 14, top: 14 } },
          h('path', { d: STEAM_LOGO }))),
      h('div', { style: { fontSize: 18, opacity: 0.85 } }, 'Loading Achievements...'));
  }
  if (phase === 'error') {
    return h('div', { style: { padding: '0 8px 24px' } },
      h(API.Field, { label: TAB_TITLE, description: problem, bottomSeparator: 'none' }),
      action({ label: 'Try again', onClick: load }));
  }

  const percent = rows.length ? Math.round((unlockedNow / rows.length) * 1000) / 10 : 0;
  const shown = visible.slice(0, limit);
  const fmtDate = t => (t ? new Date(t * 1000).toLocaleString() : '');

  const rowEl = row => {
    const now = wanted(row);
    const isChanged = Object.prototype.hasOwnProperty.call(edits, row.name);
    const lines = [];
    if (row.description) lines.push(row.description);
    else if (row.hidden) lines.push('Hidden achievement');
    if (row.achieved && row.unlockTime) lines.push('Unlocked ' + fmtDate(row.unlockTime));
    if (isChanged) lines.push(now ? 'Will be unlocked' : 'Will be locked');
    return h(API.Field, {
      key: row.name,
      label: row.title,
      description: lines.join('  ·  '),
      icon: row.icon ? h('img', { src: row.icon, width: 40, height: 40, style: { borderRadius: 2, opacity: now ? 1 : 0.55 }, alt: '' }) : undefined,
    }, h(API.Toggle, { value: now, onChange: v => setWanted(row, v) }));
  };

  return h('div', { style: { padding: '0 8px 24px' } },
    h(API.Field, {
      label: `${unlockedNow} of ${rows.length} achievements unlocked`,
      description: 'Switch achievements on or off, then press Apply. Changes are written to your real Steam account.',
    }, h('span', null, `${percent}%`)),
    h(API.ProgressBar, { nProgress: percent }),

    h(API.Focusable, { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '16px 0 8px' } },
      h('div', { style: { flex: '1 1 220px' } },
        h(API.TextField, { value: search, placeholder: 'Search achievements...', onChange: e => { setSearch(e.target.value); setLimit(PAGE); } })),
      h('div', { style: { minWidth: 120 } },
        h(API.Dropdown, { rgOptions: FILTERS.map(f => ({ label: f, data: f })), selectedOption: filter, onChange: o => { setFilter(o.data); setLimit(PAGE); }, contextMenuPositionOptions: { bMatchWidth: false } })),
      h('div', { style: { minWidth: 160 } },
        h(API.Dropdown, { rgOptions: SORTS.map(s => ({ label: s, data: s })), selectedOption: sort, onChange: o => setSort(o.data), contextMenuPositionOptions: { bMatchWidth: false } }))),

    h(API.Focusable, { style: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 8px' } },
      h('div', { key: 'unlock', style: { flex: '1 1 120px' } },
        action({ label: 'Unlock shown', onClick: () => changeMany(visible, true), disabled: working, bottomSeparator: 'none' })),
      h('div', { key: 'lock', style: { flex: '1 1 120px' } },
        action({ label: 'Lock shown', onClick: () => changeMany(visible, false), disabled: working, bottomSeparator: 'none' })),
      h('div', { key: 'revert', style: { flex: '1 1 120px' } },
        action({ label: 'Revert', onClick: () => { setEdits({}); setConfirming(false); setNotice(null); }, disabled: working || changed === 0, bottomSeparator: 'none' })),
      h('div', { key: 'apply', style: { flex: '1 1 120px' } },
        action({
          label: working ? 'Applying...' : confirming ? (toLock.length === 0 ? `Confirm: unlock ${toUnlock.length}` : toUnlock.length === 0 ? `Confirm: lock ${toLock.length}` : `Confirm: +${toUnlock.length} / \u2212${toLock.length}`) : `Apply${changed ? ` (${changed})` : ''}`,
          onClick: apply,
          disabled: working || changed === 0,
          bottomSeparator: 'none',
        }))),

    coverage.missing > 0
      ? h(API.Field, {
          label: 'Some names and icons are missing',
          description: coverage.schemaFound
            ? `Steam's schema for this game has no entry for ${coverage.missing} of ${rows.length} achievements${coverage.broken ? ' (the file was only partly readable)' : ''}, so their ID is shown instead. Toggling still works.`
            : 'Steam has not saved this game\'s achievement list yet, so names and icons cannot be shown and the achievement IDs are listed instead. Toggling still works; reload in a moment to try again.',
        })
      : null,
    coverage.missing > 0
      ? action({ label: 'Reload', onClick: () => { retried.current = false; load(); }, disabled: working })
      : null,

    notice ? h(API.Field, { label: notice.ok ? 'Done' : 'Could not apply', description: notice.text }) : null,

    shown.length === 0
      ? h(API.Field, { label: 'Nothing to show', description: rows.length ? 'No achievement matches the search and filter.' : 'Steam reports no achievements for this game.' })
      : shown.map(rowEl),

    visible.length > shown.length
      ? action({ label: `Show ${visible.length - shown.length} more`, description: 'Long lists are shown in pages.', onClick: () => setLimit(l => l + PAGE) })
      : null);
}

/* ═════════════ adding the tab ═════════════ */

const isAchievementTabs = props => !!props && Array.isArray(props.tabs) && typeof props.onShowTab === 'function' &&
  props.autoFocusContents !== undefined && props.tabs.some(t => t && t.id === 'achievements');

function addTab(args) {
  const props = args[1];
  if (!isAchievementTabs(props)) return;
  const tabs = props.tabs;
  if (tabs.some(t => t && t.id === TAB_ID)) return;
  const first = tabs[0];
  const appId = first && first.content && first.content.props ? first.content.props.appid : undefined;
  if (appId === undefined || appId === null) return;
  tabs.push({ content: h(ManagerTab, { key: `${TAB_ID}-${appId}`, appId: String(appId) }), id: TAB_ID, title: TAB_TITLE });
}

const patches = new Map();   // 'jsx' | 'jsxs' -> { patch, original }
let watchdog = 0;

function installPatches() {
  const runtime = API.findModuleByExport((value, name) => (name === 'jsx' || name === 'jsxs') && typeof value === 'function');
  if (!runtime || typeof runtime.jsx !== 'function' || typeof runtime.jsxs !== 'function') {
    console.error('[Achievement Manager] could not find the React jsx runtime');
    return;
  }
  const patch = name => {
    const entry = patches.get(name) || { patch: undefined, last: undefined };
    entry.last = runtime[name];
    entry.patch = API.beforePatch(runtime, name, args => {
      try { addTab(args); } catch (e) { console.error('[Achievement Manager] could not add the tab', e); }
    });
    patches.set(name, entry);
  };
  patch('jsx');
  patch('jsxs');
  // another plugin (or a Steam update) can swap the function back; patch again when that happens
  watchdog = setInterval(() => {
    for (const name of ['jsx', 'jsxs']) {
      const entry = patches.get(name);
      if (entry && entry.patch !== undefined && runtime[name] !== entry.last) continue;
      patch(name);
    }
  }, 1000);
}

function dispose() {
  clearInterval(watchdog);
  for (const entry of patches.values()) { try { entry.patch && entry.patch.unpatch && entry.patch.unpatch(); } catch (e) { /* ignore */ } }
  patches.clear();
}

async function main() {
  try { if (window.__achievementManager && window.__achievementManager.dispose) window.__achievementManager.dispose(); } catch (e) { /* ignore */ }
  window.__achievementManager = { dispose };
  // the tab container is built by Steam's UI, so wait until its services are up
  try {
    if (typeof App !== 'undefined' && App.WaitForServicesInitialized) await App.WaitForServicesInitialized();
    else await new Promise(r => setTimeout(r, 3000));
  } catch (e) { /* carry on */ }
  installPatches();
}


export default definePlugin(() => {
  main();
  return {
    title: 'Achievement Manager',
    icon: React.createElement('span', null),
    content: React.createElement(Field, { label: 'Achievement Manager', description: 'Adds an Achievement Manager tab to a game\'s achievements window in the library.' }),
  };
});
