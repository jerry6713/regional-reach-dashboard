import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import * as turf from "https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/+esm";
import { CONFIG } from "./config.js";
import { SNAPSHOT } from "./data.js";

const fmt = new Intl.NumberFormat("en-PH");
const pct = new Intl.NumberFormat("en-PH", { style: "percent", maximumFractionDigits: 1 });

const ui = Object.fromEntries([
  "kpiRegistered","kpiRecords","kpiNetworks","kpiEstimated","kpiRegions",
  "regionName","regionCode","statOfficial","statEstimated","statShare","statNetworks",
  "statMapped","statEstimates","comparisonPct","comparisonText","comparisonBar","dataQuality",
  "heatMetric","mapSubtitle","mapLoading","mapSvg","regionRanking","legendTitle","nationalBtn",
  "prayerBtn","prayerBar","prevRegion","nextRegion","prayerRegion","prayerProgress","mapWrap"
].map(id => [id, document.getElementById(id)]));

let data;
let geo;
let selectedPsgc = null;
let prayerMode = false;
let prayerIndex = 0;
let projection;
let path;
let mapGroup;
let labelGroup;

const prayerOrder = [
  1400000000, 100000000, 200000000, 300000000, 1300000000, 400000000,
  1700000000, 500000000, 600000000, 1800000000, 700000000, 800000000,
  900000000, 1000000000, 1600000000, 1900000000, 1200000000, 1100000000
];

const regionByPsgc = () => new Map(data.regions.map(r => [Number(r.psgc), r]));
const getRegion = psgc => regionByPsgc().get(Number(psgc));

async function loadDashboardData() {
  if (!CONFIG.DATA_ENDPOINT) return structuredClone(SNAPSHOT);
  try {
    const res = await fetch(CONFIG.DATA_ENDPOINT, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`Dashboard data request failed (${res.status})`);
    return await res.json();
  } catch (err) {
    console.warn("Using bundled dashboard snapshot:", err);
    return structuredClone(SNAPSHOT);
  }
}

async function loadAndPatchGeography() {
  const [regionsRes, barmmProvincesRes] = await Promise.all([
    fetch(CONFIG.REGION_GEOJSON, { cache: "force-cache" }),
    fetch(CONFIG.BARMM_PROVINCES_GEOJSON, { cache: "force-cache" }),
  ]);
  if (!regionsRes.ok || !barmmProvincesRes.ok) throw new Error("Could not load Philippine boundary data.");

  const fc = await regionsRes.json();
  const barmmProvinces = await barmmProvincesRes.json();

  const sulu = barmmProvinces.features.find(f => /sulu/i.test(
    f.properties?.adm2_en || f.properties?.adm2_name || f.properties?.name || ""
  ));

  // Source geometry is PSGC 2023 + NIR patch. Current PSGC places Sulu in Region IX.
  // Patch only if we can reliably identify Sulu and both parent regions.
  const r9Index = fc.features.findIndex(f => Number(f.properties?.adm1_psgc) === 900000000);
  const barmmIndex = fc.features.findIndex(f => Number(f.properties?.adm1_psgc) === 1900000000);

  if (sulu && r9Index >= 0 && barmmIndex >= 0) {
    try {
      const newR9 = turf.union(turf.featureCollection([fc.features[r9Index], sulu]));
      const newBarmm = turf.difference(turf.featureCollection([fc.features[barmmIndex], sulu]));
      if (newR9) {
        newR9.properties = { ...fc.features[r9Index].properties, adm1_psgc: 900000000, adm1_en: "Region IX (Zamboanga Peninsula)" };
        fc.features[r9Index] = newR9;
      }
      if (newBarmm) {
        newBarmm.properties = { ...fc.features[barmmIndex].properties, adm1_psgc: 1900000000, adm1_en: "Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)" };
        fc.features[barmmIndex] = newBarmm;
      }
    } catch (err) {
      console.warn("Sulu geography patch skipped:", err);
    }
  }
  return fc;
}

function valueForMetric(region, metric) {
  if (!region) return 0;
  if (metric === "networkCount") return Number(region.networkCount || 0);
  if (metric === "estimatedVoters") return Number(region.estimatedVoters || 0);
  return region.voters ? Number(region.estimatedVoters || 0) / Number(region.voters) : 0;
}

function getColorScale(metric) {
  const values = data.regions.map(r => valueForMetric(r, metric));
  const max = Math.max(...values, metric === "networkCount" ? 1 : 0);
  if (metric === "estimatedShare") return d3.scaleSequential().domain([0, Math.max(max, .01)]).interpolator(d3.interpolateReds);
  if (metric === "estimatedVoters") return d3.scaleSequential().domain([0, Math.max(max, 1)]).interpolator(d3.interpolateReds);
  return d3.scaleSequential().domain([0, Math.max(max, 1)]).interpolator(d3.interpolateBlues);
}

function metricLabel(metric) {
  return ({
    estimatedShare: "Estimated voter share",
    estimatedVoters: "Estimated voters",
    networkCount: "Network count",
  })[metric];
}

function fillForFeature(feature) {
  const region = getRegion(feature.properties?.adm1_psgc);
  if (!region) return "#dce4ea";
  const value = valueForMetric(region, ui.heatMetric.value);
  if (value <= 0) return "#dce4ea";
  return getColorScale(ui.heatMetric.value)(value);
}

function setNationalProjection(animate = false) {
  projection = d3.geoMercator().fitExtent([[55, 38], [705, 675]], geo);
  path = d3.geoPath(projection);
  redrawMap(animate);
}

function setRegionProjection(feature, animate = true) {
  projection = d3.geoMercator().fitExtent([[85, 55], [675, 655]], feature);
  path = d3.geoPath(projection);
  redrawMap(animate);
}

function redrawMap(animate = true) {
  const sel = mapGroup.selectAll("path.region");
  const labels = labelGroup.selectAll("text.map-label");
  const t = animate ? d3.transition().duration(650).ease(d3.easeCubicInOut) : null;
  if (t) {
    sel.transition(t).attr("d", path);
    labels.transition(t).attr("x", d => path.centroid(d)[0]).attr("y", d => path.centroid(d)[1]);
  } else {
    sel.attr("d", path);
    labels.attr("x", d => path.centroid(d)[0]).attr("y", d => path.centroid(d)[1]);
  }
}

function renderMap() {
  const svg = d3.select(ui.mapSvg);
  svg.selectAll("*").remove();
  mapGroup = svg.append("g").attr("class", "regions");
  labelGroup = svg.append("g").attr("class", "labels");

  mapGroup.selectAll("path")
    .data(geo.features)
    .join("path")
    .attr("class", "region")
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", d => d.properties?.adm1_en || "Philippine region")
    .attr("fill", fillForFeature)
    .on("click", (_, d) => selectRegion(Number(d.properties?.adm1_psgc), true))
    .on("keydown", (event, d) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRegion(Number(d.properties?.adm1_psgc), true);
      }
    });

  // Labels are intentionally compact; detailed names stay in the side panel.
  labelGroup.selectAll("text")
    .data(geo.features)
    .join("text")
    .attr("class", "map-label")
    .attr("text-anchor", "middle")
    .text(d => getRegion(d.properties?.adm1_psgc)?.short || "");

  setNationalProjection(false);
  ui.mapLoading.hidden = true;
  refreshMapStyling();
}

function refreshMapStyling() {
  if (!mapGroup) return;
  mapGroup.selectAll("path.region")
    .attr("fill", fillForFeature)
    .classed("selected", d => Number(d.properties?.adm1_psgc) === Number(selectedPsgc))
    .classed("dimmed", d => selectedPsgc && Number(d.properties?.adm1_psgc) !== Number(selectedPsgc));
  ui.legendTitle.textContent = metricLabel(ui.heatMetric.value);
}

function selectRegion(psgc, zoom = true) {
  selectedPsgc = Number(psgc);
  const region = getRegion(selectedPsgc);
  const feature = geo.features.find(f => Number(f.properties?.adm1_psgc) === selectedPsgc);
  if (!region || !feature) return;

  if (zoom) setRegionProjection(feature);
  refreshMapStyling();
  renderRegionStats(region);
  renderRanking();

  if (prayerMode) {
    const idx = prayerOrder.indexOf(selectedPsgc);
    if (idx >= 0) prayerIndex = idx;
    updatePrayerBar();
  }
}

function resetNationalView() {
  selectedPsgc = null;
  setNationalProjection(true);
  refreshMapStyling();
  renderNationalStats();
  renderRanking();
}

function renderNationalStats() {
  ui.regionName.textContent = "Philippines";
  ui.regionCode.textContent = "National overview";
  ui.statOfficial.textContent = fmt.format(data.summary.registeredVoters);
  ui.statEstimated.textContent = fmt.format(data.summary.estimatedVoters);
  ui.statShare.textContent = pct.format(data.summary.estimatedVoters / data.summary.registeredVoters);
  ui.statNetworks.textContent = fmt.format(data.summary.networkRecords);
  ui.statMapped.textContent = fmt.format(data.summary.mappedRecords);
  ui.statEstimates.textContent = fmt.format(data.regions.reduce((s,r) => s + Number(r.estimatesEntered || 0), 0));
  const share = data.summary.estimatedVoters / data.summary.registeredVoters;
  ui.comparisonPct.textContent = pct.format(share);
  ui.comparisonText.textContent = data.summary.estimatedVoters ? "Sourced estimated voter base compared with the official electorate." : "No sourced voter estimates entered yet.";
  ui.comparisonBar.style.width = `${Math.min(100, share * 100)}%`;
  ui.dataQuality.textContent = `${data.summary.mappedRecords} of ${data.summary.networkRecords} logged records currently have verified regional geography.`;
}

function renderRegionStats(region) {
  const share = region.voters ? region.estimatedVoters / region.voters : 0;
  ui.regionName.textContent = region.name;
  ui.regionCode.textContent = `PSGC ${String(region.psgc).padStart(10, "0")}`;
  ui.statOfficial.textContent = fmt.format(region.voters);
  ui.statEstimated.textContent = fmt.format(region.estimatedVoters);
  ui.statShare.textContent = pct.format(share);
  ui.statNetworks.textContent = fmt.format(region.networkCount);
  ui.statMapped.textContent = fmt.format(region.mappedRecords);
  ui.statEstimates.textContent = fmt.format(region.estimatesEntered);
  ui.comparisonPct.textContent = pct.format(share);
  ui.comparisonText.textContent = region.estimatedVoters
    ? `${fmt.format(region.estimatedVoters)} estimated voters represented against ${fmt.format(region.voters)} official registered voters.`
    : "No sourced voter estimate yet.";
  ui.comparisonBar.style.width = `${Math.min(100, share * 100)}%`;
  ui.dataQuality.textContent = region.networkCount
    ? `${region.networkCount} network/contact record(s) tagged to this region; ${region.estimatesEntered} currently carry a voter estimate.`
    : "No logged network/contact has been geographically tagged to this region yet.";
}

function renderRanking() {
  const metric = ui.heatMetric.value;
  const sorted = [...data.regions].sort((a,b) => valueForMetric(b, metric) - valueForMetric(a, metric) || b.voters - a.voters);
  ui.regionRanking.innerHTML = "";
  sorted.forEach((region, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `rank-row${Number(selectedPsgc) === Number(region.psgc) ? " active" : ""}`;
    let v = valueForMetric(region, metric);
    const display = metric === "estimatedShare" ? pct.format(v) : fmt.format(v);
    btn.innerHTML = `<span class="rank-num">${i+1}</span><span class="rank-name">${region.name}</span><span class="rank-value">${display}</span>`;
    btn.addEventListener("click", () => selectRegion(region.psgc, true));
    ui.regionRanking.appendChild(btn);
  });
}

function renderKpis() {
  ui.kpiRegistered.textContent = compact(data.summary.registeredVoters);
  ui.kpiRecords.textContent = fmt.format(data.summary.networkRecords);
  ui.kpiNetworks.textContent = fmt.format(data.summary.distinctNetworks);
  ui.kpiEstimated.textContent = compact(data.summary.estimatedVoters);
  ui.kpiRegions.textContent = `${data.summary.regionsWithReach} / ${data.regions.length}`;
}

function compact(n) {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.0+$|(\.\d*[1-9])0+$/,"$1")}M`;
  if (n >= 1_000) return `${(n/1_000).toFixed(1).replace(/\.0$/,"")}K`;
  return fmt.format(n);
}

function updatePrayerBar() {
  const psgc = prayerOrder[prayerIndex];
  const region = getRegion(psgc);
  ui.prayerRegion.textContent = region?.name || "—";
  ui.prayerProgress.textContent = `${prayerIndex + 1} of ${prayerOrder.length}`;
  ui.prevRegion.disabled = prayerIndex === 0;
  ui.nextRegion.textContent = prayerIndex === prayerOrder.length - 1 ? "Finish prayer route" : "Next region →";
}

function startPrayerMode() {
  prayerMode = true;
  ui.prayerBar.hidden = false;
  ui.prayerBtn.textContent = "Exit Prayer Mode";
  prayerIndex = selectedPsgc && prayerOrder.includes(Number(selectedPsgc))
    ? prayerOrder.indexOf(Number(selectedPsgc))
    : 0;
  selectRegion(prayerOrder[prayerIndex], true);
  updatePrayerBar();
}

function stopPrayerMode() {
  prayerMode = false;
  ui.prayerBar.hidden = true;
  ui.prayerBtn.textContent = "Start Prayer Mode";
}

function prayerMove(delta) {
  const next = prayerIndex + delta;
  if (next < 0) return;
  if (next >= prayerOrder.length) {
    stopPrayerMode();
    resetNationalView();
    return;
  }
  prayerIndex = next;
  selectRegion(prayerOrder[prayerIndex], true);
}

function showMapError(message) {
  ui.mapLoading.hidden = true;
  const svg = d3.select(ui.mapSvg);
  svg.selectAll("*").remove();
  svg.append("rect").attr("class","error-box").attr("x",80).attr("y",200).attr("width",600).attr("height",180).attr("rx",16);
  svg.append("text").attr("class","error-title").attr("x",110).attr("y",250).text("Map data could not load");
  svg.append("text").attr("class","error-text").attr("x",110).attr("y",285).text(message);
  svg.append("text").attr("class","error-text").attr("x",110).attr("y",315).text("The dashboard statistics remain available; refresh when the connection is restored.");
}

ui.nationalBtn.addEventListener("click", resetNationalView);
ui.heatMetric.addEventListener("change", () => {
  refreshMapStyling();
  renderRanking();
});
ui.prayerBtn.addEventListener("click", () => prayerMode ? stopPrayerMode() : startPrayerMode());
ui.prevRegion.addEventListener("click", () => prayerMove(-1));
ui.nextRegion.addEventListener("click", () => prayerMove(1));
ui.mapWrap.addEventListener("keydown", event => {
  if (!prayerMode) return;
  if (event.key === "ArrowRight") { event.preventDefault(); prayerMove(1); }
  if (event.key === "ArrowLeft") { event.preventDefault(); prayerMove(-1); }
  if (event.key === "Escape") { event.preventDefault(); stopPrayerMode(); }
});

try {
  data = await loadDashboardData();
  if (Number(data.summary?.estimatedVoters || 0) <= 0) ui.heatMetric.value = "networkCount";
  renderKpis();
  renderNationalStats();
  renderRanking();
  try {
    geo = await loadAndPatchGeography();
    renderMap();
  } catch (geoErr) {
    console.error(geoErr);
    showMapError(geoErr.message);
  }
} catch (err) {
  console.error(err);
  showMapError(err.message);
}
