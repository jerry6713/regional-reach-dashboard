// The production app reads sanitized aggregates from its own authenticated server.
// If the endpoint is unavailable (for example when running the files with a basic
// static server), app.js falls back to the bundled snapshot in data.js.
export const CONFIG = {
  DATA_ENDPOINT: "/api/dashboard",
  REGION_GEOJSON:
    "https://cdn.jsdelivr.net/gh/tordecilla/ph-drilldown-map@19debdbe769fde5847304cf65f89253a88d8cfcd/geo-nir/country.0.001.json",
  // Used only to patch Sulu into current Region IX geography.
  BARMM_PROVINCES_GEOJSON:
    "https://cdn.jsdelivr.net/gh/faeldon/philippines-json-maps@8eeead5/2023/geojson/regions/lowres/provdists-region-1900000000.0.001.json",
};
