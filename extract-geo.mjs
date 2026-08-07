import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import exifr from 'exifr';

const picturesDir = resolve('Pictures');
const jsonOut = resolve('geotags.json');
const gpxOut = resolve('track.gpx');

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

// Write JSON
const jsonNodes = nodes.map((n) => ({
  file: n.file,
  latitude: n.latitude,
  longitude: n.longitude,
  altitude: n.altitude,
  time: fmtTime(n.time),
}));
await writeFile(jsonOut, JSON.stringify(jsonNodes, null, 2), 'utf8');

// Write GPX
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  <trk>
    <name>Photo track</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
await writeFile(gpxOut, gpx, 'utf8');

console.log(`Photos with GPS: ${nodes.length} / ${files.length}`);
console.log(`JSON: ${jsonOut}`);
console.log(`GPX:  ${gpxOut}`);
