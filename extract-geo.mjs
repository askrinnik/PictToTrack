import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';

const picturesDir = resolve('Pictures');
const thumbsDir = resolve('result_thumbs');
const jsonOut = resolve('result_geotags.json');
const gpxOut = resolve('result_track.gpx');
const htmlOut = resolve('result_map.html');

const THUMB_WIDTH = 240;

function fmtTime(d) {
  return d instanceof Date && !isNaN(d) ? d.toISOString() : null;
}

const files = (await readdir(picturesDir))
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort();

const nodes = [];

for (const file of files) {
  const full = join(picturesDir, file);
  try {
    const gps = await exifr.gps(full);
    const exif = await exifr.parse(full, ['DateTimeOriginal', 'CreateDate']);
    const taken = exif?.DateTimeOriginal ?? exif?.CreateDate ?? null;
    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      let altitude = null;
      try {
        const full2 = await exifr.parse(full, { gps: true });
        if (typeof full2?.GPSAltitude === 'number') altitude = full2.GPSAltitude;
      } catch {}
      nodes.push({
        file,
        latitude: gps.latitude,
        longitude: gps.longitude,
        altitude,
        time: taken instanceof Date ? taken : null,
      });
    } else {
      console.warn(`No GPS: ${file}`);
    }
  } catch (err) {
    console.warn(`Error reading ${file}: ${err.message}`);
  }
}

// Sort chronologically; fall back to filename order when time missing
nodes.sort((a, b) => {
  const ta = a.time ? a.time.getTime() : null;
  const tb = b.time ? b.time.getTime() : null;
  if (ta != null && tb != null) return ta - tb;
  if (ta != null) return -1;
  if (tb != null) return 1;
  return a.file.localeCompare(b.file);
});

// Generate thumbnails
await mkdir(thumbsDir, { recursive: true });
for (const n of nodes) {
  const thumbName = n.file.replace(/\.jpe?g$/i, '') + '.jpg';
  const thumbPath = join(thumbsDir, thumbName);
  try {
    await sharp(join(picturesDir, n.file))
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);
    n.thumb = `result_thumbs/${thumbName}`;
  } catch (err) {
    console.warn(`Thumb failed ${n.file}: ${err.message}`);
    n.thumb = null;
  }
}

// Write JSON
const jsonNodes = nodes.map((n) => ({
  file: n.file,
  thumb: n.thumb ?? null,
  latitude: n.latitude,
  longitude: n.longitude,
  altitude: n.altitude,
  time: fmtTime(n.time),
}));
await writeFile(jsonOut, JSON.stringify(jsonNodes, null, 2), 'utf8');

// Write GPX
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wpts = nodes
  .map((n) => {
    const parts = [`  <wpt lat="${n.latitude}" lon="${n.longitude}">`];
    if (typeof n.altitude === 'number') parts.push(`    <ele>${n.altitude}</ele>`);
    if (n.time) parts.push(`    <time>${fmtTime(n.time)}</time>`);
    parts.push(`    <name>${esc(n.file)}</name>`);
    parts.push(`    <sym>Camera</sym>`);
    parts.push(`  </wpt>`);
    return parts.join('\n');
  })
  .join('\n');
const trkpts = nodes
  .map((n) => {
    const parts = [`      <trkpt lat="${n.latitude}" lon="${n.longitude}">`];
    if (typeof n.altitude === 'number') parts.push(`        <ele>${n.altitude}</ele>`);
    if (n.time) parts.push(`        <time>${fmtTime(n.time)}</time>`);
    parts.push(`        <name>${esc(n.file)}</name>`);
    parts.push(`      </trkpt>`);
    return parts.join('\n');
  })
  .join('\n');

const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PictToTrack" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>PictToTrack</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wpts}
  <trk>
    <name>Photo track</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
await writeFile(gpxOut, gpx, 'utf8');

// Write self-contained map page with embedded data and thumbnail panel
const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PictToTrack — карта</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <style>
    html, body { margin: 0; height: 100%; }
    #layout { display: flex; height: 100%; }
    #map { flex: 1 1 auto; height: 100%; min-width: 0; }
    #divider { flex: 0 0 6px; cursor: col-resize; background: #bbb; }
    #divider:hover { background: #4d78ff; }
    #panel { flex: 0 0 260px; height: 100%; overflow-y: auto; box-sizing: border-box;
      padding: 8px; background: #f4f4f4; }
    #panel-grid { display: grid; grid-template-columns: repeat(auto-fill, 240px);
      justify-content: center; gap: 6px; }
    .thumb-cell { width: 240px; position: relative; cursor: pointer; border: 2px solid transparent;
      border-radius: 4px; overflow: hidden; background: #fff; line-height: 0; box-sizing: border-box; }
    .thumb-cell img { width: 100%; height: auto; display: block; }
    .thumb-cell:hover { border-color: #4d78ff; }
    .thumb-cell.active { border-color: #d63030; box-shadow: 0 0 0 2px rgba(214,48,48,0.4); }
    .photo-tooltip img { display: block; max-width: 240px; height: auto; border-radius: 4px; }
    .photo-popup img { display: block; max-width: 240px; height: auto; border-radius: 4px; margin-bottom: 6px; }
    .photo-popup a { font-weight: 600; }
    .photo-popup .time { color: #555; font-size: 12px; margin-top: 2px; }
    .leaflet-tooltip.photo-tooltip { padding: 3px; }
    .endpoint-icon { display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
      border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
    .endpoint-icon span { transform: rotate(45deg); font-size: 13px; font-weight: 700; color: #fff; }
    .endpoint-start { background: #2e9e3f; }
    .endpoint-finish { background: #d63030; }
  </style>
</head>
<body>
  <div id="layout">
    <div id="map"></div>
    <div id="divider" title="Потяните, чтобы изменить размер панели"></div>
    <div id="panel"><div id="panel-grid"></div></div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    var NODES = ${JSON.stringify(jsonNodes)};
    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function fmtTime(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      return isNaN(d) ? esc(iso) : d.toLocaleString();
    }
    function tooltipHtml(n) {
      return n.thumb ? '<div class="photo-tooltip"><img src="' + esc(n.thumb) + '" alt="' + esc(n.file) + '" loading="lazy" /></div>' : "";
    }
    function popupHtml(n, label) {
      var thumb = n.thumb ? '<img src="' + esc(n.thumb) + '" alt="' + esc(n.file) + '" loading="lazy" />' : "";
      var time = n.time ? '<div class="time">' + fmtTime(n.time) + '</div>' : "";
      var lab = label ? '<div class="time"><b>' + esc(label) + '</b></div>' : "";
      return '<div class="photo-popup">' + thumb +
        '<a href="Pictures/' + esc(n.file) + '" target="_blank" rel="noopener">' + esc(n.file) + '</a>' +
        lab + time + '</div>';
    }
    function endpointIcon(cls, text) {
      return L.divIcon({
        className: "",
        html: '<div class="endpoint-icon ' + cls + '"><span>' + text + '</span></div>',
        iconSize: [30, 30], iconAnchor: [15, 30], tooltipAnchor: [0, -30], popupAnchor: [0, -30],
      });
    }

    var map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    // Draggable vertical divider to resize the panel
    (function () {
      var layout = document.getElementById("layout");
      var divider = document.getElementById("divider");
      var panel = document.getElementById("panel");
      var dragging = false;
      divider.addEventListener("mousedown", function (e) {
        dragging = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        e.preventDefault();
      });
      window.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        var rect = layout.getBoundingClientRect();
        var w = rect.right - e.clientX;
        w = Math.max(60, Math.min(w, rect.width - 100));
        panel.style.flexBasis = w + "px";
        map.invalidateSize();
      });
      window.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        map.invalidateSize();
      });
    })();

    var pts = NODES.filter(function (n) { return typeof n.latitude === "number" && typeof n.longitude === "number"; });

    if (!pts.length) {
      map.setView([0, 0], 2);
    } else {
      var latlngs = pts.map(function (n) { return [n.latitude, n.longitude]; });
      L.polyline(latlngs, { color: "#e6194b", weight: 3, opacity: 0.7 }).addTo(map);

      var markers = [];
      pts.forEach(function (n, i) {
        var isStart = i === 0;
        var isFinish = i === pts.length - 1;
        var label = isStart ? "Старт" : isFinish ? "Финиш" : "";
        var marker;
        if (isStart || isFinish) {
          marker = L.marker([n.latitude, n.longitude], {
            icon: endpointIcon(isStart ? "endpoint-start" : "endpoint-finish", isStart ? "A" : "B"),
            zIndexOffset: 1000,
          }).addTo(map);
        } else {
          marker = L.circleMarker([n.latitude, n.longitude], {
            radius: 6, color: "#1f4fd8", weight: 2, fillColor: "#4d78ff", fillOpacity: 0.9,
          }).addTo(map);
        }
        if (n.thumb) {
          marker.bindTooltip(tooltipHtml(n), { direction: "top", opacity: 1, className: "photo-tooltip" });
        }
        marker.bindPopup(popupHtml(n, label));
        markers.push(marker);
      });

      var grid = document.getElementById("panel-grid");
      var cells = [];
      pts.forEach(function (n, i) {
        if (!n.thumb) return;
        var cell = document.createElement("div");
        cell.className = "thumb-cell";
        cell.title = n.file;
        cell.innerHTML = '<img src="' + esc(n.thumb) + '" alt="' + esc(n.file) + '" loading="lazy" />';
        cell.addEventListener("click", function () {
          cells.forEach(function (c) { if (c) c.classList.remove("active"); });
          cell.classList.add("active");
          map.setView([n.latitude, n.longitude], Math.max(map.getZoom(), 16), { animate: true });
          markers[i].openPopup();
        });
        cell.addEventListener("dblclick", function () {
          window.open("Pictures/" + encodeURIComponent(n.file), "_blank", "noopener");
        });
        cells[i] = cell;
        grid.appendChild(cell);
      });

      markers.forEach(function (marker, i) {
        marker.on("popupopen", function () {
          cells.forEach(function (c) { if (c) c.classList.remove("active"); });
          if (cells[i]) {
            cells[i].classList.add("active");
            cells[i].scrollIntoView({ block: "nearest" });
          }
        });
      });

      map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
    }
  </script>
</body>
</html>
`;
await writeFile(htmlOut, html, 'utf8');

console.log(`Photos with GPS: ${nodes.length} / ${files.length}`);
console.log(`JSON:   ${jsonOut}`);
console.log(`GPX:    ${gpxOut}`);
console.log(`Thumbs: ${thumbsDir}`);
console.log(`Map:    ${htmlOut}`);
