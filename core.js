// core.js — shared daily-guessing logic (city list, distances, daily schedule, stats, sharing).
// Nothing in here knows about skylines, so a second game mode can reuse it.

// ---------- text matching ----------
export function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents: São -> Sao
          .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- city list ----------
export async function loadCities(url = 'cities.json') {
  const list = await (await fetch(url)).json();
  list.forEach((c, i) => {
    c.id = `${c.name}, ${c.country}`;
    c.rank = i;                                   // list is sorted biggest-first
    c.keys = [c.name, ...(c.aliases || [])].map(normalize);
  });
  return list;
}

export function findCity(cities, name, country) {
  const n = normalize(name);
  return cities.find((c) => c.keys.includes(n) && (!country || normalize(c.country) === normalize(country)));
}

export function searchCities(cities, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const starts = [], contains = [];
  for (const c of cities) {
    if (c.keys.some((k) => k.startsWith(q))) starts.push(c);
    else if (c.keys.some((k) => k.includes(q)) || normalize(c.country).startsWith(q)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

// ---------- geography ----------
const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearingArrow(from, to) {
  const y = Math.sin(rad(to.lon - from.lon)) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
            Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lon - from.lon));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️'][Math.round(deg / 45) % 8];
}
export function distanceSquare(km) {
  return km === 0 ? '🟩' : km < 500 ? '🟨' : km < 2000 ? '🟧' : '🟥';
}
export const fmtKm = (km) => `${Math.round(km).toLocaleString()} km · ${Math.round(km * 0.621371).toLocaleString()} mi`;

// ---------- daily schedule ----------
function localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function puzzleNumber(startISO, now = new Date()) {
  const [y, m, d] = startISO.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const days = Math.round((localMidnight(now) - start) / 86400000);
  return Math.max(0, days);
}
export function msUntilTomorrow(now = new Date()) {
  const t = localMidnight(now); t.setDate(t.getDate() + 1);
  return t - now;
}

// ---------- saved progress + stats (browser storage) ----------
function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function safeSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }

export function makeStore(mode) {
  const statsKey = `${mode}:stats`;
  const emptyStats = { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0], lastWon: null };
  return {
    loadGame: (n) => safeGet(`${mode}:game:${n}`, { guesses: [], done: false, won: false }),
    saveGame: (n, g) => safeSet(`${mode}:game:${n}`, g),
    stats: () => ({ ...emptyStats, ...safeGet(statsKey, {}) }),
    recordResult(n, won, tries) {
      const s = this.stats();
      s.played++;
      if (won) {
        s.wins++;
        s.dist[tries - 1]++;
        s.streak = s.lastWon === n - 1 ? s.streak + 1 : 1;
        s.maxStreak = Math.max(s.maxStreak, s.streak);
        s.lastWon = n;
      } else {
        s.streak = 0;
      }
      safeSet(statsKey, s);
      return s;
    },
    seenHelp: () => safeGet(`${mode}:seenHelp`, false),
    markHelpSeen: () => safeSet(`${mode}:seenHelp`, true),
  };
}

// ---------- sharing ----------
export async function share(text) {
  try {
    if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) {
      await navigator.share({ text });
      return 'shared';
    }
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// ---------- small UI helpers ----------
export function toast(msg, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// autocomplete box: calls onPick(city) when the player chooses a suggestion
export function attachAutocomplete(input, list, cities, onPick) {
  let items = [], active = 0;
  const render = () => {
    list.innerHTML = '';
    items.forEach((c, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${c.name}</b> <span>${c.country}</span>`;
      if (i === active) li.className = 'active';
      li.onmousedown = (e) => { e.preventDefault(); pick(i); };
      list.appendChild(li);
    });
    list.hidden = items.length === 0;
  };
  const pick = (i) => {
    const c = items[i];
    if (!c) return;
    input.value = '';
    items = [];
    render();
    onPick(c);
  };
  input.addEventListener('input', () => { items = searchCities(cities, input.value); active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (items.length) pick(active);
      else if (input.value.trim()) toast('Pick a city from the list');
      e.preventDefault();
    } else if (e.key === 'Escape') { items = []; render(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { items = []; render(); }, 100));
}
