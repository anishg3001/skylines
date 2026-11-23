// skyline.js — the "guess the city from its skyline" daily game.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadCities, findCity, distanceKm, bearingArrow, distanceSquare, fmtKm,
  puzzleNumber, msUntilTomorrow, makeStore, share, toast, attachAutocomplete,
} from './core.js';

const MAX_GUESSES = 6;
const $ = (id) => document.getElementById(id);
const store = makeStore('skyline');
const params = new URLSearchParams(location.search);

// ======================================================================= 3D view
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xcfe0f1);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 5000, 20000);
const camera = new THREE.PerspectiveCamera(50, 1, 2, 100000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = true;
controls.screenSpacePanning = false;   // pan slides along the ground, like walking around the city
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.03;

scene.add(new THREE.HemisphereLight(0xffffff, 0x6d7a63, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(60000, 64), new THREE.MeshStandardMaterial({ color: 0x8a9a7b }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const buildingMat = new THREE.MeshStandardMaterial({ color: 0xe4e1da, flatShading: true, side: THREE.DoubleSide });

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);   // CSS controls the size; this only sets the drawing resolution
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

let geo = null;   // { C: city center, T: tallest point, H: tallest height, R: radius }
async function loadSkyline(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const box = new THREE.Box3();
  let T = new THREE.Vector3(0, -1, 0);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.material = buildingMat;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > T.y) T.set(p.getX(i), p.getY(i), p.getZ(i));
  });
  box.setFromObject(gltf.scene);
  scene.add(gltf.scene);
  const C = box.getCenter(new THREE.Vector3()); C.y = 0;
  const size = box.getSize(new THREE.Vector3());
  geo = { C, T, H: Math.max(T.y, 60), R: Math.max(size.x, size.z) / 2 };
  const far = geo.R + geo.H * 3;
  scene.fog.near = far * 1.6;
  scene.fog.far = far * 6;
}

// Camera for each clue. heading = compass direction the camera sits in, seen from the city
function shot(stage, heading) {
  const { C, T, H, R } = geo;
  const off = (deg) => { const r = (deg * Math.PI) / 180; return new THREE.Vector3(Math.sin(r), 0, -Math.cos(r)); };
  const at = (base, deg, dist, y) => base.clone().addScaledVector(off(deg), dist).setY(y);
  const Tg = new THREE.Vector3(T.x, 0, T.z);
  switch (stage) {
    case 0: return { fov: 55, target: Tg.clone().setY(H * 0.55), pos: at(Tg, heading, H * 0.9, 25) };          // close-up, looking up
    case 1: return { fov: 45, target: Tg.clone().setY(H * 0.4), pos: at(Tg, heading, H * 2.2, H * 0.25) };     // the tallest tower and neighbours
    case 2: return { fov: 28, target: C.clone().setY(H * 0.35), pos: at(C, heading, R + H * 2.2, H * 0.3) };   // full skyline (zoom lens)
    case 3: return { fov: 28, target: C.clone().setY(H * 0.35), pos: at(C, heading + 150, R + H * 2.2, H * 0.3) }; // other side
    default: { const d = R * 1.2 + H; return { fov: 45, target: C.clone(), pos: at(C, heading + 30, d, d * 0.9) }; } // aerial
  }
}

// ---------- keyboard movement: WASD / arrow keys (Shift = faster) ----------
const keys = new Set();
const MOVE_KEYS = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r' };
const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';
addEventListener('keydown', (e) => {
  const k = MOVE_KEYS[e.key.toLowerCase()];
  if (!k || typing() || document.querySelector('dialog[open]')) return;
  keys.add(k);
  keys.fast = e.shiftKey;
  e.preventDefault();                      // stop arrow keys from scrolling the page
});
addEventListener('keyup', (e) => { const k = MOVE_KEYS[e.key.toLowerCase()]; if (k) keys.delete(k); keys.fast = e.shiftKey; });
addEventListener('blur', () => keys.clear());
// clicking the map takes focus away from the guess box, so the keys move the camera
view.addEventListener('pointerdown', () => { if (typing()) document.activeElement.blur(); });

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
function keyboardMove(dt) {
  if (!keys.size) return;
  camera.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
  _right.crossVectors(_fwd, camera.up).normalize();
  _move.set(0, 0, 0);
  if (keys.has('f')) _move.add(_fwd);
  if (keys.has('b')) _move.sub(_fwd);
  if (keys.has('r')) _move.add(_right);
  if (keys.has('l')) _move.sub(_right);
  if (!_move.lengthSq()) return;
  tween = null;                            // stop any camera fly-in
  const speed = Math.max(60, camera.position.distanceTo(controls.target)) * (keys.fast ? 2.5 : 0.9);
  _move.normalize().multiplyScalar(speed * dt);
  camera.position.add(_move);
  controls.target.add(_move);
}

let tween = null;
function flyTo(stage, heading, free = false, instant = false) {
  const s = shot(stage, heading);
  const dist = s.pos.distanceTo(s.target);
  // free movement at every clue; the clues just move you to a new starting viewpoint
  controls.minDistance = 20;
  controls.maxDistance = geo.R * 3 + geo.H * 4;
  if (instant) {
    camera.position.copy(s.pos); controls.target.copy(s.target);
    camera.fov = s.fov; camera.updateProjectionMatrix(); controls.update(); return;
  }
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: s.pos, t1: s.target,
            f0: camera.fov, f1: s.fov, start: performance.now() };
}

let lastFrame = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  keyboardMove(dt);
  if (tween) {
    const k = Math.min((now - tween.start) / 1100, 1), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    camera.fov = tween.f0 + (tween.f1 - tween.f0) * e;
    camera.updateProjectionMatrix();
    if (k === 1) tween = null;
  }
  // keep the view near the city so nobody gets lost in empty fields
  if (geo) {
    const lim = geo.R * 1.5 + 200, t = controls.target;
    const dx = t.x - geo.C.x, dz = t.z - geo.C.z, d = Math.hypot(dx, dz);
    if (d > lim) { t.x = geo.C.x + (dx / d) * lim; t.z = geo.C.z + (dz / d) * lim; }
    t.y = Math.max(0, t.y);
  }
  controls.update();
  renderer.render(scene, camera);
});

// ======================================================================= game
const [cities, schedule] = await Promise.all([loadCities('cities.json'), (await fetch('puzzles.json')).json()]);
let n = params.has('day') ? Number(params.get('day')) - 1 : puzzleNumber(schedule.start);
const puzzle = schedule.puzzles[n % schedule.puzzles.length];
const answer = findCity(cities, puzzle.answer, puzzle.country);
if (!answer) throw new Error(`Answer "${puzzle.answer}, ${puzzle.country}" is not in cities.json`);
const heading = puzzle.heading ?? 200;
$('number').textContent = `#${n + 1}`;

if (params.has('reset')) { localStorage.removeItem(`skyline:game:${n}`); }
const game = store.loadGame(n);

resize();
try {
  await loadSkyline(puzzle.glb);
} catch (err) {
  $('loading').textContent = `Couldn't load ${puzzle.glb}`;
  throw err;
}
$('loading').remove();

function stage() { return Math.min(game.guesses.length, MAX_GUESSES - 1); }

function renderGuesses() {
  const ul = $('guesses');
  ul.innerHTML = '';
  for (let i = 0; i < MAX_GUESSES; i++) {
    const li = document.createElement('li');
    const id = game.guesses[i];
    if (id) {
      const c = cities.find((x) => x.id === id);
      const km = c === answer ? 0 : distanceKm(c, answer);
      li.className = km === 0 ? 'right' : 'wrong';
      li.innerHTML = km === 0
        ? `<span class="sq">🟩</span><b>${c.name}</b><span class="meta">${c.country}</span><span class="dist">Correct!</span>`
        : `<span class="sq">${distanceSquare(km)}</span><b>${c.name}</b><span class="meta">${c.country}</span>` +
          `<span class="dist">${fmtKm(km)} ${bearingArrow(c, answer)}</span>`;
    } else {
      li.className = 'empty';
      li.textContent = i === game.guesses.length && !game.done ? 'Your guess…' : '';
    }
    ul.appendChild(li);
  }
  const s = stage();
  $('clue').textContent = game.done ? 'Explore freely' : `Clue ${s + 1} of ${MAX_GUESSES}`;
  const hints = [];
  if (s >= 4 || game.done) hints.push(`🌎 ${puzzle.continent || '?'}`);
  if (s >= 5 || game.done) hints.push(`🏳️ ${answer.country}`);
  $('hints').innerHTML = hints.map((h) => `<span>${h}</span>`).join('');
  $('entry').hidden = game.done;
}

function shareText() {
  const squares = game.guesses.map((id) => {
    const c = cities.find((x) => x.id === id);
    return distanceSquare(c === answer ? 0 : distanceKm(c, answer));
  });
  const score = game.won ? game.guesses.length : 'X';
  return `🏙️ Skyline #${n + 1} ${score}/${MAX_GUESSES}\n${squares.join('')}\n${location.origin}${location.pathname}`;
}

function showResult() {
  const s = store.stats();
  $('result-title').textContent = game.won ? (game.guesses.length === 1 ? 'Incredible! 🏆' : 'You got it! 🎉') : 'So close next time';
  $('result-city').textContent = `${answer.name}, ${answer.country}`;
  $('st-played').textContent = s.played;
  $('st-win').textContent = s.played ? Math.round((100 * s.wins) / s.played) : 0;
  $('st-streak').textContent = s.streak;
  $('st-max').textContent = s.maxStreak;
  const max = Math.max(1, ...s.dist);
  $('dist').innerHTML = s.dist.map((v, i) => {
    const mine = game.won && game.guesses.length === i + 1 ? ' mine' : '';
    return `<div class="row"><span>${i + 1}</span><div class="bar${mine}" style="width:${8 + (92 * v) / max}%">${v}</div></div>`;
  }).join('');
  $('result-actions').hidden = !game.done;
  $('result').showModal();
}

function finish() {
  game.done = true;
  store.saveGame(n, game);
  store.recordResult(n, game.won, game.guesses.length);
  renderGuesses();
  flyTo(4, heading, true);
  setTimeout(showResult, 1400);
}

function guess(city) {
  if (game.done) return;
  if (game.guesses.includes(city.id)) { toast('Already guessed'); return; }
  game.guesses.push(city.id);
  if (city === answer) game.won = true;
  store.saveGame(n, game);
  if (game.won || game.guesses.length >= MAX_GUESSES) { finish(); return; }
  renderGuesses();
  flyTo(stage(), heading);
  const km = distanceKm(city, answer);
  toast(km < 500 ? 'Very close! 🔥' : km < 2000 ? 'Getting warmer' : 'Not quite…');
}

attachAutocomplete($('guess'), $('suggest'), cities, guess);

// countdown to the next puzzle
setInterval(() => {
  const ms = msUntilTomorrow();
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1000);
  $('countdown').textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}, 1000);

$('share').onclick = async () => {
  const r = await share(shareText());
  toast(r === 'copied' ? 'Result copied — paste it anywhere!' : r === 'shared' ? 'Shared!' : "Couldn't copy, sorry");
};
$('btn-stats').onclick = showResult;
$('btn-help').onclick = () => $('help').showModal();
document.querySelectorAll('dialog .close').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
$('help').addEventListener('close', () => store.markHelpSeen());

// start
renderGuesses();
if (game.done) { flyTo(4, heading, true, true); setTimeout(showResult, 400); }
else {
  flyTo(stage(), heading, false, true);
  if (!store.seenHelp()) $('help').showModal();
}
