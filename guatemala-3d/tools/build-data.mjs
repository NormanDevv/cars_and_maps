// Genera data/guatemala.json a partir de los límites de geoBoundaries (CC BY 4.0).
//
// Uso:
//   node tools/build-data.mjs <adm1.geojson> <adm2.geojson>
//
// Descarga de los archivos fuente:
//   https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/GTM/ADM1/geoBoundaries-GTM-ADM1_simplified.geojson
//   https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/GTM/ADM2/geoBoundaries-GTM-ADM2_simplified.geojson
//
// Los municipios (ADM2) no traen el departamento al que pertenecen, así que se
// asignan por votación: se muestrean puntos dentro de cada municipio y se cuenta
// en qué departamento cae cada punto.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [adm1Path, adm2Path] = process.argv.slice(2);
if (!adm1Path || !adm2Path) {
	console.error('Uso: node tools/build-data.mjs <adm1.geojson> <adm2.geojson>');
	process.exit(1);
}

const adm1 = JSON.parse(readFileSync(adm1Path, 'utf8'));
const adm2 = JSON.parse(readFileSync(adm2Path, 'utf8'));

// Polygon -> [rings], MultiPolygon -> [[rings]]; normalizamos a lista de polígonos.
function polygonsOf(geometry) {
	if (geometry.type === 'Polygon') return [geometry.coordinates];
	if (geometry.type === 'MultiPolygon') return geometry.coordinates;
	throw new Error(`Geometría no soportada: ${geometry.type}`);
}

function round(polys) {
	return polys.map((rings) => rings.map((ring) => ring.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])));
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

function inPolygons(x, y, polys) {
	return polys.some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some((h) => inRing(x, y, h)));
}

function bbox(polys) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const rings of polys) for (const [x, y] of rings[0]) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return [minX, minY, maxX, maxY];
}

function samplePoints(polys, n = 24) {
	const [minX, minY, maxX, maxY] = bbox(polys);
	const pts = [];
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			const x = minX + ((i + 0.5) / n) * (maxX - minX);
			const y = minY + ((j + 0.5) / n) * (maxY - minY);
			if (inPolygons(x, y, polys)) pts.push([x, y]);
		}
	}
	if (pts.length === 0) {
		const ring = polys[0][0];
		pts.push([ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]);
	}
	return pts;
}

const departments = adm1.features.map((f) => ({
	name: f.properties.shapeName,
	iso: f.properties.shapeISO,
	polygons: polygonsOf(f.geometry),
}));

const municipalities = adm2.features.map((f) => {
	const polygons = polygonsOf(f.geometry);
	const votes = new Map();
	for (const [x, y] of samplePoints(polygons)) {
		const dep = departments.find((d) => inPolygons(x, y, d.polygons));
		if (dep) votes.set(dep.name, (votes.get(dep.name) || 0) + 1);
	}
	let dep = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (!dep) {
		// Sin coincidencias (costa o isla): el departamento con el centro más cercano.
		const [minX, minY, maxX, maxY] = bbox(polygons);
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
		dep = departments
			.map((d) => {
				const [a, b, c, e] = bbox(d.polygons);
				return [d.name, ((a + c) / 2 - cx) ** 2 + ((b + e) / 2 - cy) ** 2];
			})
			.sort((a, b) => a[1] - b[1])[0][0];
		console.warn(`Asignado por cercanía: ${f.properties.shapeName} -> ${dep}`);
	}
	return { name: f.properties.shapeName, dep, polygons: round(polygons) };
});

const out = {
	source: 'geoBoundaries (gbOpen GTM ADM1/ADM2), CC BY 4.0 — https://www.geoboundaries.org',
	departments: departments
		.map((d) => ({
			name: d.name,
			iso: d.iso,
			municipalities: municipalities.filter((m) => m.dep === d.name).length,
			polygons: round(d.polygons),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, 'es')),
	municipalities: municipalities.sort((a, b) => a.name.localeCompare(b.name, 'es')),
};

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'guatemala.json');
writeFileSync(target, JSON.stringify(out));
for (const d of out.departments) console.log(`${d.name.padEnd(16)} ${d.municipalities} municipios`);
console.log(`Total: ${out.municipalities.length} municipios -> ${target}`);
