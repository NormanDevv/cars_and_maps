# Guatemala 3D

Mapa 3D interactivo de Guatemala hecho con [Three.js](https://threejs.org).

- **Vista país:** los 22 departamentos extruidos en 3D. La altura de cada uno
  representa su número de municipios. Pasa el cursor para ver nombre, municipios
  y superficie.
- **Vista departamento:** al hacer clic en un departamento (en el mapa o en la
  lista) la cámara se acerca y aparecen sus municipios en 3D, con altura según
  su superficie. Haz clic en un municipio para ver sus datos.
- Buscador en el panel lateral, nombres activables/desactivables, botón
  «Volver», tecla `Esc` y enlaces directos (por ejemplo `index.html#Petén`).
- Funciona en escritorio y en móvil (el panel se abre con el botón «Lista»).

## Cómo abrirlo

Los navegadores bloquean la carga de módulos y datos desde `file://`, así que
hay que servir la carpeta con cualquier servidor estático:

```bash
cd guatemala-3d
python3 -m http.server 8000
# abre http://localhost:8000
```

o `npx serve guatemala-3d`. También funciona tal cual en GitHub Pages.
No necesita instalación ni conexión a internet: Three.js está incluido en `vendor/`.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `index.html` | Página principal |
| `css/styles.css` | Estilos (panel, etiquetas, versión móvil) |
| `js/main.js` | Escena 3D, animaciones y navegación |
| `data/guatemala.json` | Límites de departamentos y municipios |
| `vendor/` | Three.js r160 (licencia MIT) |
| `tools/build-data.mjs` | Script que genera `data/guatemala.json` |

## Datos

Límites administrativos de [geoBoundaries](https://www.geoboundaries.org)
(gbOpen, GTM ADM1 y ADM2, versión simplificada), licencia CC BY 4.0. Incluye
342 municipios; cada uno se asigna a su departamento por posición geográfica
(ver `tools/build-data.mjs`). Las superficies mostradas son aproximadas,
calculadas a partir de los polígonos simplificados.

Para regenerar los datos:

```bash
node tools/build-data.mjs geoBoundaries-GTM-ADM1_simplified.geojson geoBoundaries-GTM-ADM2_simplified.geojson
```

## Publicación en línea (GitHub Pages)

El workflow `.github/workflows/pages.yml` publica esta carpeta en GitHub Pages
cada vez que cambia en `master` (también se puede lanzar a mano desde la
pestaña **Actions**). Requisito único: en **Settings → Pages**, elegir
**Source: GitHub Actions**. La web queda en
`https://<usuario>.github.io/cars_and_maps/`.
