import { metroLines, metroStations } from "./metro-stations.js";

export function searchText(value) {
  return value.toLowerCase().replaceAll("ё", "е").replace(/[^а-яa-z0-9]+/g, " ").trim();
}

function distanceKm([lat1, lng1], [lat2, lng2]) {
  const radians = Math.PI / 180;
  const halfLatitude = (lat2 - lat1) * radians / 2;
  const halfLongitude = (lng2 - lng1) * radians / 2;
  const haversine = Math.sin(halfLatitude) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(halfLongitude) ** 2;
  return 12742 * Math.asin(Math.sqrt(haversine));
}

const separateStations = new Set(["арбатская", "смоленская"]);
const stations = [];
for (const [name, lat, lng, lineIndex] of metroStations) {
  const key = searchText(name);
  const coordinates = [lat, lng];
  // Nearby platforms at the same interchange can share one search result.
  if (!separateStations.has(key) && stations.some(station =>
    station.key === key && distanceKm(station.coordinates, coordinates) < 0.45
  )) {
    continue;
  }
  stations.push({ name, key, coordinates, line: metroLines[lineIndex] });
}

export function findMetroStations(value) {
  const query = searchText(value).replace(/^(?:метро|мцк|м)(?: |$)/, "");
  if (query.length < 2) return [];
  const exact = stations.filter(station => station.key === query);
  if (exact.length) return exact;
  return stations.filter(station => ` ${station.key}`.includes(` ${query}`));
}

export function nearestArenas(station, arenas) {
  return arenas
    .map(arena => ({ arena, km: distanceKm(station.coordinates, arena.coordinates) }))
    .sort((first, second) => first.km - second.km)
    .slice(0, 2);
}
