/**
 * Shared parcel geometry helpers.
 *
 * Files under functions/ whose name begins with an underscore are not routed
 * as endpoints, so this is importable by the real handlers without becoming
 * one itself.
 *
 * Why we measure rather than read an area field:
 *
 * The AZGeo layer publishes Shape_Area, but its units were ambiguous — the
 * layer declares sourceSpatialReference 26912 (UTM 12N, metres) while
 * publishing its extent in 102100 (web mercator), and web mercator overstates
 * area by 1/cos²(lat), about 49% at Arizona's latitude. Checked against APN
 * 20103087 (Mohave, 18 rings, exactly 18 PLSS sections): read as metres it
 * gives 11,492 acres against our measured 11,487.7, a ratio of 1.0004. So it
 * is metres, and the 0.04% is the UTM zone-12 scale factor at that longitude.
 *
 * We still measure, for two reasons. The rings are already downloaded for the
 * centroid, so it is free. And the UTM scale factor grows as you move west of
 * zone 12 — across Mohave, La Paz and Yuma, which is exactly where this
 * product's buyers are looking. Measuring on the sphere has no such gradient.
 *
 * Utah's Shape__Area is genuinely web mercator and needed a cos²(lat)
 * correction; measuring means both states now use one method.
 */

/* The authalic radius — the sphere with the same surface area as the WGS84
   ellipsoid. Most implementations of this formula (Turf among them) use the
   equatorial radius 6378137, which inflates every area by 0.22%. Small, but a
   bias rather than noise: it would push every parcel the same direction. */
const R_EARTH = 6371007.181;
const M2_PER_ACRE = 4046.8564224;
const rad = d => d * Math.PI / 180;

/* ArcGIS repeats the first vertex to close a ring; drop it before wrapping. */
const openRing = r => {
  const n = r.length;
  return (n > 1 && r[0][0] === r[n - 1][0] && r[0][1] === r[n - 1][1]) ? r.slice(0, n - 1) : r;
};

/* Signed geodesic area in square metres, by spherical excess. The sign carries
   ring orientation, which is how holes cancel: ArcGIS winds outer rings one
   way and holes the other, so summing signed areas nets them out. */
export function ringAreaM2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return (total * R_EARTH * R_EARTH) / 2;
}

/* Planar area-weighted centroid of one ring. Degrees in, {lat, lon} out.
   Planar is fine here: a parcel is small enough that the error is far below
   the precision we report. */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-14) {   // degenerate sliver — fall back to the vertex mean
    const sx = ring.reduce((s, v) => s + v[0], 0), sy = ring.reduce((s, v) => s + v[1], 0);
    return { lat: +(sy / ring.length).toFixed(6), lon: +(sx / ring.length).toFixed(6) };
  }
  a *= 0.5;
  return { lat: +(cy / (6 * a)).toFixed(6), lon: +(cx / (6 * a)).toFixed(6) };
}

/* Acreage net of holes, centroid of the largest part, and a thinned boundary
   for drawing. Returns nulls rather than throwing on odd or absent geometry. */
export function measure(geom) {
  const empty = { acres: null, centroid: null, boundary: null };
  if (!geom || !Array.isArray(geom.rings) || !geom.rings.length) return empty;

  let signed = 0, best = null, bestAbs = -1;
  for (const raw of geom.rings) {
    const ring = openRing(raw);
    if (ring.length < 3) continue;
    const a = ringAreaM2(ring);
    signed += a;
    if (Math.abs(a) > bestAbs) { bestAbs = Math.abs(a); best = ring; }
  }
  if (!best) return empty;

  const m2 = Math.abs(signed);
  return {
    acres: m2 > 0 ? +(m2 / M2_PER_ACRE).toFixed(2) : null,
    centroid: ringCentroid(best),
    boundary: geom.rings.map(r => {
      const step = Math.max(1, Math.ceil(r.length / 200));
      return r.filter((_, i) => i % step === 0).map(v => [+v[1], +v[0]]);
    })
  };
}
