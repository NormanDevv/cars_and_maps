import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const COUNTRY_SIZE = 100; // ancho/alto máximo del país en unidades de escena
const DEPARTMENT_SIZE = 80; // ancho/alto máximo de un departamento ampliado
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;

const $ = (id) => document.getElementById(id);
const ui = {
	scene: $('scene'),
	panel: $('panel'),
	panelToggle: $('panel-toggle'),
	crumbHome: $('crumb-home'),
	crumbSep: $('crumb-sep'),
	crumbDep: $('crumb-dep'),
	summary: $('summary'),
	search: $('search'),
	list: $('list'),
	toggleLabels: $('toggle-labels'),
	back: $('back'),
	tooltip: $('tooltip'),
	loading: $('loading'),
};

const numberFmt = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Geometría: proyección, áreas y puntos para etiquetas
// ---------------------------------------------------------------------------

function boundsOf(polygonLists) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const polygons of polygonLists) {
		for (const rings of polygons) {
			for (const [x, y] of rings[0]) {
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
		}
	}
	return { minX, minY, maxX, maxY };
}

// Proyección equirectangular local centrada en el área visible y escalada
// para que la dimensión mayor ocupe `size` unidades.
function makeProjector(bounds, size) {
	const lon0 = (bounds.minX + bounds.maxX) / 2;
	const lat0 = (bounds.minY + bounds.maxY) / 2;
	const k = Math.cos((lat0 * Math.PI) / 180);
	const width = (bounds.maxX - bounds.minX) * k;
	const height = bounds.maxY - bounds.minY;
	const scale = size / Math.max(width, height);
	return ([lon, lat]) => [(lon - lon0) * k * scale, (lat - lat0) * scale];
}

function ringAreaKm2(ring) {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [x1, y1] = ring[j];
		const [x2, y2] = ring[i];
		const k = Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
		sum += (x1 * k * KM_PER_DEG_LON) * (y2 * KM_PER_DEG_LAT) - (x2 * k * KM_PER_DEG_LON) * (y1 * KM_PER_DEG_LAT);
	}
	return Math.abs(sum) / 2;
}

function areaKm2(polygons) {
	let total = 0;
	for (const [outer, ...holes] of polygons) {
		total += ringAreaKm2(outer);
		for (const hole of holes) total -= ringAreaKm2(hole);
	}
	return total;
}

function inRing(x, y, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function inPolygon(x, y, [outer, ...holes]) {
	return inRing(x, y, outer) && !holes.some((h) => inRing(x, y, h));
}

// Punto interior representativo del polígono más grande: el centroide si cae
// dentro; si no (formas cóncavas), el punto interior de una malla más cercano a él.
function labelPoint(polygons) {
	const main = polygons.reduce((a, b) => (ringAreaKm2(b[0]) > ringAreaKm2(a[0]) ? b : a));
	const ring = main[0];
	let cx = 0, cy = 0, a = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
		cx += (ring[j][0] + ring[i][0]) * f;
		cy += (ring[j][1] + ring[i][1]) * f;
		a += f;
	}
	if (a !== 0) {
		cx /= 3 * a;
		cy /= 3 * a;
		if (inPolygon(cx, cy, main)) return [cx, cy];
	}
	const { minX, minY, maxX, maxY } = boundsOf([[main]]);
	let best = ring[0], bestD = Infinity;
	const n = 20;
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			const x = minX + ((i + 0.5) / n) * (maxX - minX);
			const y = minY + ((j + 0.5) / n) * (maxY - minY);
			if (!inPolygon(x, y, main)) continue;
			const d = (x - cx) ** 2 + (y - cy) ** 2;
			if (d < bestD) { bestD = d; best = [x, y]; }
		}
	}
	return best;
}

function toShapes(polygons, project) {
	const shapes = [];
	for (const [outer, ...holes] of polygons) {
		const pts = outer.slice(0, -1).map((p) => new THREE.Vector2(...project(p)));
		if (pts.length < 3) continue;
		const shape = new THREE.Shape(pts);
		for (const hole of holes) shape.holes.push(new THREE.Path(hole.slice(0, -1).map((p) => new THREE.Vector2(...project(p)))));
		shapes.push(shape);
	}
	return shapes;
}

// ---------------------------------------------------------------------------
// Animación (tweens simples sobre requestAnimationFrame)
// ---------------------------------------------------------------------------

const tweens = new Set();
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

function tween(duration, onUpdate, { delay = 0, ease = easeInOut } = {}) {
	return new Promise((resolve) => {
		tweens.add({ start: performance.now() + delay, duration, onUpdate, ease, resolve });
	});
}

function runTweens(now) {
	for (const t of tweens) {
		if (now < t.start) continue;
		const p = Math.min(1, (now - t.start) / t.duration);
		t.onUpdate(t.ease(p));
		if (p === 1) {
			tweens.delete(t);
			t.resolve();
		}
	}
}

// ---------------------------------------------------------------------------
// Escena
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
ui.scene.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
ui.scene.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1220, 260, 600);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.5, 1000);
const HOME_VIEW = { position: new THREE.Vector3(0, 105, 92), target: new THREE.Vector3(0, 0, 4) };

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_VIEW.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 25;
controls.maxDistance = 450;
controls.maxPolarAngle = 1.32;

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a2333, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-50, 110, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 10, far: 300 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x4cc9f0, 0.6);
rim.position.set(60, 40, -80);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.28 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(400, 80, 0x2b4a6b, 0x16273d);
grid.position.y = -0.05;
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);

// ---------------------------------------------------------------------------
// Capas del mapa (país o departamento)
// ---------------------------------------------------------------------------

function departmentColor(index) {
	return new THREE.Color().setHSL(((index * 137.508) % 360) / 360, 0.55, 0.52);
}

function municipalityColor(base, index) {
	const hsl = {};
	base.getHSL(hsl);
	const jitter = ((index * 0.618034) % 1) - 0.5;
	return new THREE.Color().setHSL((hsl.h + jitter * 0.16 + 1) % 1, 0.52 + jitter * 0.2, 0.34 + ((index * 0.381966) % 1) * 0.26);
}

// Crea un grupo 3D con un prisma extruido por cada elemento.
function buildLayer(items, project, { heightOf, colorOf, kind }) {
	const group = new THREE.Group();
	group.rotation.x = -Math.PI / 2; // el plano XY de las formas pasa a ser el suelo
	const entries = items.map((item, i) => {
		const height = heightOf(item);
		const color = colorOf(item, i);
		const holder = new THREE.Group();
		const geometry = new THREE.ExtrudeGeometry(toShapes(item.polygons, project), { depth: height, bevelEnabled: false, curveSegments: 1 });
		const top = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08 });
		const side = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.62), roughness: 0.7, metalness: 0.05 });
		const mesh = new THREE.Mesh(geometry, [top, side]);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		holder.add(mesh);

		const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
		for (const [outer] of item.polygons) {
			const pts = outer.map((p) => new THREE.Vector3(...project(p), height + 0.02));
			holder.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial));
		}

		const [lx, ly] = project(labelPoint(item.polygons));
		const el = document.createElement('div');
		el.className = 'map-label';
		el.textContent = item.name;
		const label = new CSS2DObject(el);
		label.position.set(lx, ly, height + 0.4);
		holder.add(label);

		group.add(holder);
		const entry = { item, kind, holder, mesh, materials: [top, side, lineMaterial], label, color, center: new THREE.Vector3(lx, 0, -ly), hover: 0, hoverTarget: 0, selected: false };
		mesh.userData.entry = entry;
		return entry;
	});
	return { group, entries, meshes: entries.map((e) => e.mesh) };
}

function setLayerOpacity(layer, opacity) {
	for (const e of layer.entries) {
		const [top, side, line] = e.materials;
		for (const m of [top, side]) {
			const transparent = opacity < 1;
			if (m.transparent !== transparent) {
				m.transparent = transparent;
				m.needsUpdate = true;
			}
			m.opacity = opacity;
		}
		line.opacity = 0.35 * opacity;
	}
}

function setLayerHeight(layer, factorFor) {
	for (const e of layer.entries) e.holder.scale.z = Math.max(0.001, factorFor(e));
}

function setLabelsVisible(layer, visible) {
	for (const e of layer.entries) e.label.visible = visible;
}

// ---------------------------------------------------------------------------
// Estado y lógica de navegación
// ---------------------------------------------------------------------------

let data;
let countryLayer;
const departmentLayers = new Map();
let activeLayer;
let currentDep = null; // entrada del departamento abierto
let selected = null; // municipio seleccionado
let hovered = null;
let busy = false;

function municipalitiesOf(dep) {
	return data.municipalities.filter((m) => m.dep === dep.name);
}

function getDepartmentLayer(dep) {
	if (departmentLayers.has(dep.name)) return departmentLayers.get(dep.name);
	const munis = municipalitiesOf(dep);
	const project = makeProjector(boundsOf([dep.polygons]), DEPARTMENT_SIZE);
	const maxArea = Math.max(...munis.map((m) => m.area));
	const base = countryLayer.entries.find((e) => e.item === dep).color;
	const layer = buildLayer(munis, project, {
		kind: 'municipality',
		heightOf: (m) => 1.2 + 4.5 * Math.sqrt(m.area / maxArea),
		colorOf: (_, i) => municipalityColor(base, i),
	});
	layer.group.visible = false;
	scene.add(layer.group);
	departmentLayers.set(dep.name, layer);
	return layer;
}

// En pantallas verticales el mapa necesita más distancia para caber a lo ancho.
function fitDistance(position, target) {
	const factor = Math.min(2.5, Math.max(1, 1 / camera.aspect));
	return position.clone().sub(target).multiplyScalar(factor).add(target);
}

// En escritorio el panel lateral tapa la izquierda: desplazamos el centro óptico.
function updateViewOffset() {
	const w = window.innerWidth, h = window.innerHeight;
	if (w > 720) camera.setViewOffset(w, h, -160, 0, w, h);
	else camera.clearViewOffset();
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}

function animateCamera(position, target, duration = 1100) {
	position = fitDistance(position, target);
	const p0 = camera.position.clone();
	const t0 = controls.target.clone();
	return tween(duration, (t) => {
		camera.position.lerpVectors(p0, position, t);
		controls.target.lerpVectors(t0, target, t);
	});
}

// Animación de entrada: los prismas crecen desde el centro hacia afuera.
function rise(layer, duration = 900) {
	const maxD = Math.max(...layer.entries.map((e) => e.center.length())) || 1;
	setLayerOpacity(layer, 1);
	setLayerHeight(layer, () => 0.001);
	return Promise.all(layer.entries.map((e) =>
		tween(duration, (t) => { e.holder.scale.z = Math.max(0.001, t); }, { delay: (e.center.length() / maxD) * 450, ease: easeOutBack })
	));
}

function sink(layer, duration = 500) {
	return tween(duration, (t) => {
		setLayerHeight(layer, () => 1 - t);
		setLayerOpacity(layer, 1 - t);
	});
}

async function openDepartment(dep) {
	if (busy || currentDep?.item === dep) return;
	busy = true;
	setHovered(null);
	const fromCountry = activeLayer === countryLayer;
	const depEntry = countryLayer.entries.find((e) => e.item === dep);
	const layer = getDepartmentLayer(dep);

	if (fromCountry) {
		// Acercamiento al departamento elegido mientras el resto se hunde.
		const focus = depEntry.center.clone();
		setLabelsVisible(countryLayer, false);
		await Promise.all([
			animateCamera(focus.clone().add(new THREE.Vector3(0, 55, 45)), focus, 700),
			tween(700, (t) => {
				for (const e of countryLayer.entries) {
					if (e === depEntry) e.holder.position.z = t * 4;
					else {
						e.holder.scale.z = Math.max(0.001, 1 - t);
						for (const m of e.materials) { m.transparent = true; m.opacity = (1 - t) * (m.isLineBasicMaterial ? 0.35 : 1); }
					}
				}
			}),
		]);
		countryLayer.group.visible = false;
		depEntry.holder.position.z = 0;
	} else {
		activeLayer.group.visible = false;
		setLabelsVisible(activeLayer, false);
	}

	currentDep = depEntry;
	selected = null;
	activeLayer = layer;
	layer.group.visible = true;
	setLabelsVisible(layer, true);
	for (const e of layer.entries) { e.selected = false; e.hover = 0; e.hoverTarget = 0; }
	renderPanel();
	camera.position.copy(fitDistance(new THREE.Vector3(0, 140, 120), new THREE.Vector3()));
	controls.target.set(0, 0, 0);
	await Promise.all([rise(layer), animateCamera(new THREE.Vector3(0, 82, 78), new THREE.Vector3(0, 0, 3), 1200)]);
	finishTransition();
}

async function openCountry() {
	if (busy || activeLayer === countryLayer) return;
	busy = true;
	setHovered(null);
	const layer = activeLayer;
	setLabelsVisible(layer, false);
	await Promise.all([sink(layer, 450), animateCamera(HOME_VIEW.position.clone().multiplyScalar(1.25), HOME_VIEW.target, 450)]);
	layer.group.visible = false;
	currentDep = null;
	selected = null;
	activeLayer = countryLayer;
	countryLayer.group.visible = true;
	setLabelsVisible(countryLayer, true);
	for (const e of countryLayer.entries) e.holder.position.z = 0;
	renderPanel();
	await Promise.all([rise(countryLayer, 800), animateCamera(HOME_VIEW.position, HOME_VIEW.target, 1000)]);
	finishTransition();
}

function selectMunicipality(entry) {
	if (selected) selected.selected = false;
	selected = entry === selected ? null : entry;
	if (selected) selected.selected = true;
	renderSummary();
	syncListState();
}

// La URL refleja el departamento abierto (#Petén) para poder compartirlo y
// usar el botón "atrás" del navegador.
function route() {
	const name = decodeURIComponent(location.hash.slice(1));
	const dep = data.departments.find((d) => d.name === name);
	if (dep) openDepartment(dep);
	else openCountry();
}

function goTo(dep) {
	if (dep) {
		const hash = `#${encodeURIComponent(dep.name)}`;
		if (location.hash === hash) route();
		else location.hash = hash; // dispara hashchange -> route()
	} else {
		if (location.hash) history.pushState(null, '', location.pathname + location.search);
		route();
	}
}

// Si el usuario navegó durante una transición, aplica el destino pendiente al terminar.
function finishTransition() {
	busy = false;
	const name = decodeURIComponent(location.hash.slice(1));
	if ((currentDep?.item.name ?? '') !== name) route();
}

// ---------------------------------------------------------------------------
// Panel lateral
// ---------------------------------------------------------------------------

function fmtArea(km2) {
	return `≈ ${numberFmt.format(km2)} km²`;
}

function renderSummary() {
	if (!currentDep) {
		const total = data.departments.reduce((s, d) => s + d.area, 0);
		ui.summary.innerHTML = `
			<h2>Guatemala</h2>
			<dl>
				<dt>Departamentos</dt><dd>${data.departments.length}</dd>
				<dt>Municipios</dt><dd>${data.municipalities.length}</dd>
				<dt>Superficie</dt><dd>${fmtArea(total)}</dd>
			</dl>
			<p class="hint">Altura de cada departamento = número de municipios. Toca uno para explorarlo.</p>`;
		return;
	}
	const dep = currentDep.item;
	const sel = selected?.item;
	ui.summary.innerHTML = `
		<h2>${sel ? sel.name : dep.name}</h2>
		<dl>
			${sel
				? `<dt>Departamento</dt><dd>${dep.name}</dd>
				   <dt>Superficie</dt><dd>${fmtArea(sel.area)}</dd>
				   <dt>% del depto.</dt><dd>${((sel.area / dep.area) * 100).toFixed(1)} %</dd>`
				: `<dt>Municipios</dt><dd>${dep.municipalities}</dd>
				   <dt>Superficie</dt><dd>${fmtArea(dep.area)}</dd>
				   <dt>Código ISO</dt><dd>${dep.iso}</dd>`}
		</dl>
		<p class="hint">${sel ? 'Toca de nuevo para deseleccionar.' : 'Altura de cada municipio según su superficie.'}</p>`;
}

function renderPanel() {
	const inDep = Boolean(currentDep);
	ui.crumbSep.hidden = ui.crumbDep.hidden = ui.back.hidden = !inDep;
	ui.crumbDep.textContent = inDep ? currentDep.item.name : '';
	ui.search.value = '';
	ui.search.placeholder = inDep ? 'Buscar municipio…' : 'Buscar departamento…';
	renderSummary();
	renderList();
}

function renderList() {
	const q = ui.search.value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '');
	ui.list.innerHTML = '';
	for (const entry of activeLayer.entries) {
		const name = entry.item.name;
		if (q && !name.toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(q)) continue;
		const li = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.innerHTML = `<span class="swatch" style="background:#${entry.color.getHexString()}"></span><span></span><span class="count"></span>`;
		btn.children[1].textContent = name;
		btn.children[2].textContent = entry.kind === 'department' ? entry.item.municipalities : `${numberFmt.format(entry.item.area)} km²`;
		btn.addEventListener('mouseenter', () => setHovered(entry));
		btn.addEventListener('mouseleave', () => setHovered(null));
		btn.addEventListener('click', () => activate(entry));
		entry.button = btn;
		li.appendChild(btn);
		ui.list.appendChild(li);
	}
	syncListState();
}

function syncListState() {
	for (const e of activeLayer.entries) {
		if (!e.button) continue;
		e.button.classList.toggle('is-active', e === hovered);
		e.button.classList.toggle('is-selected', e.selected);
	}
}

function activate(entry) {
	if (busy) return;
	if (entry.kind === 'department') goTo(entry.item);
	else selectMunicipality(entry);
	ui.panel.classList.remove('is-open');
}

// ---------------------------------------------------------------------------
// Interacción con el puntero
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

function setHovered(entry) {
	if (hovered === entry) return;
	if (hovered) {
		hovered.hoverTarget = 0;
		hovered.label.element.classList.remove('is-hot');
	}
	hovered = entry;
	if (hovered) {
		hovered.hoverTarget = 1;
		hovered.label.element.classList.add('is-hot');
	}
	renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
	syncListState();
}

function pick(event) {
	const rect = renderer.domElement.getBoundingClientRect();
	pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
	raycaster.setFromCamera(pointer, camera);
	return raycaster.intersectObjects(activeLayer.meshes, false)[0]?.object.userData.entry ?? null;
}

function showTooltip(entry, event) {
	if (!entry || event.pointerType === 'touch') {
		ui.tooltip.hidden = true;
		return;
	}
	const item = entry.item;
	const detail = entry.kind === 'department'
		? `${item.municipalities} municipios · ${fmtArea(item.area)}`
		: `${item.dep} · ${fmtArea(item.area)}`;
	ui.tooltip.innerHTML = '<strong></strong><small></small>';
	ui.tooltip.firstChild.textContent = item.name;
	ui.tooltip.lastChild.textContent = detail;
	ui.tooltip.style.left = `${event.clientX}px`;
	ui.tooltip.style.top = `${event.clientY}px`;
	ui.tooltip.hidden = false;
}

renderer.domElement.addEventListener('pointermove', (event) => {
	if (busy || event.buttons) {
		ui.tooltip.hidden = true;
		return;
	}
	const entry = pick(event);
	setHovered(entry);
	showTooltip(entry, event);
});

renderer.domElement.addEventListener('pointerleave', () => {
	setHovered(null);
	ui.tooltip.hidden = true;
});

renderer.domElement.addEventListener('pointerdown', (event) => {
	downAt = { x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener('pointerup', (event) => {
	if (!downAt || busy) return;
	const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
	downAt = null;
	if (moved > 6) return; // fue un arrastre para girar, no un clic
	const entry = pick(event);
	if (entry) activate(entry);
	else if (selected) selectMunicipality(selected);
});

ui.back.addEventListener('click', () => goTo(null));
ui.crumbHome.addEventListener('click', () => goTo(null));
ui.search.addEventListener('input', renderList);
ui.toggleLabels.addEventListener('change', () => document.body.classList.toggle('labels-off', !ui.toggleLabels.checked));
ui.panelToggle.addEventListener('click', () => ui.panel.classList.toggle('is-open'));
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && document.activeElement !== ui.search) {
		if (selected) selectMunicipality(selected);
		else if (currentDep) goTo(null);
	}
});
window.addEventListener('hashchange', route);

window.addEventListener('resize', () => {
	updateViewOffset();
	renderer.setSize(window.innerWidth, window.innerHeight);
	labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Bucle de render
// ---------------------------------------------------------------------------

function animate(now) {
	requestAnimationFrame(animate);
	runTweens(now);
	if (activeLayer) {
		for (const e of activeLayer.entries) {
			const target = Math.max(e.hoverTarget, e.selected ? 2.4 : 0);
			e.hover += (target - e.hover) * 0.18;
			if (!busy) e.holder.position.z = e.hover * 1.4;
			const glow = e.hover * 0.28;
			e.materials[0].emissive.copy(e.color).multiplyScalar(glow);
			e.materials[1].emissive.copy(e.color).multiplyScalar(glow * 0.6);
		}
	}
	controls.update();
	renderer.render(scene, camera);
	labelRenderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

async function init() {
	data = await (await fetch('data/guatemala.json')).json();
	for (const d of data.departments) d.area = areaKm2(d.polygons);
	for (const m of data.municipalities) m.area = areaKm2(m.polygons);

	const project = makeProjector(boundsOf(data.departments.map((d) => d.polygons)), COUNTRY_SIZE);
	countryLayer = buildLayer(data.departments, project, {
		kind: 'department',
		heightOf: (d) => 1 + d.municipalities * 0.11,
		colorOf: (_, i) => departmentColor(i),
	});
	scene.add(countryLayer.group);
	activeLayer = countryLayer;
	updateViewOffset();
	camera.position.copy(fitDistance(HOME_VIEW.position, HOME_VIEW.target));
	controls.update();
	renderPanel();
	requestAnimationFrame(animate);
	ui.loading.classList.add('is-done');

	const name = decodeURIComponent(location.hash.slice(1));
	if (data.departments.some((d) => d.name === name)) route();
	else await rise(countryLayer, 1000);
}

init().catch((err) => {
	console.error(err);
	ui.loading.textContent = 'No se pudo cargar el mapa. Abre la página desde un servidor web (ver README).';
});
