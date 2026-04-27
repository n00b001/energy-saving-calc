import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { AreaChart, Area, LineChart, Line, BarChart, Bar, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, CartesianGrid, Legend } from "recharts";

// Repair truncated JSON from mobile copy — must be first to avoid bundler TDZ issues
var repairJSON = function(text) {
  var trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch(e) {}
  var resultsIdx = trimmed.indexOf('"results"');
  if (resultsIdx > -1) {
    var lastComplete = trimmed.lastIndexOf("},");
    var lastObj = trimmed.lastIndexOf("}");
    var cutPoint = lastComplete > resultsIdx ? lastComplete + 1 : (lastObj > resultsIdx ? lastObj + 1 : -1);
    if (cutPoint > resultsIdx) {
      try { return JSON.parse(trimmed.substring(0, cutPoint) + "]}"); } catch(e2) {}
    }
  }
  if (trimmed.startsWith("[")) {
    var lc2 = trimmed.lastIndexOf("},");
    var lo2 = trimmed.lastIndexOf("}");
    var cp2 = lc2 > 0 ? lc2 + 1 : (lo2 > 0 ? lo2 + 1 : -1);
    if (cp2 > 0) {
      try { return JSON.parse(trimmed.substring(0, cp2) + "]"); } catch(e3) {}
    }
  }
  if (trimmed.includes('"hourly"')) {
    var attempt = trimmed;
    var braces = 0, brackets = 0;
    for (var ci = 0; ci < attempt.length; ci++) {
      var ch = attempt[ci];
      if (ch === '{') braces++; else if (ch === '}') braces--;
      else if (ch === '[') brackets++; else if (ch === ']') brackets--;
    }
    var end = attempt.length;
    while (end > 0 && !/[\d\]}"null]/.test(attempt[end-1])) end--;
    if (end > 0 && attempt[end-1] === ',') end--;
    attempt = attempt.substring(0, end);
    while (brackets > 0) { attempt += "]"; brackets--; }
    while (braces > 0) { attempt += "}"; braces--; }
    try { return JSON.parse(attempt); } catch(e4) {}
  }
  throw new Error("Could not parse JSON — try copying a smaller amount of text");
};

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const UK_MONTHLY_TEMPS = [4.5,4.6,6.5,8.9,12.0,14.8,17.0,16.7,14.1,10.7,7.3,4.8];
const heatingDegrees = t => Math.max(0, 15.5 - t);
const SOLAR_KWH_PER_KWP_BASE = [25,40,75,110,130,140,135,115,85,55,30,20];
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];

const DNO_REGIONS = [
  {code:"A",name:"East England"},
  {code:"B",name:"East Midlands"},
  {code:"C",name:"London"},
  {code:"D",name:"Merseyside & N.Wales"},
  {code:"E",name:"West Midlands"},
  {code:"F",name:"North East"},
  {code:"G",name:"North West"},
  {code:"H",name:"Southern"},
  {code:"J",name:"South East"},
  {code:"K",name:"South Wales"},
  {code:"L",name:"South West"},
  {code:"M",name:"Yorkshire"},
  {code:"N",name:"S. Scotland"},
  {code:"P",name:"N. Scotland"},
];

const AGILE_PRODUCT = "AGILE-FLEX-22-11-25";
const AGILE_EXPORT_PRODUCT = "AGILE-OUTGOING-19-05-13";

// ─── SOLAR MODELS ────────────────────────────────────────────────────────────

const heatPumpCOP = t => Math.max(1.8, Math.min(5.0, 2.8 + 0.09 * t));

const tiltCorrection = (tilt, month) => {
  const dev = tilt - 35;
  const elev = [18,24,33,44,52,56,54,47,37,28,20,16][month];
  const bias = (tilt - 35) * (35 - elev) * 0.0004;
  return Math.max(0.45, Math.min(1.05, 1 - 0.00015 * dev * dev + bias));
};

const azimuthCorrectionFactor = az => {
  // Deviation from south (180°) — 0° = facing south = best, 180° = facing north = worst
  const dev = Math.min(Math.abs(az - 180), 360 - Math.abs(az - 180));
  return Math.max(0.50, 0.55 + 0.45 * Math.cos(dev * Math.PI / 180));
};

const azimuthTimeShift = az => {
  const d = ((az - 180) + 360) % 360;
  return (d > 180 ? d - 360 : d) / 180 * 3;
};

const correctedSolarKWh = (tilt, az) => {
  const af = azimuthCorrectionFactor(az);
  return SOLAR_KWH_PER_KWP_BASE.map((b, m) => b * tiltCorrection(tilt, m) * af);
};

const generateSolarProfile = (month, az = 180) => {
  const p = [];
  const sr = [8.2,7.5,6.5,5.8,5.0,4.5,4.8,5.5,6.3,7.0,7.5,8.3][month];
  const ss = [16.2,17.0,18.0,19.5,20.5,21.2,21.0,20.2,19.0,17.5,16.5,15.8][month];
  const pk = (sr + ss) / 2 + azimuthTimeShift(az);
  const dl = ss - sr;
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    if (h < sr || h > ss) p.push(0);
    else { const x = (h - pk) / (dl / 4); p.push(Math.exp(-x * x)); }
  }
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.map(v => v / s) : p;
};

const generateDemandProfile = () => {
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let f;
    if (h<5) f=0.008; else if(h<7) f=0.015; else if(h<9) f=0.035;
    else if(h<12) f=0.02; else if(h<14) f=0.025; else if(h<16) f=0.02;
    else if(h<19) f=0.04; else if(h<22) f=0.03; else f=0.012;
    p.push(f);
  }
  const s = p.reduce((a,b) => a+b, 0);
  return p.map(v => v/s);
};

const generateHeatingProfile = () => {
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let f;
    if(h<5) f=0.01; else if(h<7) f=0.04; else if(h<9) f=0.05;
    else if(h<16) f=0.015; else if(h<21) f=0.04; else if(h<23) f=0.02;
    else f=0.008;
    p.push(f);
  }
  const s = p.reduce((a,b) => a+b, 0);
  return p.map(v => v/s);
};

// Fallback synthetic agile profile when no API data
const generateSyntheticAgile = (month) => {
  const isSummer = month >= 3 && month <= 8;
  const isWinter = month <= 1 || month >= 10;
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let pr;
    if(h<4) pr=isSummer?8:12; else if(h<5) pr=isSummer?6:10;
    else if(h<7) pr=isSummer?12:18; else if(h<9) pr=isSummer?22:32;
    else if(h<12) pr=isSummer?15:24; else if(h<14) pr=isSummer?10:20;
    else if(h<16) pr=isSummer?8:22; else if(h<19) pr=isSummer?28:42;
    else if(h<21) pr=isSummer?18:28; else if(h<23) pr=isSummer?14:20;
    else pr=isSummer?10:15;
    const mf = isWinter?1.1:isSummer?0.9:1.0;
    if(isSummer && h>=11 && h<=15 && month>=4 && month<=7) pr = Math.max(-5, pr - 12);
    p.push(pr * mf);
  }
  return p;
};

const DEMAND_PROFILE = generateDemandProfile();
const HEATING_PROFILE = generateHeatingProfile();

// ─── OPEN-METEO SOLAR IRRADIANCE ─────────────────────────────────────────────

async function fetchSolarData(lat, lon, onProgress) {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - 7);
  const startStr = oneYearAgo.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  onProgress && onProgress(0.1);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startStr}&end_date=${endStr}&hourly=shortwave_radiation,temperature_2m,cloud_cover&timezone=Europe%2FLondon`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (fetchErr) {
    throw new Error(`Fetch failed: ${fetchErr.message || "Network/CORS error"}. Upload a CSV instead.`);
  }
  if (!resp.ok) throw new Error(`API returned ${resp.status} ${resp.statusText}`);
  onProgress && onProgress(0.6);

  const data = await resp.json();
  onProgress && onProgress(0.9);

  if (!data.hourly || !data.hourly.shortwave_radiation) {
    throw new Error("No solar radiation data returned");
  }

  // Organise into per-day arrays: { "2025-04-10": { ghi: [24 hourly W/m²], temp: [...], cloud: [...] } }
  const days = {};
  const times = data.hourly.time;
  const ghi = data.hourly.shortwave_radiation;
  const temp = data.hourly.temperature_2m;
  const cloud = data.hourly.cloud_cover;

  for (let i = 0; i < times.length; i++) {
    const dateKey = times[i].substring(0, 10);
    if (!days[dateKey]) days[dateKey] = { ghi: [], temp: [], cloud: [] };
    days[dateKey].ghi.push(ghi[i] || 0);
    days[dateKey].temp.push(temp[i] || 10);
    days[dateKey].cloud.push(cloud[i] || 50);
  }

  // Only keep days with 24 hours of data
  const completeDays = {};
  for (const [date, d] of Object.entries(days)) {
    if (d.ghi.length >= 23) {
      // Ensure exactly 24 entries
      while (d.ghi.length < 24) { d.ghi.push(0); d.temp.push(d.temp[d.temp.length-1]||10); d.cloud.push(50); }
      completeDays[date] = d;
    }
  }

  onProgress && onProgress(1.0);
  return completeDays;
}

// Convert hourly GHI (W/m²) to half-hourly PV output (kWh) for a given day
// Uses real irradiance with tilt/azimuth transposition model
function dailySolarOutput(dayData, kWp, tilt, azimuth, month) {
  const { ghi, temp } = dayData;
  const perfRatio = 0.83; // System losses: inverter, cables, soiling, mismatch
  const tiltFact = tiltCorrection(tilt, month);
  const azFact = azimuthCorrectionFactor(azimuth);

  // Transposition factor from horizontal GHI to tilted POA
  // For UK, south-facing 35° gets ~13% more than horizontal annually
  // This is already encoded in tiltCorrection relative to 35° baseline
  // We need the ratio vs horizontal, not vs 35°
  const horizontalToTilt35 = 1.13; // UK average annual boost for 35° south
  const tiltVsHorizontal = tiltFact * horizontalToTilt35;
  const transposition = tiltVsHorizontal * azFact;

  // Temperature derating: -0.4%/°C above 25°C (crystalline silicon)
  const tempCoeff = -0.004;

  // Convert 24 hourly values to 48 half-hourly kWh values
  const halfHourly = new Array(48).fill(0);
  for (let h = 0; h < 24 && h < ghi.length; h++) {
    const irr = Math.max(0, ghi[h]); // W/m² on horizontal
    const cellTemp = (temp[h] || 15) + irr * 0.03; // NOCT approximation
    const tempDerate = 1 + tempCoeff * Math.max(0, cellTemp - 25);
    // kWh for this hour = (W/m² / 1000) * kWp * transposition * perfRatio * tempDerate * 1hr
    const hourOutput = (irr / 1000) * kWp * transposition * perfRatio * Math.max(0.7, tempDerate);
    // Split evenly into two half-hour slots
    halfHourly[h * 2] = hourOutput / 2;
    halfHourly[h * 2 + 1] = hourOutput / 2;
  }
  return halfHourly;
}

// Compute monthly solar stats from real irradiance data
function monthlySolarStats(solarDays, kWp, tilt, azimuth) {
  const stats = Array.from({length: 12}, () => ({
    days: 0, totalKWh: 0, peakDay: 0, worstDay: Infinity,
    avgDailyKWh: 0, totalGHI: 0,
    dailyOutputs: [], // array of 48-element arrays
  }));

  for (const [date, dayData] of Object.entries(solarDays)) {
    const m = parseInt(date.split("-")[1]) - 1;
    const output = dailySolarOutput(dayData, kWp, tilt, azimuth, m);
    const dayTotal = output.reduce((a, b) => a + b, 0);
    const dayGHI = dayData.ghi.reduce((a, b) => a + (b || 0), 0) / 1000; // kWh/m²

    stats[m].days++;
    stats[m].totalKWh += dayTotal;
    stats[m].totalGHI += dayGHI;
    stats[m].peakDay = Math.max(stats[m].peakDay, dayTotal);
    stats[m].worstDay = Math.min(stats[m].worstDay, dayTotal);
    stats[m].dailyOutputs.push(output);
  }

  for (const s of stats) {
    if (s.days > 0) {
      s.avgDailyKWh = s.totalKWh / s.days;
      if (s.worstDay === Infinity) s.worstDay = 0;
    }
  }

  return stats;
}

// ─── OCTOPUS API ─────────────────────────────────────────────────────────────

async function fetchAgileData(region, onProgress) {
  const tariffCode = `E-1R-${AGILE_PRODUCT}-${region}`;
  const baseUrl = `https://api.octopus.energy/v1/products/${AGILE_PRODUCT}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;

  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  // Test connectivity — capture the real error for diagnosis
  const testUrl = `${baseUrl}?page_size=2`;
  let testResp;
  try {
    testResp = await fetch(testUrl);
  } catch (fetchErr) {
    // Network error, CORS block, or CSP block
    throw new Error(`Fetch failed: ${fetchErr.message || "Network/CORS error"}. Upload a CSV instead.`);
  }
  if (!testResp.ok) {
    throw new Error(`API returned ${testResp.status} ${testResp.statusText}. Check region code.`);
  }
  onProgress && onProgress(0.05);

  const allResults = [];
  let fetched = 0;
  for (let m = 0; m < 12; m++) {
    const from = new Date(oneYearAgo);
    from.setMonth(oneYearAgo.getMonth() + m);
    const to = new Date(from);
    to.setMonth(from.getMonth() + 1);
    const periodFrom = from.toISOString().replace(/\.\d+Z/, "Z");
    const periodTo = to.toISOString().replace(/\.\d+Z/, "Z");
    try {
      const url = `${baseUrl}?period_from=${periodFrom}&period_to=${periodTo}&page_size=1500`;
      const resp = await fetch(url);
      if (resp.ok) { const data = await resp.json(); if (data.results) allResults.push(...data.results); }
    } catch (e) { /* skip month */ }
    fetched++;
    onProgress && onProgress(0.05 + fetched / 12 * 0.95);
    await new Promise(r => setTimeout(r, 150));
  }

  allResults.sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
  const seen = new Set();
  const deduped = allResults.filter(r => {
    if (seen.has(r.valid_from)) return false;
    seen.add(r.valid_from);
    return true;
  });

  return deduped;
}

// Organise API data into per-day arrays of 48 half-hourly prices
function organisePriceData(rawData) {
  const days = {};
  for (const rec of rawData) {
    const dt = new Date(rec.valid_from);
    // Group by UK date (UTC is close enough for this purpose)
    const dateKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({
      slot: dt.getUTCHours() * 2 + Math.floor(dt.getUTCMinutes() / 30),
      price: rec.value_inc_vat, // p/kWh including VAT
    });
  }
  // Only keep complete days (48 slots)
  const completeDays = {};
  for (const [date, slots] of Object.entries(days)) {
    if (slots.length >= 44) { // Allow small gaps
      const priceArr = new Array(48).fill(null);
      for (const s of slots) {
        if (s.slot >= 0 && s.slot < 48) priceArr[s.slot] = s.price;
      }
      // Fill any gaps with neighbours
      for (let i = 0; i < 48; i++) {
        if (priceArr[i] === null) {
          priceArr[i] = priceArr[i-1] || priceArr[i+1] || 15;
        }
      }
      completeDays[date] = priceArr;
    }
  }
  return completeDays;
}

// Compute monthly stats from real data
function monthlyPriceStats(dayData) {
  const monthStats = Array.from({length: 12}, () => ({
    days: 0, totalSlots: 0, sumPrice: 0, minPrice: Infinity, maxPrice: -Infinity,
    avgProfile: new Array(48).fill(0),
    allDayPrices: [],
  }));

  for (const [date, prices] of Object.entries(dayData)) {
    const m = parseInt(date.split("-")[1]) - 1;
    monthStats[m].days++;
    monthStats[m].allDayPrices.push(prices);
    for (let i = 0; i < 48; i++) {
      const p = prices[i];
      monthStats[m].sumPrice += p;
      monthStats[m].totalSlots++;
      monthStats[m].avgProfile[i] += p;
      if (p < monthStats[m].minPrice) monthStats[m].minPrice = p;
      if (p > monthStats[m].maxPrice) monthStats[m].maxPrice = p;
    }
  }

  for (const ms of monthStats) {
    if (ms.days > 0) {
      ms.avgProfile = ms.avgProfile.map(v => v / ms.days);
      ms.avgPrice = ms.sumPrice / ms.totalSlots;
    } else {
      ms.avgPrice = 20;
      ms.minPrice = 5;
      ms.maxPrice = 45;
    }
  }

  return monthStats;
}

// ─── FINANCE ─────────────────────────────────────────────────────────────────

function calcMP(principal, rate, years) {
  if (principal <= 0) return 0;
  if (rate <= 0) return principal / (years * 12);
  const r = rate / 100 / 12, n = years * 12;
  return principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n) - 1);
}

function genAmort(principal, rate, years) {
  const mp = calcMP(principal, rate, years);
  const r = rate / 100 / 12;
  const sched = [];
  let bal = principal;
  for (let y = 1; y <= years; y++) {
    let yi=0, yp=0;
    for (let m = 0; m < 12; m++) {
      const interest = bal * (rate > 0 ? r : 0);
      const princ = mp - interest;
      yi += interest; yp += princ;
      bal = Math.max(0, bal - princ);
    }
    sched.push({year:y, interest:yi, principal:yp, balance:bal});
  }
  return sched;
}

// ─── USAGE DATA UPLOAD & PARSING ─────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = [];
    let inQuote = false, current = "";
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === delim.charAt(0) && !inQuote) { vals.push(current.trim()); current = ""; }
      else { current += ch; }
    }
    vals.push(current.trim());
    if (vals.length >= headers.length - 1) {
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] || ""; });
      rows.push(row);
    }
  }
  return rows;
}

function detectColumns(rows) {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);

  // Find consumption/value column
  const valCol = keys.find(k => /consumption|kwh|usage|value|reading|energy|amount/i.test(k))
    || keys.find(k => { const v = parseFloat(rows[0][k]); return !isNaN(v) && v >= 0 && v < 100; });

  // Find date/time columns
  const startCol = keys.find(k => /^start|start.?date|start.?time|date.?time|timestamp|date|time|period/i.test(k));
  const endCol = keys.find(k => /^end|end.?date|end.?time/i.test(k));

  // Detect interval from first two rows
  let intervalMins = 30; // default half-hourly
  if (startCol && rows.length >= 2) {
    const t1 = new Date(rows[0][startCol]);
    const t2 = new Date(rows[1][startCol]);
    if (!isNaN(t1) && !isNaN(t2)) {
      const diff = Math.abs(t2 - t1) / 60000;
      if (diff > 0 && diff < 1500) intervalMins = diff;
    }
  }

  return { valCol, startCol, endCol, intervalMins };
}

function processUsageData(rows, type) {
  const cols = detectColumns(rows);
  if (!cols || !cols.valCol || !cols.startCol) return null;

  // Parse into timestamped readings
  const readings = [];
  for (const row of rows) {
    const val = parseFloat(row[cols.valCol]);
    const dt = new Date(row[cols.startCol]);
    if (!isNaN(val) && val >= 0 && !isNaN(dt.getTime())) {
      readings.push({ dt, val });
    }
  }
  if (readings.length === 0) return null;

  readings.sort((a, b) => a.dt - b.dt);

  // Organise into per-day arrays of 48 half-hourly values
  const days = {};
  for (const r of readings) {
    const dateKey = `${r.dt.getFullYear()}-${String(r.dt.getMonth()+1).padStart(2,"0")}-${String(r.dt.getDate()).padStart(2,"0")}`;
    if (!days[dateKey]) days[dateKey] = new Array(48).fill(null);
    const slot = r.dt.getHours() * 2 + Math.floor(r.dt.getMinutes() / 30);
    if (slot >= 0 && slot < 48) {
      // If data is hourly, split into two half-hourly slots
      if (cols.intervalMins >= 55) {
        days[dateKey][slot] = (days[dateKey][slot] || 0) + r.val / 2;
        if (slot + 1 < 48) days[dateKey][slot + 1] = (days[dateKey][slot + 1] || 0) + r.val / 2;
      } else {
        days[dateKey][slot] = r.val;
      }
    }
  }

  // Interpolate missing data
  // 1. Build average profile from complete days
  const completeDays = Object.values(days).filter(d => d.filter(v => v !== null).length >= 40);
  const avgProfile = new Array(48).fill(0);
  if (completeDays.length > 0) {
    for (const d of completeDays) {
      for (let i = 0; i < 48; i++) avgProfile[i] += (d[i] || 0);
    }
    for (let i = 0; i < 48; i++) avgProfile[i] /= completeDays.length;
  }

  // 2. Fill gaps in each day
  for (const [date, slots] of Object.entries(days)) {
    const filledCount = slots.filter(v => v !== null).length;
    if (filledCount === 0) { delete days[date]; continue; }

    const dayTotal = slots.reduce((s, v) => s + (v || 0), 0);
    const avgDayTotal = avgProfile.reduce((s, v) => s + v, 0);

    for (let i = 0; i < 48; i++) {
      if (slots[i] === null) {
        // Short gap: linear interpolate from neighbours
        let prev = null, next = null;
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) { if (slots[j] !== null) { prev = { idx: j, val: slots[j] }; break; } }
        for (let j = i + 1; j <= Math.min(47, i + 4); j++) { if (slots[j] !== null) { next = { idx: j, val: slots[j] }; break; } }

        if (prev && next) {
          const frac = (i - prev.idx) / (next.idx - prev.idx);
          slots[i] = prev.val + frac * (next.val - prev.val);
        } else if (avgDayTotal > 0) {
          // Use profile shape scaled to this day's known total
          const scaleFactor = filledCount > 20 ? dayTotal / (avgDayTotal * filledCount / 48) : 1;
          slots[i] = avgProfile[i] * scaleFactor;
        } else {
          slots[i] = 0;
        }
      }
    }
  }

  // Compute monthly stats
  const monthStats = Array.from({length: 12}, () => ({
    days: 0, totalKWh: 0, avgProfile: new Array(48).fill(0), dailyProfiles: [],
  }));

  for (const [date, slots] of Object.entries(days)) {
    const m = parseInt(date.split("-")[1]) - 1;
    monthStats[m].days++;
    monthStats[m].totalKWh += slots.reduce((s, v) => s + v, 0);
    monthStats[m].dailyProfiles.push(slots);
    for (let i = 0; i < 48; i++) monthStats[m].avgProfile[i] += slots[i];
  }
  for (const ms of monthStats) {
    if (ms.days > 0) {
      ms.avgProfile = ms.avgProfile.map(v => v / ms.days);
      ms.avgDailyKWh = ms.totalKWh / ms.days;
    }
  }

  const totalDays = Object.keys(days).length;
  const totalKWh = Object.values(days).reduce((s, d) => s + d.reduce((a, v) => a + v, 0), 0);
  const annualKWh = totalDays > 0 ? totalKWh / totalDays * 365 : 0;

  return {
    type, days, monthStats, totalDays, totalKWh, annualKWh,
    avgProfile, intervalMins: cols.intervalMins,
    dateRange: { from: readings[0].dt, to: readings[readings.length - 1].dt },
  };
}

// ─── SIMULATION ENGINE ───────────────────────────────────────────────────────

function simulate(params, priceData, solarData, elecUsage, gasUsage, exportPriceData) {
  const {
    annualGas, annualElec, fixedElecRate, fixedGasRate, fixedElecStanding, fixedGasStanding,
    boilerEfficiency, solarKWp, batteryKWh, batteryPowerKW, batteryEfficiency,
    hpFlowTemp, exportRate, agileStanding, hotWaterKWhPerDay, solarTilt, solarAzimuth,
    battStrategy = "smart",
  } = params;

  const SOLAR_KWH_PER_KWP = correctedSolarKWh(solarTilt, solarAzimuth);
  const annualHotWaterGas = hotWaterKWhPerDay * 365;
  const annualHeatingGas = Math.max(0, annualGas - annualHotWaterGas);
  const annualUsefulHeat = annualHeatingGas * (boilerEfficiency / 100);
  const annualHotWaterHeat = annualHotWaterGas * (boilerEfficiency / 100);
  const totalHDD = UK_MONTHLY_TEMPS.reduce((s, t) => s + heatingDegrees(t) * 30, 0);

  const hasRealData = priceData && Object.keys(priceData.dayData).length > 100;
  const monthStats = hasRealData ? priceData.monthStats : null;
  const hasRealExportData = exportPriceData && Object.keys(exportPriceData.dayData).length > 100;
  const exportMonthStats = hasRealExportData ? exportPriceData.monthStats : null;
  const hasRealSolarData = solarData && solarData.days && Object.keys(solarData.days).length > 100;
  const hasRealElec = elecUsage && elecUsage.totalDays > 10;
  const hasRealGas = gasUsage && gasUsage.totalDays > 10;

  // ── Pre-compute blended monthly totals (real + gap-filled, scaled to annual target) ──
  const elecSeasonFactors = [1.15,1.1,1.0,0.9,0.85,0.8,0.8,0.85,0.95,1.05,1.1,1.15];
  const gasSeasonFactors = DAYS_IN_MONTH.map((d,m) => heatingDegrees(UK_MONTHLY_TEMPS[m]) * d);
  const gasSeasonTotal = gasSeasonFactors.reduce((a,b) => a+b, 0);

  // Build per-month usage: real where available, synthetic shape for gaps
  const elecMonthRaw = []; // raw kWh per month (before scaling)
  const elecMonthIsReal = [];
  const gasMonthRaw = [];
  const gasMonthIsReal = [];
  const elecProfilesPerMonth = []; // half-hourly profiles per month (array of 48-arrays)

  for (let m = 0; m < 12; m++) {
    const days = DAYS_IN_MONTH[m];
    // Electricity
    if (hasRealElec && elecUsage.monthStats[m].days > 0) {
      elecMonthRaw.push(elecUsage.monthStats[m].avgDailyKWh * days);
      elecMonthIsReal.push(true);
      elecProfilesPerMonth.push(elecUsage.monthStats[m].dailyProfiles);
    } else {
      elecMonthRaw.push((annualElec / 12) * elecSeasonFactors[m]);
      elecMonthIsReal.push(false);
      elecProfilesPerMonth.push(null);
    }
    // Gas
    if (hasRealGas && gasUsage.monthStats[m].days > 0) {
      gasMonthRaw.push(gasUsage.monthStats[m].avgDailyKWh * days);
      gasMonthIsReal.push(true);
    } else {
      const heating = gasSeasonTotal > 0 ? annualHeatingGas * gasSeasonFactors[m] / gasSeasonTotal : 0;
      gasMonthRaw.push(heating + annualHotWaterGas / 12);
      gasMonthIsReal.push(false);
    }
  }

  // Scale so totals match annual targets
  const elecRawTotal = elecMonthRaw.reduce((a,b) => a+b, 0);
  const elecScale = elecRawTotal > 0 ? annualElec / elecRawTotal : 1;
  const elecMonthScaled = elecMonthRaw.map(v => v * elecScale);

  const gasRawTotal = gasMonthRaw.reduce((a,b) => a+b, 0);
  const gasScale = gasRawTotal > 0 ? annualGas / gasRawTotal : 1;
  const gasMonthScaled = gasMonthRaw.map(v => v * gasScale);

  const results = {
    months: [], currentTotal: 0, newTotal: 0, solarGenerated: 0,
    solarSelfConsumed: 0, solarExported: 0, batteryArbitrageRevenue: 0,
    gridImport: 0, gridExport: 0, hpElectricity: 0, usingRealData: hasRealData,
    usingRealSolar: hasRealSolarData, usingRealElec: hasRealElec, usingRealGas: hasRealGas,
    realDataDays: hasRealData ? Object.keys(priceData.dayData).length : 0,
    realSolarDays: hasRealSolarData ? Object.keys(solarData.days).length : 0,
    negativeSlots: 0, peakAvg: 0, offpeakAvg: 0, dailyLog: [],
  };
  const dailyLog = results.dailyLog;
  let totalDayCount = 0;

  let totalPeakSlots = 0, totalPeakSum = 0, totalOffpeakSlots = 0, totalOffpeakSum = 0;

  for (let m = 0; m < 12; m++) {
    const days = DAYS_IN_MONTH[m];
    const temp = UK_MONTHLY_TEMPS[m];
    const hdd = heatingDegrees(temp);
    const copMult = hpFlowTemp >= 55 ? 0.85 : hpFlowTemp >= 50 ? 0.92 : 1.0;
    const cop = heatPumpCOP(temp) * copMult;

    // Current costs — blended real + synthetic, scaled to annual target
    const monthGas = gasMonthScaled[m];
    const monthElec = elecMonthScaled[m];
    const currentGasCost = monthGas * (fixedGasRate/100) + fixedGasStanding/100 * days;
    const currentElecCost = monthElec * (fixedElecRate/100) + fixedElecStanding/100 * days;
    const currentTotal = currentGasCost + currentElecCost;

    // Heat pump — derive useful heat from gas usage
    const monthHeatingGas = Math.max(0, monthGas - annualHotWaterGas / 12);
    const monthUsefulHeat = monthHeatingGas * (boilerEfficiency/100);
    const hwCOP = Math.max(2.0, cop * 0.7);
    const hpTotalElec = monthUsefulHeat / cop + (annualHotWaterHeat/12) / hwCOP;

    // Half-hourly electricity demand profiles — real (scaled) or synthetic
    const realProfiles = elecProfilesPerMonth[m];
    // If we have real profiles, scale them to match the target monthly total
    let scaledProfiles = null;
    if (realProfiles && realProfiles.length > 0) {
      const profileDayTotal = realProfiles.reduce((s, p) => s + p.reduce((a,b) => a+b, 0), 0) / realProfiles.length;
      const targetDayTotal = monthElec / days;
      const pScale = profileDayTotal > 0 ? targetDayTotal / profileDayTotal : 1;
      scaledProfiles = realProfiles.map(p => p.map(v => v * pScale));
    }

    // Solar: use real irradiance data if available
    const hasRealSolar = solarData && solarData.stats && solarData.stats[m].days > 0;
    const syntheticMonthSolar = solarKWp * SOLAR_KWH_PER_KWP[m];
    const solarProfile = generateSolarProfile(m, solarAzimuth);
    // Get real daily solar output arrays (48 half-hourly kWh values per day)
    let daySolarArrays;
    let monthSolar;
    if (hasRealSolar) {
      daySolarArrays = solarData.stats[m].dailyOutputs;
      monthSolar = solarData.stats[m].totalKWh / solarData.stats[m].days * days; // scale to full month
    } else {
      daySolarArrays = null;
      monthSolar = syntheticMonthSolar;
    }

    // Get price data for this month
    let dayPriceArrays;
    if (hasRealData && monthStats[m].days > 0) {
      dayPriceArrays = monthStats[m].allDayPrices;
    } else {
      const synth = generateSyntheticAgile(m);
      dayPriceArrays = Array.from({length: days}, () => synth);
    }

    // Get export price data for this month
    let dayExportPriceArrays;
    if (hasRealExportData && exportMonthStats[m].days > 0) {
      dayExportPriceArrays = exportMonthStats[m].allDayPrices;
    } else {
      dayExportPriceArrays = null; // will fall back to exportRate
    }

    let mGridImport=0, mGridExport=0, mGridCost=0, mExportRev=0, mSolarSelf=0, mBattArb=0;
    let mGridBatt=0, mBattHome=0, mBattExport=0, mSolarExport=0;
    let battSOC = batteryKWh * 0.5;
    const maxCR = batteryPowerKW * 0.5; // max charge/discharge per half-hour
    const bMin = batteryKWh * 0.05;
    const bMax = batteryKWh * 0.95;

    for (let d = 0; d < days; d++) {
      const dayPrices = dayPriceArrays[d % dayPriceArrays.length];
      const dayExportPrices = dayExportPriceArrays
        ? dayExportPriceArrays[d % dayExportPriceArrays.length]
        : null; // null = use fixed exportRate

      // Pre-calculate solar and demand for the day
      const daySolar = [], dayDemand = [];
      for (let s = 0; s < 48; s++) {
        const bd = scaledProfiles ? scaledProfiles[d % scaledProfiles.length][s] : (monthElec/days) * DEMAND_PROFILE[s];
        const hd = (hpTotalElec/days) * HEATING_PROFILE[s];
        const sg = daySolarArrays ? daySolarArrays[d % daySolarArrays.length][s] : (monthSolar/days) * solarProfile[s];
        daySolar.push(sg);
        dayDemand.push(bd + hd);
      }

      // Day-ahead: sort prices to find thresholds
      const sorted = dayPrices.slice().sort((a,b) => a - b);
      const cheapThresh = sorted[Math.min(9, sorted.length-1)]; // cheapest ~5h
      const expThresh = sorted[Math.max(0, sorted.length - 9)]; // most expensive ~5h

      for (let slot = 0; slot < 48; slot++) {
        const price = dayPrices[slot];
        const expPrice = dayExportPrices ? dayExportPrices[slot] : exportRate; // real half-hourly or fixed
        const solarGen = daySolar[slot];
        const totalDemand = dayDemand[slot];
        const solarDirect = Math.min(solarGen, totalDemand);
        let solarSurplus = Math.max(0, solarGen - totalDemand);
        let netDemand = Math.max(0, totalDemand - solarGen);
        mSolarSelf += solarDirect;

        if (price < 0) results.negativeSlots++;
        const h = slot / 2;
        if (h >= 16 && h < 19) { totalPeakSlots++; totalPeakSum += price; }
        else { totalOffpeakSlots++; totalOffpeakSum += price; }

        let slotGridHome = 0, slotGridBatt = 0, slotBattHome = 0, slotBattExport = 0, slotSolarExport = 0, slotSolarBatt = 0;
        const isCheap = price <= cheapThresh;
        const isExpensive = price >= expThresh;
        const medPrice = sorted[24]; // median price

        // ══ ALWAYS: Store solar surplus in battery first ══
        if (solarSurplus > 0 && battSOC < bMax) {
          const toStore = Math.min(solarSurplus, maxCR, (bMax - battSOC) / (batteryEfficiency/100));
          battSOC += toStore * (batteryEfficiency/100);
          solarSurplus -= toStore;
          slotSolarBatt = toStore;
        }

        // ══ ALWAYS: Export remaining solar surplus at export price ══
        if (solarSurplus > 0) {
          slotSolarExport = solarSurplus;
          mGridExport += solarSurplus;
          mSolarExport += solarSurplus;
          mExportRev += solarSurplus * (expPrice/100);
        }

        // ══ STRATEGY-DEPENDENT BATTERY DECISIONS ══
        if (battStrategy === "peak") {
          // PEAK SHAVING: Only discharge at 4-7pm peak, charge overnight
          if (h >= 16 && h < 19 && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency/100), netDemand);
            battSOC -= del / (batteryEfficiency/100);
            netDemand -= del; slotBattHome = del; mBattHome += del;
            mBattArb += del * (price/100);
          }
          if (h >= 16 && h < 19 && netDemand <= 0 && battSOC > bMin + 0.5) {
            const canExp = Math.min(maxCR, battSOC - bMin - 0.3);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency/100);
              battSOC -= canExp; slotBattExport = exp;
              mGridExport += exp; mBattExport += exp;
              mExportRev += exp * (expPrice/100); mBattArb += exp * (expPrice/100);
            }
          }
          if (isCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency/100));
            battSOC += c * (batteryEfficiency/100);
            slotGridBatt = c; mGridImport += c; mGridBatt += c;
            mGridCost += c * (price/100); mBattArb -= c * (price/100);
          }

        } else if (battStrategy === "smart") {
          // SMART ARBITRAGE: Use battery for home when cheaper than grid import
          // Calculate the average charge cost per kWh stored
          const avgChargeCost = cheapThresh; // approximate
          const dischargeCostThresh = avgChargeCost / (batteryEfficiency/100) * 1.1; // 10% margin

          // Discharge to home if current price > what we paid to charge + losses
          if (price > dischargeCostThresh && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency/100), netDemand);
            battSOC -= del / (batteryEfficiency/100);
            netDemand -= del; slotBattHome = del; mBattHome += del;
            mBattArb += del * (price/100);
          }
          // Export from battery when export price is profitable
          if (isExpensive && netDemand <= 0 && battSOC > bMin + 0.5) {
            const canExp = Math.min(maxCR, battSOC - bMin - 0.3);
            if (canExp > 0 && expPrice > dischargeCostThresh) {
              const exp = canExp * (batteryEfficiency/100);
              battSOC -= canExp; slotBattExport = exp;
              mGridExport += exp; mBattExport += exp;
              mExportRev += exp * (expPrice/100); mBattArb += exp * (expPrice/100);
            }
          }
          // Grid charge when cheap
          if (isCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency/100));
            battSOC += c * (batteryEfficiency/100);
            slotGridBatt = c; mGridImport += c; mGridBatt += c;
            mGridCost += c * (price/100); mBattArb -= c * (price/100);
          }

        } else if (battStrategy === "maxExport") {
          // MAXIMUM EXPORT: Aggressively charge cheap, export as much as possible at peak
          if (isCheap && battSOC < bMax - 0.1) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency/100));
            battSOC += c * (batteryEfficiency/100);
            slotGridBatt = c; mGridImport += c; mGridBatt += c;
            mGridCost += c * (price/100); mBattArb -= c * (price/100);
          }
          // Discharge to home at above-median price
          if (price > medPrice && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency/100), netDemand);
            battSOC -= del / (batteryEfficiency/100);
            netDemand -= del; slotBattHome = del; mBattHome += del;
            mBattArb += del * (price/100);
          }
          // Export at expensive prices
          if (isExpensive && battSOC > bMin + 0.3) {
            const canExp = Math.min(maxCR, battSOC - bMin - 0.2);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency/100);
              battSOC -= canExp; slotBattExport = exp;
              mGridExport += exp; mBattExport += exp;
              mExportRev += exp * (expPrice/100); mBattArb += exp * (expPrice/100);
            }
          }

        } else if (battStrategy === "solarFirst") {
          // SOLAR SELF-USE: Minimize grid, use battery for home whenever it saves importing
          // Discharge to home whenever there's net demand and battery has charge
          if (netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency/100), netDemand);
            battSOC -= del / (batteryEfficiency/100);
            netDemand -= del; slotBattHome = del; mBattHome += del;
            mBattArb += del * (price/100);
          }
          // Only grid-charge at very cheap prices (bottom 15%)
          const vCheap = sorted[Math.min(6, sorted.length-1)];
          if (price <= vCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency/100));
            battSOC += c * (batteryEfficiency/100);
            slotGridBatt = c; mGridImport += c; mGridBatt += c;
            mGridCost += c * (price/100); mBattArb -= c * (price/100);
          }
          // Export only when very expensive and home is powered
          if (isExpensive && netDemand <= 0 && battSOC > bMin + 1) {
            const canExp = Math.min(maxCR * 0.5, battSOC - bMin - 1);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency/100);
              battSOC -= canExp; slotBattExport = exp;
              mGridExport += exp; mBattExport += exp;
              mExportRev += exp * (expPrice/100); mBattArb += exp * (expPrice/100);
            }
          }
        }

        // ══ ALWAYS: Remaining demand from grid ══
        if (netDemand > 0) {
          slotGridHome = netDemand;
          mGridImport += netDemand;
          mGridCost += netDemand * (price/100);
        }

        dailyLog.push({
          m, day: totalDayCount, slot, price, expPrice, battSOC, totalDemand,
          solarGen, solarDirect, gridHome: slotGridHome, gridBatt: slotGridBatt,
          solarBatt: slotSolarBatt, battHome: slotBattHome, battExport: slotBattExport, solarExport: slotSolarExport,
        });
      }
      totalDayCount++;
    }

    const newElecCost = mGridCost + (agileStanding/100)*days - mExportRev;

    results.months.push({
      month: MONTHS[m], days, temp, cop: cop.toFixed(2),
      gasUsage: monthGas, elecUsage: monthElec, currentGasCost, currentElecCost, currentTotal,
      hpElec: hpTotalElec, baseElec: monthElec,
      solarGen: monthSolar, solarSelfConsumed: mSolarSelf,
      gridImport: mGridImport, gridExport: mGridExport,
      gridBatt: mGridBatt, battHome: mBattHome, battExport: mBattExport, solarExport: mSolarExport,
      exportRevenue: mExportRev, batteryArbitrage: mBattArb,
      newElecCost, newTotal: newElecCost,
      avgPrice: hasRealData && monthStats[m].days > 0 ? monthStats[m].avgPrice : null,
      minPrice: hasRealData && monthStats[m].days > 0 ? monthStats[m].minPrice : null,
      maxPrice: hasRealData && monthStats[m].days > 0 ? monthStats[m].maxPrice : null,
      realDays: hasRealData ? monthStats[m].days : 0,
    });

    results.currentTotal += currentTotal;
    results.newTotal += newElecCost;
    results.solarGenerated += monthSolar;
    results.solarSelfConsumed += mSolarSelf;
    results.solarExported += mGridExport;
    results.batteryArbitrageRevenue += mBattArb;
    results.gridImport += mGridImport;
    results.gridExport += mGridExport;
    results.hpElectricity += hpTotalElec;
  }

  results.annualSaving = results.currentTotal - results.newTotal;
  results.peakAvg = totalPeakSlots > 0 ? totalPeakSum / totalPeakSlots : 0;
  results.offpeakAvg = totalOffpeakSlots > 0 ? totalOffpeakSum / totalOffpeakSlots : 0;
  return results;
}

// ─── STYLES & COMPONENTS ─────────────────────────────────────────────────────

const C = {
  bg:"#0b1120",card:"#111827",border:"#1e293b",
  accent:"#22d3ee",accentDim:"rgba(34,211,238,0.12)",
  green:"#34d399",greenDim:"rgba(52,211,153,0.12)",
  red:"#f87171",redDim:"rgba(248,113,113,0.10)",
  orange:"#fb923c",orangeDim:"rgba(251,146,60,0.12)",
  yellow:"#fbbf24",yellowDim:"rgba(251,191,36,0.12)",
  purple:"#a78bfa",purpleDim:"rgba(167,139,250,0.12)",
  blue:"#60a5fa",blueDim:"rgba(96,165,250,0.12)",
  text:"#e2e8f0",dim:"#94a3b8",muted:"#64748b",
};
const mono = "'JetBrains Mono','Fira Code',monospace";
const inputSt = {
  background:"#1e293b",border:"1px solid #334155",borderRadius:6,
  color:C.text,padding:"6px 10px",fontSize:13,width:"100%",
  boxSizing:"border-box",outline:"none",fontFamily:mono,
};

// Custom range brush — syncs all charts, no re-render during drag
function RangeBrush({total, start, end, onChange, color=C.accent}) {
  const trackRef = useRef(null);
  const loRef = useRef(null);
  const hiRef = useRef(null);
  const winRef = useRef(null);
  const outlineRef = useRef(null);
  const loLabel = useRef(null);
  const hiLabel = useRef(null);
  const dragRef = useRef(null); // {type, panX, panS, panE}
  const liveRef = useRef({s: start, e: end});

  useEffect(() => { liveRef.current = {s: start, e: end}; }, [start, end]);

  const updateDOM = useCallback(() => {
    const {s, e} = liveRef.current;
    if (!trackRef.current) return;
    const lp = total > 0 ? (s / total) * 100 : 0;
    const rp = total > 0 ? (e / total) * 100 : 100;
    if (loRef.current) loRef.current.style.left = `calc(${lp}% - 7px)`;
    if (hiRef.current) hiRef.current.style.left = `calc(${rp}% - 7px)`;
    if (winRef.current) { winRef.current.style.left = `${lp}%`; winRef.current.style.width = `${rp-lp}%`; }
    if (outlineRef.current) { outlineRef.current.style.left = `${lp}%`; outlineRef.current.style.width = `${rp-lp}%`; }
    if (loLabel.current) { loLabel.current.style.left = `${lp}%`; loLabel.current.textContent = Math.floor(s/48)+1; }
    if (hiLabel.current) { hiLabel.current.style.right = `${100-rp}%`; hiLabel.current.textContent = Math.ceil(e/48); }
  }, [total]);

  const pxToIdx = useCallback((clientX) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total);
  }, [total]);

  const onDown = useCallback((which, e) => {
    e.preventDefault(); e.stopPropagation();
    const cx = e.clientX;
    dragRef.current = {type: which, panX: cx, panS: liveRef.current.s, panE: liveRef.current.e};
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
  }, []);

  const onMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const cx = e.clientX;
    const {s, e: en} = liveRef.current;
    if (d.type === "lo") {
      const v = pxToIdx(cx);
      liveRef.current.s = Math.max(0, Math.min(v, en - 24));
    } else if (d.type === "hi") {
      const v = pxToIdx(cx);
      liveRef.current.e = Math.min(total, Math.max(v, s + 24));
    } else if (d.type === "pan") {
      const rect = trackRef.current.getBoundingClientRect();
      const dIdx = Math.round(((cx - d.panX) / rect.width) * total);
      const span = d.panE - d.panS;
      let ns = d.panS + dIdx;
      if (ns < 0) ns = 0;
      if (ns + span > total) ns = total - span;
      liveRef.current.s = ns;
      liveRef.current.e = ns + span;
    }
    updateDOM();
  }, [total, pxToIdx, updateDOM]);

  const onUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    onChange(liveRef.current.s, liveRef.current.e);
  }, [onChange]);

  const leftPct = total > 0 ? (start / total) * 100 : 0;
  const rightPct = total > 0 ? (end / total) * 100 : 100;

  return (
    <div ref={trackRef} style={{position:"relative",height:28,marginBottom:10,touchAction:"none",userSelect:"none"}}
      onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      <div style={{position:"absolute",top:8,left:0,right:0,height:12,borderRadius:6,background:"#1e293b"}}/>
      <div ref={winRef} style={{position:"absolute",top:8,left:`${leftPct}%`,width:`${rightPct-leftPct}%`,height:12,borderRadius:4,
        background:color,opacity:0.15,cursor:"grab"}}
        onPointerDown={e=>onDown("pan",e)}/>
      <div ref={outlineRef} style={{position:"absolute",top:7,left:`${leftPct}%`,width:`${rightPct-leftPct}%`,height:14,borderRadius:4,
        border:`1.5px solid ${color}`,opacity:0.5,pointerEvents:"none"}}/>
      <div ref={loRef} onPointerDown={e=>onDown("lo",e)}
        style={{position:"absolute",top:4,left:`calc(${leftPct}% - 7px)`,width:14,height:20,borderRadius:4,
          background:color,cursor:"ew-resize",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{width:2,height:8,background:C.bg,borderRadius:1}}/>
      </div>
      <div ref={hiRef} onPointerDown={e=>onDown("hi",e)}
        style={{position:"absolute",top:4,left:`calc(${rightPct}% - 7px)`,width:14,height:20,borderRadius:4,
          background:color,cursor:"ew-resize",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{width:2,height:8,background:C.bg,borderRadius:1}}/>
      </div>
      <div ref={loLabel} style={{position:"absolute",top:0,left:`${leftPct}%`,transform:"translateX(-50%)",fontSize:7,color:C.dim}}>
        {Math.floor(start/48)+1}
      </div>
      <div ref={hiLabel} style={{position:"absolute",top:0,right:`${100-rightPct}%`,transform:"translateX(50%)",fontSize:7,color:C.dim}}>
        {Math.ceil(end/48)}
      </div>
    </div>
  );
}

// Wrapper that prevents parent scroll from stealing touch events on chart brush
function TouchChart({children, height}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e) => { e.preventDefault(); };
    el.addEventListener("touchmove", handler, {passive: false});
    return () => el.removeEventListener("touchmove", handler);
  }, []);
  return <div ref={ref} style={{width:"100%",height,touchAction:"none"}}>{children}</div>;
}

function Slider({label,unit,value,onChange,min,max,step,color=C.accent,prefix="",clampMode,onCycleClamp,clampMin,clampMax,onClampChange}) {
  const trackRef = useRef(null);
  const [drag, setDrag] = useState(null); // "lo"|"hi"|null
  const pct = ((value-min)/(max-min))*100;
  const isFixed = clampMode === "fixed";
  const isClamped = clampMode === "clamp" && clampMin != null && clampMax != null;
  const cLeftPct = isClamped ? Math.max(0, ((clampMin - min) / (max - min)) * 100) : 0;
  const cRightPct = isClamped ? Math.min(100, ((clampMax - min) / (max - min)) * 100) : 100;

  const pctToVal = useCallback((clientX) => {
    if (!trackRef.current) return value;
    const rect = trackRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + frac * (max - min);
    return Math.max(min, Math.min(max, Math.round(raw / step) * step));
  }, [min, max, step, value]);

  const onPointerDown = useCallback((which, e) => {
    e.preventDefault(); e.stopPropagation();
    setDrag(which);
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!drag || !onClampChange) return;
    const v = pctToVal(e.clientX);
    if (drag === "lo") onClampChange(Math.min(v, clampMax != null ? clampMax : max), clampMax);
    else if (drag === "hi") onClampChange(clampMin, Math.max(v, clampMin != null ? clampMin : min));
  }, [drag, pctToVal, clampMin, clampMax, min, max, onClampChange]);

  const onPointerUp = useCallback(() => setDrag(null), []);

  const dotStyle = (leftPct, col, size) => ({
    position:"absolute", top: 3 - size/2, left: `calc(${leftPct}% - ${size/2}px)`,
    width: size, height: size, borderRadius: "50%", background: col,
    border: `2px solid ${C.bg}`, zIndex: 5, cursor: "pointer",
    boxShadow: `0 0 4px ${col}55`, touchAction: "none",
  });

  return (
    <div style={{marginBottom:14,opacity:isFixed?0.45:1}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          {onCycleClamp && (
            <button onClick={onCycleClamp} style={{
              background:isFixed?"rgba(248,113,113,0.15)":isClamped?"rgba(251,191,36,0.15)":"rgba(52,211,153,0.12)",
              border:`1px solid ${isFixed?"rgba(248,113,113,0.3)":isClamped?"rgba(251,191,36,0.3)":"rgba(52,211,153,0.25)"}`,
              borderRadius:4,padding:"1px 5px",cursor:"pointer",
              fontSize:8,fontWeight:700,lineHeight:"16px",
              color:isFixed?C.red:isClamped?C.yellow:C.green,
            }}>{isFixed?"FIXED":isClamped?"CLAMP":"FREE"}</button>
          )}
          <span style={{fontSize:12,color:C.dim,letterSpacing:0.3}}>{label}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          {isClamped && <span style={{fontSize:9,color:C.yellow,fontFamily:mono}}>{clampMin}–{clampMax}</span>}
          <span style={{fontSize:13,color,fontFamily:mono,fontWeight:600}}>{prefix}{typeof value==="number"?value.toLocaleString():value}{unit}</span>
        </div>
      </div>
      <div ref={trackRef} style={{position:"relative",height:6,marginTop:isClamped?6:0,marginBottom:isClamped?6:0}}>
        {/* Base track */}
        <div style={{position:"absolute",top:0,left:0,right:0,height:6,borderRadius:3,background:"#334155",zIndex:0}}/>
        {/* Clamp zone */}
        {isClamped && (
          <div style={{position:"absolute",top:0,left:0,right:0,height:6,borderRadius:3,overflow:"hidden",zIndex:1,pointerEvents:"none"}}>
            <div style={{position:"absolute",left:0,width:`${cLeftPct}%`,height:"100%",background:"rgba(248,113,113,0.3)"}}/>
            <div style={{position:"absolute",left:`${cLeftPct}%`,width:`${Math.max(0,cRightPct-cLeftPct)}%`,height:"100%",background:"rgba(251,191,36,0.12)"}}/>
            <div style={{position:"absolute",right:0,width:`${Math.max(0,100-cRightPct)}%`,height:"100%",background:"rgba(248,113,113,0.3)"}}/>
          </div>
        )}
        {/* Value fill */}
        <div style={{position:"absolute",top:0,left:0,width:`${pct}%`,height:6,borderRadius:3,background:color,opacity:0.7,zIndex:2,pointerEvents:"none"}}/>
        {/* Value range input */}
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e=>!isFixed&&onChange(parseFloat(e.target.value))} disabled={isFixed}
          style={{width:"100%",height:6,borderRadius:3,appearance:"none",position:"relative",zIndex:3,
            background:"transparent",cursor:isFixed?"not-allowed":"pointer"}}/>
        {/* Clamp handles — draggable dots */}
        {isClamped && (
          <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
            style={{position:"absolute",top:-6,left:0,right:0,bottom:-6,zIndex:drag?10:4}}>
            <div onPointerDown={e=>onPointerDown("lo",e)}
              style={dotStyle(cLeftPct, C.yellow, 14)}/>
            <div onPointerDown={e=>onPointerDown("hi",e)}
              style={dotStyle(cRightPct, C.yellow, 14)}/>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({label,value,sub,color=C.accent,icon}) {
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",flex:1,minWidth:95}}>
      <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:4}}>{icon&&<span style={{marginRight:3}}>{icon}</span>}{label}</div>
      <div style={{fontSize:19,fontWeight:700,color,fontFamily:mono}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:C.dim,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function StackedBar({current,new_,months}) {
  const mx = Math.max(...current,...new_.map(Math.abs));
  return (
    <div style={{display:"flex",gap:3,alignItems:"flex-end",height:130}}>
      {months.map((m,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
          <div style={{display:"flex",gap:1,alignItems:"flex-end",width:"100%",height:114}}>
            <div style={{flex:1,borderRadius:"2px 2px 0 0",height:mx>0?Math.max(2,(current[i]/mx)*108):2,background:C.red,opacity:0.6}}/>
            <div style={{flex:1,borderRadius:"2px 2px 0 0",height:mx>0?Math.max(2,(Math.max(0,new_[i])/mx)*108):2,background:C.green,opacity:0.6}}/>
          </div>
          <div style={{fontSize:8,color:C.muted}}>{m}</div>
        </div>
      ))}
    </div>
  );
}

function RealPriceChart({monthStats, month}) {
  if (!monthStats || monthStats[month].days === 0) return null;
  const ms = monthStats[month];
  const profile = ms.avgProfile;
  const mx = Math.max(...profile);
  const mn = Math.min(...profile);
  const range = mx - mn || 1;
  return (
    <div style={{position:"relative",height:90}}>
      <svg width="100%" height="90" viewBox="0 0 480 90" preserveAspectRatio="none">
        {/* Min/max band */}
        {ms.allDayPrices.length > 1 && (() => {
          const minLine = new Array(48).fill(Infinity);
          const maxLine = new Array(48).fill(-Infinity);
          for (const dp of ms.allDayPrices) {
            for (let i = 0; i < 48; i++) {
              minLine[i] = Math.min(minLine[i], dp[i]);
              maxLine[i] = Math.max(maxLine[i], dp[i]);
            }
          }
          const topPts = maxLine.map((v,i) => `${(i/47)*480},${80-((v-mn)/range)*70}`).join(" ");
          const botPts = minLine.map((v,i) => `${(i/47)*480},${80-((v-mn)/range)*70}`).reverse().join(" ");
          return <polygon fill={C.orange} opacity="0.08" points={`${topPts} ${botPts}`}/>;
        })()}
        {/* Zero line if applicable */}
        {mn < 0 && <line x1="0" y1={80-((-mn)/range)*70} x2="480" y2={80-((-mn)/range)*70} stroke={C.muted} strokeWidth="0.5" strokeDasharray="3,3"/>}
        {/* Average line */}
        <polyline fill="none" stroke={C.orange} strokeWidth="2.5" opacity="0.9"
          points={profile.map((p,i) => `${(i/47)*480},${80-((p-mn)/range)*70}`).join(" ")}/>
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,marginTop:1}}>
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:30</span>
      </div>
    </div>
  );
}

function CumulativeChart({annualSaving,totalCost,financeMonthly,financeTerm,useFinance}) {
  const yrs = 20;
  const pts = [];
  let cum = useFinance ? 0 : -totalCost;
  for (let y = 0; y <= yrs; y++) {
    if (useFinance) cum += annualSaving - (y>0 && y<=financeTerm ? financeMonthly*12 : 0);
    else cum += y > 0 ? annualSaving : 0;
    pts.push({year:y,value:cum});
  }
  const minV=Math.min(...pts.map(p=>p.value)), maxV=Math.max(...pts.map(p=>p.value));
  const range=maxV-minV||1;
  const w=480,h=130,pad=18;
  const zY=pad+((maxV)/(range))*(h-2*pad);
  const beY = pts.find(p=>p.value>=0)?.year;
  return (
    <div>
      <svg width="100%" height={h+20} viewBox={`0 0 ${w} ${h+20}`} preserveAspectRatio="none">
        <line x1="0" y1={zY} x2={w} y2={zY} stroke={C.muted} strokeWidth="0.5" strokeDasharray="4,4"/>
        <polygon fill={C.green} opacity="0.08" points={`${pts.map((p,i)=>{
          const x=(i/yrs)*w,y=pad+((maxV-p.value)/range)*(h-2*pad);return`${x},${y}`;
        }).join(" ")} ${w},${zY} 0,${zY}`}/>
        <polyline fill="none" stroke={C.green} strokeWidth="2.5" points={pts.map((p,i)=>{
          const x=(i/yrs)*w,y=pad+((maxV-p.value)/range)*(h-2*pad);return`${x},${y}`;
        }).join(" ")}/>
        {beY!=null&&<span>
          <line x1={(beY/yrs)*w} y1={pad-4} x2={(beY/yrs)*w} y2={h-pad+4} stroke={C.accent} strokeWidth="1" strokeDasharray="3,3"/>
          <text x={(beY/yrs)*w} y={pad-7} fill={C.accent} fontSize="10" textAnchor="middle" fontFamily={mono}>Yr {beY}</text>
        </span>}
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,marginTop:-2}}>
        {[0,5,10,15,20].map(y=><span key={y}>Y{y}</span>)}
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────

export default function EnergySimulator() {
  const [annualGas,setAnnualGas]=useState(12000);
  const [annualElec,setAnnualElec]=useState(3100);
  const [fixedElecRate,setFixedElecRate]=useState(24.5);
  const [fixedGasRate,setFixedGasRate]=useState(6.76);
  const [fixedElecStanding,setFixedElecStanding]=useState(53.35);
  const [fixedGasStanding,setFixedGasStanding]=useState(31.43);
  const [boilerEfficiency,setBoilerEfficiency]=useState(90);
  const [hotWaterKWhPerDay,setHotWaterKWhPerDay]=useState(10);

  const [solarKWp,setSolarKWp]=useState(4.0);
  const [solarTilt,setSolarTilt]=useState(35);
  const [solarAzimuth,setSolarAzimuth]=useState(180);
  const [batteryKWh,setBatteryKWh]=useState(10.0);
  const [batteryPowerKW,setBatteryPowerKW]=useState(5.0);
  const [batteryEfficiency,setBatteryEfficiency]=useState(90);
  const [hpFlowTemp,setHpFlowTemp]=useState(45);
  const [exportRate,setExportRate]=useState(15);
  const [agileStanding,setAgileStanding]=useState(46.36);
  const [battStrategy,setBattStrategy]=useState("smart");
  const [agileExportRaw,setAgileExportRaw]=useState(null); // "peak"|"smart"|"maxExport"|"solarFirst"

  const [hpCost,setHpCost]=useState(12000);
  const [solarCost,setSolarCost]=useState(6000);
  const [batteryCost,setBatteryCost]=useState(5500);
  const [installCost,setInstallCost]=useState(3500);
  const [scaffolding,setScaffolding]=useState(800);
  const [busGrant,setBusGrant]=useState(7500);

  // Per-unit cost rates for linear scaling
  const solarRateRef = useRef(6000 / 4.0); // £/kWp = initial cost / initial kWp
  const battRateRef = useRef(5500 / 10.0); // £/kWh = initial cost / initial kWh
  const autoScaling = useRef(false);

  // When user manually changes cost slider → update the per-unit rate
  const handleSolarCostChange = useCallback((v) => {
    if (!autoScaling.current && solarKWp > 0) solarRateRef.current = v / solarKWp;
    setSolarCost(v);
  }, [solarKWp]);
  const handleBatteryCostChange = useCallback((v) => {
    if (!autoScaling.current && batteryKWh > 0) battRateRef.current = v / batteryKWh;
    setBatteryCost(v);
  }, [batteryKWh]);

  // Auto-scale costs when capacity changes
  useEffect(() => {
    autoScaling.current = true;
    setSolarCost(solarKWp > 0 ? Math.round(solarKWp * solarRateRef.current / 250) * 250 : 0);
    // Auto-zero BUS grant if no solar and no battery
    if (solarKWp === 0 && batteryKWh === 0) setBusGrant(0);
    autoScaling.current = false;
  }, [solarKWp]);

  useEffect(() => {
    autoScaling.current = true;
    setBatteryCost(batteryKWh > 0 ? Math.round(batteryKWh * battRateRef.current / 250) * 250 : 0);
    if (solarKWp === 0 && batteryKWh === 0) setBusGrant(0);
    autoScaling.current = false;
  }, [batteryKWh]);
  const [useFinance,setUseFinance]=useState(false);
  const [financeRate,setFinanceRate]=useState(7.9);
  const [financeTerm,setFinanceTerm]=useState(10);
  const [deposit,setDeposit]=useState(0);

  const [activeTab,setActiveTab]=useState("overview");
  const [selectedMonth,setSelectedMonth]=useState(0);
  const [showFinInTabs,setShowFinInTabs]=useState(true);

  // Parameter clamps: {key: {mode: "free"|"clamp"|"fixed", min, max}}
  const [clamps, setClamps] = useState({});
  const getClamp = useCallback((key, paramMin, paramMax) => {
    const c = clamps[key];
    if (!c || c.mode === "free") return { mode: "free", min: paramMin, max: paramMax };
    if (c.mode === "fixed") return { mode: "fixed", min: c.min, max: c.min }; // min=max=current
    return { mode: "clamp", min: c.min != null ? c.min : paramMin, max: c.max != null ? c.max : paramMax };
  }, [clamps]);
  const cycleClamp = useCallback((key, currentVal, paramMin, paramMax) => {
    setClamps(prev => {
      const c = prev[key];
      if (!c || c.mode === "free") return {...prev, [key]: {mode: "clamp", min: paramMin, max: paramMax}};
      if (c.mode === "clamp") return {...prev, [key]: {mode: "fixed", min: currentVal, max: currentVal}};
      return {...prev, [key]: {mode: "free", min: paramMin, max: paramMax}};
    });
  }, []);

  // Optimizer state
  const [optimizing, setOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState(0);
  const [optResult, setOptResult] = useState(null);
  const [optGenerations, setOptGenerations] = useState(50);
  const [bestEverCost, setBestEverCost] = useState(null);
  const [optTarget, setOptTarget] = useState("monthly");
  const [chartHidden, setChartHidden] = useState({});
  const [detailMonth, setDetailMonth] = useState(6);
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(144); // 3 days of half-hours // default to July (summer, more interesting) // 3 days default // "monthly"|"annualReturn"|"roi20"|"netMonthly"

  // Agile data
  const [region,setRegion]=useState("C");
  const [agileRaw,setAgileRaw]=useState(null);
  const [loadError,setLoadError]=useState(null);
  const [exportLoadError,setExportLoadError]=useState(null);

  // Location & solar irradiance data
  const [lat,setLat]=useState(51.5);
  const [lon,setLon]=useState(-0.12);
  const [solarRaw,setSolarRaw]=useState(null);
  const [solarError,setSolarError]=useState(null);

  // Uploaded usage data
  const [elecUsageData,setElecUsageData]=useState(null);
  const [gasUsageData,setGasUsageData]=useState(null);
  const [uploadStatus,setUploadStatus]=useState({elec:null,gas:null});

  const handleFileUpload = useCallback((file, type) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const rows = parseCSV(e.target.result);
        if (rows.length < 10) throw new Error("Too few rows — need at least 10 data points");
        const processed = processUsageData(rows, type);
        if (!processed) throw new Error("Could not detect date and consumption columns");
        // Show which months have real data
        const coveredMonths = processed.monthStats
          .map((ms, i) => ms.days > 0 ? ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i] : null)
          .filter(Boolean);
        const gapMonths = 12 - coveredMonths.length;
        const coverageMsg = `${processed.totalDays}d loaded (${coveredMonths.join(", ")}). ${gapMonths > 0 ? gapMonths + " months estimated to match your annual target." : "Full year!"}`;
        if (type === "electricity") {
          setElecUsageData(processed);
          setUploadStatus(s => ({...s, elec: coverageMsg}));
        } else {
          setGasUsageData(processed);
          setUploadStatus(s => ({...s, gas: coverageMsg}));
        }
      } catch (err) {
        setUploadStatus(s => ({...s, [type==="electricity"?"elec":"gas"]: `Error: ${err.message}`}));
      }
    };
    reader.readAsText(file);
  }, []);

  // Agile price CSV upload handler
  const handleAgileCSV = useCallback((file, isExport) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        let records;

        // Try JSON first (Octopus API response)
        try {
          const json = repairJSON(text);
          records = json.results || json;
          if (!Array.isArray(records) || records.length === 0) throw new Error("no array");
          if (!records[0].valid_from && !records[0].valid_to) throw new Error("not octopus format");
        } catch {
          // Parse as CSV
          const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
          if (lines.length < 48) throw new Error(`Only ${lines.length} lines — need 48+ for 1 day`);

          const firstFields = lines[0].split(",").map(f => f.trim().replace(/^"|"$/g, ""));
          const firstLooksLikeDate = /^\d{4}-\d{2}-\d{2}/.test(firstFields[0]);
          const startIdx = firstLooksLikeDate ? 0 : 1;

          records = [];
          for (let i = startIdx; i < lines.length; i++) {
            const fields = lines[i].split(",").map(f => f.trim().replace(/^"|"$/g, ""));
            if (fields.length < 2) continue;
            let dt = null;
            for (const f of fields) {
              if (/^\d{4}-\d{2}-\d{2}/.test(f)) { dt = f; break; }
            }
            let price = null;
            for (let j = fields.length - 1; j >= 0; j--) {
              const v = parseFloat(fields[j]);
              if (!isNaN(v) && v > -50 && v < 200) { price = v; break; }
            }
            if (dt && price !== null) {
              records.push({ valid_from: dt, value_inc_vat: price });
            }
          }
        }

        if (!records || records.length < 48) throw new Error(`Only ${records ? records.length : 0} valid records — need 48+ (1 day)`);

        const existing = isExport ? agileExportRaw : agileRaw;
        if (existing && existing.length > 0) {
          const existingSet = new Set(existing.map(r => r.valid_from));
          const newRecs = records.filter(r => !existingSet.has(r.valid_from));
          records = [...existing, ...newRecs].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
        }

        if (isExport) setAgileExportRaw(records);
        else setAgileRaw(records);
        const errFn = isExport ? setExportLoadError : setLoadError;
        errFn(`Loaded ${records.length} ${isExport?"export":"import"} records (${Math.round(records.length/48)} days)`);
      } catch (err) {
        const errFn = isExport ? setExportLoadError : setLoadError;
        errFn(`CSV error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, [agileRaw, agileExportRaw]);

  // Solar irradiance CSV upload handler (Open-Meteo export format)
  const handleSolarCSV = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        // Try JSON first (Open-Meteo API response)
        let solarDays;
        try {
          const json = JSON.parse(text);
          if (json.hourly && json.hourly.shortwave_radiation) {
            // Direct Open-Meteo JSON response
            const days = {};
            const times = json.hourly.time;
            const ghi = json.hourly.shortwave_radiation;
            const temp = json.hourly.temperature_2m || times.map(() => 12);
            const cloud = json.hourly.cloud_cover || times.map(() => 50);
            for (let i = 0; i < times.length; i++) {
              const dateKey = times[i].substring(0, 10);
              if (!days[dateKey]) days[dateKey] = {ghi:[],temp:[],cloud:[]};
              days[dateKey].ghi.push(ghi[i]||0);
              days[dateKey].temp.push(temp[i]||12);
              days[dateKey].cloud.push(cloud[i]||50);
            }
            // Filter complete days
            solarDays = {};
            for (const [d,v] of Object.entries(days)) {
              if (v.ghi.length >= 23) {
                while(v.ghi.length<24){v.ghi.push(0);v.temp.push(12);v.cloud.push(50);}
                solarDays[d]=v;
              }
            }
          } else throw new Error("not open-meteo json");
        } catch {
          // Parse as CSV (Open-Meteo CSV export has "time,shortwave_radiation,temperature_2m,cloud_cover")
          const rows = parseCSV(text);
          if (rows.length < 24) throw new Error("Too few rows");
          const keys = Object.keys(rows[0]);
          const ghiCol = keys.find(k => /shortwave|radiation|ghi|irradiance|solar/i.test(k));
          const tempCol = keys.find(k => /temperature|temp/i.test(k));
          const timeCol = keys.find(k => /time|date|timestamp/i.test(k));
          if (!ghiCol || !timeCol) throw new Error("Cannot find radiation and time columns");
          solarDays = {};
          for (const row of rows) {
            const dateKey = (row[timeCol]||"").substring(0,10);
            if (!dateKey || dateKey.length < 10) continue;
            if (!solarDays[dateKey]) solarDays[dateKey] = {ghi:[],temp:[],cloud:[]};
            solarDays[dateKey].ghi.push(parseFloat(row[ghiCol])||0);
            solarDays[dateKey].temp.push(parseFloat(row[tempCol]||"12")||12);
            solarDays[dateKey].cloud.push(50);
          }
          // Filter to complete days
          for (const [d,v] of Object.entries(solarDays)) {
            if (v.ghi.length < 23) delete solarDays[d];
            else while(v.ghi.length<24){v.ghi.push(0);v.temp.push(12);v.cloud.push(50);}
          }
        }
        if (!solarDays || Object.keys(solarDays).length < 7) throw new Error("Need at least 1 week of hourly solar data");
        setSolarRaw(solarDays);
        setSolarError(null);
      } catch (err) {
        setSolarError(`CSV error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const priceData = useMemo(() => {
    if (!agileRaw || agileRaw.length === 0) return null;
    const dayData = organisePriceData(agileRaw);
    const monthStats = monthlyPriceStats(dayData);
    return { dayData, monthStats };
  }, [agileRaw]);

  const exportPriceData = useMemo(() => {
    if (!agileExportRaw || agileExportRaw.length === 0) return null;
    const dayData = organisePriceData(agileExportRaw);
    const monthStats = monthlyPriceStats(dayData);
    return { dayData, monthStats };
  }, [agileExportRaw]);

  const solarDataProcessed = useMemo(() => {
    if (!solarRaw || Object.keys(solarRaw).length === 0) return null;
    const stats = monthlySolarStats(solarRaw, solarKWp, solarTilt, solarAzimuth);
    return { days: solarRaw, stats };
  }, [solarRaw, solarKWp, solarTilt, solarAzimuth]);

  // Paste data helpers
  const [pasteMode, setPasteMode] = useState(null); // "agile" | "export" | "solar" | null
  const [pasteText, setPasteText] = useState("");

  const agileApiUrl = useMemo(() => {
    const tc = `E-1R-${AGILE_PRODUCT}-${region}`;
    return `https://api.octopus.energy/v1/products/${AGILE_PRODUCT}/electricity-tariffs/${tc}/standard-unit-rates/?page_size=1500`;
  }, [region]);

  const agileMonthUrls = useMemo(() => {
    const tc = `E-1R-${AGILE_PRODUCT}-${region}`;
    const base = `https://api.octopus.energy/v1/products/${AGILE_PRODUCT}/electricity-tariffs/${tc}/standard-unit-rates/`;
    const now = new Date();
    const urls = [];
    for (let i = 11; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = from.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      urls.push({
        label,
        url: `${base}?period_from=${from.toISOString().split("T")[0]}T00:00Z&period_to=${to.toISOString().split("T")[0]}T00:00Z&page_size=1500`,
      });
    }
    return urls;
  }, [region]);

  const exportApiUrl = useMemo(() => {
    const tc = `E-1R-${AGILE_EXPORT_PRODUCT}-${region}`;
    return `https://api.octopus.energy/v1/products/${AGILE_EXPORT_PRODUCT}/electricity-tariffs/${tc}/standard-unit-rates/?page_size=1500`;
  }, [region]);

  const exportMonthUrls = useMemo(() => {
    const tc = `E-1R-${AGILE_EXPORT_PRODUCT}-${region}`;
    const base = `https://api.octopus.energy/v1/products/${AGILE_EXPORT_PRODUCT}/electricity-tariffs/${tc}/standard-unit-rates/`;
    const now = new Date();
    const urls = [];
    for (let i = 11; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = from.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      urls.push({ label, url: `${base}?period_from=${from.toISOString().split("T")[0]}T00:00Z&period_to=${to.toISOString().split("T")[0]}T00:00Z&page_size=1500` });
    }
    return urls;
  }, [region]);

  const solarApiUrl = useMemo(() => {
    const now = new Date();
    const ago = new Date(now); ago.setFullYear(now.getFullYear()-1);
    const end = new Date(now); end.setDate(end.getDate()-2);
    return `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${ago.toISOString().split("T")[0]}&end_date=${end.toISOString().split("T")[0]}&hourly=shortwave_radiation,temperature_2m&timezone=Europe%2FLondon`;
  }, [lat, lon]);

  const handlePasteLoad = useCallback(() => {
    if (!pasteText.trim()) return;
    try {
      if (pasteMode === "agile") {
        const json = repairJSON(pasteText);
        let records = json.results || json;
        if (!Array.isArray(records)) records = [records];
        records = records.filter(r => r && r.valid_from && (r.value_inc_vat !== undefined || r.value_exc_vat !== undefined));
        // If records don't have value_inc_vat, compute from exc_vat
        records = records.map(r => ({
          ...r,
          value_inc_vat: r.value_inc_vat != null ? r.value_inc_vat : (r.value_exc_vat || 0) * 1.05,
        }));
        if (records.length < 48) throw new Error(`Only ${records.length} valid records found — need at least 48 (1 day). Try copying more text.`);
        // Accumulate with existing data
        if (agileRaw && agileRaw.length > 0) {
          const existing = new Set(agileRaw.map(r => r.valid_from));
          const newRecords = records.filter(r => !existing.has(r.valid_from));
          records = [...agileRaw, ...newRecords].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
        }
        setAgileRaw(records);
        setLoadError(`Loaded ${records.length} import records (${Math.round(records.length/48)} days). Paste more to add data.`);
        setPasteMode(null); setPasteText("");
      } else if (pasteMode === "export") {
        const json = repairJSON(pasteText);
        let records = json.results || json;
        if (!Array.isArray(records)) records = [records];
        records = records.filter(r => r && r.valid_from && (r.value_inc_vat !== undefined || r.value_exc_vat !== undefined));
        records = records.map(r => ({
          ...r,
          value_inc_vat: r.value_inc_vat != null ? r.value_inc_vat : (r.value_exc_vat || 0) * 1.05,
        }));
        if (records.length < 48) throw new Error(`Only ${records.length} valid records found — need at least 48 (1 day).`);
        if (agileExportRaw && agileExportRaw.length > 0) {
          const existing = new Set(agileExportRaw.map(r => r.valid_from));
          const newRecords = records.filter(r => !existing.has(r.valid_from));
          records = [...agileExportRaw, ...newRecords].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
        }
        setAgileExportRaw(records);
        setExportLoadError(`Loaded ${records.length} export records (${Math.round(records.length/48)} days). Paste more to add data.`);
        setPasteMode(null); setPasteText("");
      } else if (pasteMode === "solar") {
        const json = repairJSON(pasteText);
        if (!json.hourly || !json.hourly.shortwave_radiation) throw new Error("Missing shortwave_radiation data — make sure you copied the full response");
        const days = {};
        const times = json.hourly.time;
        const ghi = json.hourly.shortwave_radiation;
        const temp = json.hourly.temperature_2m || times.map(() => 12);
        for (let i = 0; i < times.length; i++) {
          if (!times[i]) continue;
          const dk = times[i].substring(0, 10);
          if (!days[dk]) days[dk] = {ghi:[], temp:[], cloud:[]};
          days[dk].ghi.push(ghi[i]||0);
          days[dk].temp.push(temp[i]||12);
          days[dk].cloud.push(50);
        }
        const clean = {};
        for (const [d,v] of Object.entries(days)) {
          if (v.ghi.length >= 23) {
            while(v.ghi.length<24){v.ghi.push(0);v.temp.push(12);v.cloud.push(50);}
            clean[d] = v;
          }
        }
        // Merge with existing solar data
        const merged = solarRaw ? {...solarRaw, ...clean} : clean;
        if (Object.keys(merged).length < 3) throw new Error(`Only ${Object.keys(clean).length} complete days found. Try copying more text.`);
        setSolarRaw(merged);
        setSolarError(`Loaded ${Object.keys(merged).length} days of solar data. Paste more to add.`);
        setPasteMode(null); setPasteText("");
      }
    } catch (e) {
      if (pasteMode === "export") setExportLoadError("Paste error: " + e.message);
      else if (pasteMode === "agile") setLoadError("Paste error: " + e.message);
      else setSolarError("Paste error: " + e.message);
    }
  }, [pasteMode, pasteText, agileRaw, agileExportRaw, solarRaw]);

  // ── SAVE / LOAD STATE ──
  const saveState = useCallback(() => {
    const state = {
      v: 1, // version for future compat
      config: {
        annualGas, annualElec, fixedElecRate, fixedGasRate, fixedElecStanding, fixedGasStanding,
        boilerEfficiency, hotWaterKWhPerDay, solarKWp, solarTilt, solarAzimuth,
        batteryKWh, batteryPowerKW, batteryEfficiency, hpFlowTemp, exportRate, agileStanding,
        battStrategy,
        hpCost, solarCost, batteryCost, installCost, scaffolding, busGrant,
        useFinance, financeRate, financeTerm, deposit, region, lat, lon,
      },
      agileRaw: agileRaw || null,
      agileExportRaw: agileExportRaw || null,
      solarRaw: solarRaw || null,
      elecUsageData: elecUsageData || null,
      gasUsageData: gasUsageData || null,
      clamps: clamps || {},
    };
    const json = JSON.stringify(state);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `energy-sim-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [annualGas, annualElec, fixedElecRate, fixedGasRate, fixedElecStanding, fixedGasStanding,
    boilerEfficiency, hotWaterKWhPerDay, solarKWp, solarTilt, solarAzimuth,
    batteryKWh, batteryPowerKW, batteryEfficiency, hpFlowTemp, exportRate, agileStanding,
    hpCost, solarCost, batteryCost, installCost, scaffolding, busGrant,
    useFinance, financeRate, financeTerm, deposit, region, lat, lon,
    agileRaw, agileExportRaw, solarRaw, elecUsageData, gasUsageData, clamps]);

  const loadState = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const state = JSON.parse(e.target.result);
        const c = state.config || {};
        if (c.annualGas != null) setAnnualGas(c.annualGas);
        if (c.annualElec != null) setAnnualElec(c.annualElec);
        if (c.fixedElecRate != null) setFixedElecRate(c.fixedElecRate);
        if (c.fixedGasRate != null) setFixedGasRate(c.fixedGasRate);
        if (c.fixedElecStanding != null) setFixedElecStanding(c.fixedElecStanding);
        if (c.fixedGasStanding != null) setFixedGasStanding(c.fixedGasStanding);
        if (c.boilerEfficiency != null) setBoilerEfficiency(c.boilerEfficiency);
        if (c.hotWaterKWhPerDay != null) setHotWaterKWhPerDay(c.hotWaterKWhPerDay);
        if (c.solarKWp != null) setSolarKWp(c.solarKWp);
        if (c.solarTilt != null) setSolarTilt(c.solarTilt);
        if (c.solarAzimuth != null) setSolarAzimuth(c.solarAzimuth);
        if (c.batteryKWh != null) setBatteryKWh(c.batteryKWh);
        if (c.batteryPowerKW != null) setBatteryPowerKW(c.batteryPowerKW);
        if (c.batteryEfficiency != null) setBatteryEfficiency(c.batteryEfficiency);
        if (c.hpFlowTemp != null) setHpFlowTemp(c.hpFlowTemp);
        if (c.exportRate != null) setExportRate(c.exportRate);
        if (c.agileStanding != null) setAgileStanding(c.agileStanding);
        if (c.battStrategy) setBattStrategy(c.battStrategy);
        if (c.hpCost != null) setHpCost(c.hpCost);
        if (c.solarCost != null) setSolarCost(c.solarCost);
        if (c.batteryCost != null) setBatteryCost(c.batteryCost);
        if (c.installCost != null) setInstallCost(c.installCost);
        if (c.scaffolding != null) setScaffolding(c.scaffolding);
        if (c.busGrant != null) setBusGrant(c.busGrant);
        if (c.useFinance != null) setUseFinance(c.useFinance);
        if (c.financeRate != null) setFinanceRate(c.financeRate);
        if (c.financeTerm != null) setFinanceTerm(c.financeTerm);
        if (c.deposit != null) setDeposit(c.deposit);
        if (c.region) setRegion(c.region);
        if (c.lat != null) setLat(c.lat);
        if (c.lon != null) setLon(c.lon);
        if (state.agileRaw) setAgileRaw(state.agileRaw);
        if (state.agileExportRaw) setAgileExportRaw(state.agileExportRaw);
        if (state.solarRaw) setSolarRaw(state.solarRaw);
        if (state.elecUsageData) setElecUsageData(state.elecUsageData);
        if (state.gasUsageData) setGasUsageData(state.gasUsageData);
        if (state.clamps) setClamps(state.clamps); else if (state.locks) { const c = {}; for (const [k,v] of Object.entries(state.locks)) { c[k] = v ? {mode:"fixed",min:0,max:0} : {mode:"free"}; } setClamps(c); }
        setLoadError("State loaded successfully");
      } catch (err) {
        setLoadError("Failed to load: " + err.message);
      }
    };
    reader.readAsText(file);
  }, []);

  // ── OPTIMIZER (Differential Evolution) ──
  // Define all optimizable parameters with their bounds
  const paramDefs = useMemo(() => [
    {key:"solarKWp",label:"Solar kWp",min:0,max:12,step:0.5,get:()=>solarKWp,set:setSolarKWp,group:"energy"},
    {key:"solarTilt",label:"Tilt",min:0,max:90,step:5,get:()=>solarTilt,set:setSolarTilt,group:"energy"},
    {key:"solarAzimuth",label:"Azimuth",min:0,max:355,step:5,get:()=>solarAzimuth,set:setSolarAzimuth,group:"energy"},
    {key:"batteryKWh",label:"Battery kWh",min:0,max:25,step:0.5,get:()=>batteryKWh,set:setBatteryKWh,group:"energy"},
    {key:"batteryPowerKW",label:"Battery kW",min:1,max:12,step:0.5,get:()=>batteryPowerKW,set:setBatteryPowerKW,group:"energy"},
    {key:"batteryEfficiency",label:"Batt Eff%",min:80,max:98,step:1,get:()=>batteryEfficiency,set:setBatteryEfficiency,group:"energy"},
    {key:"hpFlowTemp",label:"HP Flow°C",min:35,max:55,step:5,get:()=>hpFlowTemp,set:setHpFlowTemp,group:"energy"},
    {key:"hpCost",label:"HP Cost",min:6000,max:18000,step:500,get:()=>hpCost,set:setHpCost,group:"cost"},
    {key:"deposit",label:"Deposit",min:0,max:30000,step:500,get:()=>deposit,set:setDeposit,group:"finance"},
    {key:"financeRate",label:"APR %",min:0,max:15,step:0.1,get:()=>financeRate,set:setFinanceRate,group:"finance"},
    {key:"financeTerm",label:"Term yrs",min:3,max:25,step:1,get:()=>financeTerm,set:setFinanceTerm,group:"finance"},
  ], [solarKWp,solarTilt,solarAzimuth,batteryKWh,batteryPowerKW,batteryEfficiency,
      hpFlowTemp,hpCost,deposit,financeRate,financeTerm]);

  const runOptimizer = useCallback(async () => {
    setOptimizing(true); setOptProgress(0);

    const active = paramDefs.filter(p => {
      const c = clamps[p.key];
      return !c || c.mode !== "fixed";
    });
    if (active.length === 0) { setOptResult("No free/clamped parameters — set some to FREE or CLAMP"); setOptimizing(false); return; }

    // Apply clamp ranges
    const bounds = active.map(p => {
      const c = clamps[p.key];
      if (c && c.mode === "clamp") return { min: c.min != null ? c.min : p.min, max: c.max != null ? c.max : p.max };
      return { min: p.min, max: p.max };
    });

    const dim = active.length;
    const popSize = Math.max(15, dim * 5);
    const maxGen = optGenerations;
    const numRestarts = 3; // run 3 independent populations, keep global best
    const gensPerRestart = Math.ceil(maxGen / numRestarts);

    const baseSimParams = {
      annualGas,annualElec,fixedElecRate,fixedGasRate,fixedElecStanding,fixedGasStanding,
      boilerEfficiency,solarKWp,batteryKWh,batteryPowerKW,batteryEfficiency,
      hpFlowTemp,exportRate,agileStanding,hotWaterKWhPerDay,solarTilt,solarAzimuth,
      battStrategy,
    };
    const baseCostParams = { hpCost, solarCost, batteryCost, installCost, scaffolding, busGrant };
    const baseFinParams = { deposit, financeRate, financeTerm, useFinance };
    const solarCostPerKWp = solarRateRef.current;
    const batteryCostPerKWh = battRateRef.current;

    const evaluate = (vec) => {
      const simP = {...baseSimParams};
      const costP = {...baseCostParams};
      const finP = {...baseFinParams};
      active.forEach((p, i) => {
        const snapped = Math.round(vec[i] / p.step) * p.step;
        const val = Math.max(bounds[i].min, Math.min(bounds[i].max, snapped));
        if (p.group === "energy") simP[p.key] = val;
        else if (p.group === "cost") costP[p.key] = val;
        else if (p.group === "finance") finP[p.key] = val;
      });
      costP.solarCost = simP.solarKWp * solarCostPerKWp;
      costP.batteryCost = simP.batteryKWh * batteryCostPerKWh;
      const res = simulate(simP, priceData, solarDataProcessed, elecUsageData, gasUsageData, exportPriceData);
      const gross = costP.hpCost + costP.solarCost + costP.batteryCost + costP.installCost + costP.scaffolding;
      const net = Math.max(0, gross - costP.busGrant);
      const finAmt = Math.max(0, net - (finP.deposit || 0));
      const totalFinCostE = finP.useFinance && finAmt > 0 && finP.financeTerm > 0
        ? calcMP(finAmt, finP.financeRate || 0, finP.financeTerm) * finP.financeTerm * 12 : 0;
      let mp = 0;
      if (finP.useFinance && finAmt > 0 && finP.financeTerm > 0) {
        mp = calcMP(finAmt, finP.financeRate || 0, finP.financeTerm);
      }
      const saving = res.annualSaving || (res.currentTotal - res.newTotal);
      const annFinCost = mp * 12;
      const finYrs = finP.useFinance ? Math.min(finP.financeTerm, 20) : 0;
      const totalSpent = finP.useFinance ? (finP.deposit||0) + annFinCost * finYrs : net;
      const totalSav = saving * 20;
      const profit = totalSav - totalSpent;
      const monthlyEnergy = res.newTotal / 12;
      const netMo = saving / 12 - mp;
      const annRet = totalSpent > 0 && totalSav > totalSpent ? (Math.pow(totalSav / totalSpent, 1/20) - 1) * 100 : -100;
      const r20 = totalSpent > 0 ? (profit / totalSpent) * 100 : -100;

      // Return score to MINIMIZE (lower = better)
      if (optTarget === "annualReturn") return -annRet; // maximize → negate
      if (optTarget === "roi20") return -r20;
      if (optTarget === "netMonthly") return -netMo; // maximize net savings/mo
      return monthlyEnergy + mp; // default: minimize monthly cost
    };

    const currentVec = active.map(p => p.get());
    const currentCost = evaluate(currentVec);
    let globalBest = { vec: currentVec.slice(), cost: currentCost };
    let totalEvals = 0;

    for (let restart = 0; restart < numRestarts; restart++) {
      // Initialize population — first restart seeds from current, rest are random
      const pop = [];
      for (let i = 0; i < popSize; i++) {
        let vec;
        if (i === 0 && restart === 0) {
          vec = currentVec.slice();
        } else if (i === 0 && globalBest.cost < Infinity) {
          // Seed each restart with global best + noise
          vec = globalBest.vec.map((v, d) => {
            const range = bounds[d].max - bounds[d].min;
            return Math.max(bounds[d].min, Math.min(bounds[d].max, v + (Math.random() - 0.5) * range * 0.3));
          });
        } else {
          vec = active.map((p,j) => bounds[j].min + Math.random() * (bounds[j].max - bounds[j].min));
        }
        const cost = evaluate(vec);
        pop.push({ vec, cost });
        totalEvals++;
      }

      let bestIdx = 0;
      pop.forEach((ind, i) => { if (ind.cost < pop[bestIdx].cost) bestIdx = i; });
      let stagnantGens = 0;
      let prevBest = pop[bestIdx].cost;

      for (let gen = 0; gen < gensPerRestart; gen++) {
        // Adaptive F and CR — jitter to explore more
        const F = 0.5 + Math.random() * 0.5; // F in [0.5, 1.0]
        const CR = 0.3 + Math.random() * 0.6; // CR in [0.3, 0.9]

        for (let i = 0; i < popSize; i++) {
          const idxs = [];
          while (idxs.length < 3) {
            const r = Math.floor(Math.random() * popSize);
            if (r !== i && !idxs.includes(r)) idxs.push(r);
          }

          // Mix strategies: 50% DE/rand/1, 50% DE/best/1
          const useCurrentBest = Math.random() < 0.5;
          const base = useCurrentBest ? pop[bestIdx].vec : pop[idxs[0]].vec;
          const diff1 = useCurrentBest ? pop[idxs[0]].vec : pop[idxs[1]].vec;
          const diff2 = useCurrentBest ? pop[idxs[1]].vec : pop[idxs[2]].vec;

          const mutant = base.map((v, d) => v + F * (diff1[d] - diff2[d]));
          const jrand = Math.floor(Math.random() * dim);
          const trial = pop[i].vec.map((v, d) => {
            if (d === jrand || Math.random() < CR) {
              return Math.max(bounds[d].min, Math.min(bounds[d].max, mutant[d]));
            }
            return v;
          });
          const trialCost = evaluate(trial);
          totalEvals++;
          if (trialCost <= pop[i].cost) {
            pop[i] = { vec: trial, cost: trialCost };
            if (trialCost < pop[bestIdx].cost) bestIdx = i;
          }
        }

        // Stagnation detection — reinject diversity
        if (Math.abs(pop[bestIdx].cost - prevBest) < 0.001) {
          stagnantGens++;
        } else {
          stagnantGens = 0;
          prevBest = pop[bestIdx].cost;
        }
        if (stagnantGens > 8) {
          // Replace worst 30% with random individuals
          const sorted = pop.map((p,i) => ({i, cost:p.cost})).sort((a,b) => b.cost - a.cost);
          const replaceCount = Math.ceil(popSize * 0.3);
          for (let k = 0; k < replaceCount; k++) {
            const ri = sorted[k].i;
            if (ri === bestIdx) continue;
            const vec = active.map((p,j) => bounds[j].min + Math.random() * (bounds[j].max - bounds[j].min));
            pop[ri] = { vec, cost: evaluate(vec) };
            totalEvals++;
          }
          stagnantGens = 0;
        }

        const totalProgress = (restart * gensPerRestart + gen + 1) / (numRestarts * gensPerRestart);
        if (gen % 3 === 0) {
          setOptProgress(totalProgress);
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // Update global best
      if (pop[bestIdx].cost < globalBest.cost) {
        globalBest = { vec: pop[bestIdx].vec.slice(), cost: pop[bestIdx].cost };
      }
    }

    const thresholdCost = bestEverCost != null ? Math.min(currentCost, bestEverCost) : currentCost;

    if (globalBest.cost < thresholdCost) {
      active.forEach((p, i) => {
        const snapped = Math.round(globalBest.vec[i] / p.step) * p.step;
        p.set(Math.max(p.min, Math.min(p.max, snapped)));
      });
      const bestSolarVal = active.find(p => p.key === "solarKWp");
      const bestBattVal = active.find(p => p.key === "batteryKWh");
      if (bestSolarVal && bestBattVal) {
        const sv = Math.round(bestSolarVal.get() / bestSolarVal.step) * bestSolarVal.step;
        const bv = Math.round(bestBattVal.get() / bestBattVal.step) * bestBattVal.step;
        if (sv === 0 && bv === 0) setBusGrant(0);
      }
      setBestEverCost(globalBest.cost);
      const targetNames = {monthly:"Monthly cost",annualReturn:"Annual return",roi20:"20Y ROI",netMonthly:"Net monthly"};
      const tname = targetNames[optTarget] || "Score";
      setOptResult(`Improved! ${tname}: ${globalBest.cost.toFixed(2)} (raw score). ${numRestarts} restarts, ${totalEvals.toLocaleString()} evals.`);
    } else {
      setOptResult(`No improvement found. ${numRestarts} restarts, ${totalEvals.toLocaleString()} evals. Try more generations or different target.`);
    }

    setOptProgress(1);
    setOptimizing(false);
  }, [paramDefs, clamps, optTarget, optGenerations, bestEverCost, annualGas, annualElec, fixedElecRate, fixedGasRate,
    fixedElecStanding, fixedGasStanding, boilerEfficiency, solarKWp, batteryKWh, batteryPowerKW,
    batteryEfficiency, hpFlowTemp, exportRate, agileStanding, hotWaterKWhPerDay, solarTilt, solarAzimuth,
    battStrategy,
    hpCost, solarCost, batteryCost, installCost, scaffolding, busGrant,
    deposit, financeRate, financeTerm, useFinance,
    priceData, solarDataProcessed, elecUsageData, gasUsageData, exportPriceData]);

  const results = useMemo(() => simulate({
    annualGas,annualElec,fixedElecRate,fixedGasRate,fixedElecStanding,fixedGasStanding,
    boilerEfficiency,solarKWp,batteryKWh,batteryPowerKW,batteryEfficiency,
    hpFlowTemp,exportRate,agileStanding,hotWaterKWhPerDay,solarTilt,solarAzimuth,
    battStrategy,
  }, priceData, solarDataProcessed, elecUsageData, gasUsageData, exportPriceData), [annualGas,annualElec,fixedElecRate,fixedGasRate,fixedElecStanding,fixedGasStanding,
    boilerEfficiency,solarKWp,batteryKWh,batteryPowerKW,batteryEfficiency,
    hpFlowTemp,exportRate,agileStanding,hotWaterKWhPerDay,solarTilt,solarAzimuth,
    battStrategy,priceData,solarDataProcessed,elecUsageData,gasUsageData,exportPriceData]);

  const grossCost=hpCost+solarCost+batteryCost+installCost+scaffolding;
  const netCost=Math.max(0,grossCost-busGrant);
  const financedAmt=Math.max(0,netCost-deposit);
  const mp=calcMP(financedAmt,financeRate,financeTerm);
  const totalFinCost=mp*financeTerm*12;
  const totalInterest=totalFinCost-financedAmt;
  const annualSaving=results.annualSaving;
  const annualFinanceCost = useFinance ? mp * 12 : 0;
  const netAnnualDuringFinance = annualSaving - annualFinanceCost;
  const netAnnualAfterFinance = annualSaving;
  const netMonthly = useFinance ? (annualSaving/12) - mp : (annualSaving/12);

  // Finance years within the 20-year window
  const finYears = useFinance ? Math.min(financeTerm, 20) : 0;
  const freeYears = 20 - finYears;

  // Total money spent over 20 years (your actual out-of-pocket)
  const totalSpent20Y = useFinance ? deposit + annualFinanceCost * finYears : netCost;
  // Total energy savings over 20 years
  const totalSavings20Y = annualSaving * 20;
  // Net profit = savings minus what you spent
  const profit20 = totalSavings20Y - totalSpent20Y;
  // ROI = profit / money spent
  const roi20 = totalSpent20Y > 0 ? (profit20 / totalSpent20Y) * 100 : 0;

  // Total outlay (for display: full lifetime cost of the system)
  const totalOutlay = useFinance ? totalFinCost + deposit : netCost;

  // CAGR: what compound rate turns totalSpent into totalSavings over 20 years
  const annualReturn = totalSpent20Y > 0 && totalSavings20Y > totalSpent20Y
    ? (Math.pow(totalSavings20Y / totalSpent20Y, 1/20) - 1) * 100
    : totalSpent20Y > 0 && totalSavings20Y > 0
      ? -((1 - Math.pow(totalSavings20Y / totalSpent20Y, 1/20)) * 100)
      : 0;

  // Simple return % per year
  const annRetDuringFin = totalOutlay > 0 ? (netAnnualDuringFinance / totalOutlay) * 100 : 0;
  const annRetAfterFin = totalOutlay > 0 ? (netAnnualAfterFinance / totalOutlay) * 100 : 0;

  // Break-even year (cumulative net cash from day 1)
  let breakEvenYear = null;
  let cumCash = useFinance ? -deposit : -netCost;
  for (let y = 1; y <= 25; y++) {
    const yearNet = y <= finYears ? netAnnualDuringFinance : netAnnualAfterFinance;
    cumCash += yearNet;
    if (cumCash >= 0 && breakEvenYear === null) {
      breakEvenYear = y;
    }
  }

  // Simple payback
  const simplePayback = useFinance
    ? (netAnnualDuringFinance > 0 ? deposit / netAnnualDuringFinance : (breakEvenYear || Infinity))
    : (annualSaving > 0 ? netCost / annualSaving : Infinity);

  const fmt=v=>`\u00A3${Math.abs(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,",")}`;
  const fmtD=v=>`\u00A3${v.toFixed(2)}`;
  const savPct=results.currentTotal>0?((annualSaving/results.currentTotal)*100).toFixed(0):0;

  const tabs = [
    {id:"overview",label:"Overview"},
    {id:"investment",label:"Investment"},
    {id:"config",label:"Energy"},
    {id:"detail",label:"30-Day"},
    {id:"yearly",label:"Yearly"},
    {id:"agile",label:"Agile Data"},
  ];

  return (
    <div style={{background:C.bg,color:C.text,minHeight:"100vh",fontFamily:"'Inter',-apple-system,sans-serif"}}>
      <style>{`
        .recharts-brush, .recharts-brush-slide, .recharts-brush-traveller,
        .recharts-brush rect, .recharts-brush-traveller rect,
        .recharts-surface { touch-action: none; }
      `}</style>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:${C.accent};cursor:pointer;border:2px solid ${C.bg};box-shadow:0 0 6px rgba(34,211,238,0.3)}
        input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:${C.accent};cursor:pointer;border:2px solid ${C.bg}}
        *{box-sizing:border-box}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}
        select{background:#1e293b;border:1px solid #334155;border-radius:6px;color:${C.text};padding:6px 10px;font-size:12px;outline:none;font-family:${mono}}
      `}</style>

      <div style={{padding:"16px 18px 12px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:17}}>⚡</span>
            <h1 style={{fontSize:16,fontWeight:800,margin:0,letterSpacing:-0.5}}>Energy Transition Simulator</h1>
          </div>
          <div style={{display:"flex",gap:4}}>
            <button onClick={saveState} title="Save all state to file" style={{
              background:"#1e293b",border:"1px solid #334155",borderRadius:6,
              padding:"4px 8px",fontSize:10,color:C.dim,cursor:"pointer",
            }}>💾</button>
            <label title="Load state from file" style={{
              background:"#1e293b",border:"1px solid #334155",borderRadius:6,
              padding:"4px 8px",fontSize:10,color:C.dim,cursor:"pointer",display:"inline-block",
            }}>📂<input type="file" accept=".json" style={{display:"none"}}
              onChange={e=>{if(e.target.files[0])loadState(e.target.files[0]);}}/></label>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <p style={{fontSize:11,color:C.muted,margin:0}}>Gas boiler + fixed → HP + solar + battery + Agile</p>
          {results.usingRealData && (
            <span style={{fontSize:8,color:C.green,background:C.greenDim,padding:"2px 6px",borderRadius:10,fontWeight:600}}>
              LIVE AGILE
            </span>
          )}
          {results.usingRealSolar && (
            <span style={{fontSize:8,color:C.yellow,background:C.yellowDim,padding:"2px 6px",borderRadius:10,fontWeight:600,marginLeft:4}}>
              LIVE SOLAR
            </span>
          )}
          {(results.usingRealElec || results.usingRealGas) && (
            <span style={{fontSize:8,color:C.purple,background:C.purpleDim,padding:"2px 6px",borderRadius:10,fontWeight:600,marginLeft:4}}>
              YOUR USAGE
            </span>
          )}
          {!results.usingRealData && !results.usingRealSolar && (
            <span style={{fontSize:8,color:C.orange,background:C.orangeDim,padding:"2px 6px",borderRadius:10,fontWeight:600}}>
              SYNTHETIC
            </span>
          )}
        </div>
      </div>

      <div style={{display:"flex",gap:6,padding:"12px 14px",overflowX:"auto"}}>
        <Stat label="Current" value={fmt(results.currentTotal)} sub="/year" color={C.red} icon="🔥"/>
        <Stat label="New" value={fmt(results.newTotal)} sub="/year" color={C.green} icon="🌿"/>
        <Stat label={useFinance?"Net/mo":"Saving"} value={useFinance?fmtD(netMonthly):fmt(annualSaving)}
          sub={useFinance?"after finance":`/yr (${savPct}%)`} color={netMonthly>0?C.accent:C.red} icon="💰"/>
      </div>

      {/* Monthly comparison banner */}
      {(()=>{
        const curMo = results.currentTotal / 12;
        const newEnergyMo = results.newTotal / 12;
        const finMo = useFinance ? mp : 0;
        const totalNewMo = newEnergyMo + finMo;
        const diff = curMo - totalNewMo;
        const isNoBrainer = useFinance && diff > 0;
        return (
          <div style={{padding:"0 14px 8px"}}>
            <div style={{background:isNoBrainer?"rgba(52,211,153,0.12)":C.card,
              border:`1px solid ${isNoBrainer?"rgba(52,211,153,0.3)":C.border}`,
              borderRadius:10,padding:"10px 12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:2}}>CURRENT MONTHLY</div>
                  <div style={{fontSize:16,fontWeight:700,fontFamily:mono,color:C.red}}>{fmtD(curMo)}</div>
                  <div style={{fontSize:8,color:C.dim}}>gas + electricity</div>
                </div>
                <div style={{fontSize:16,color:C.dim}}>→</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:2}}>NEW MONTHLY</div>
                  <div style={{fontSize:16,fontWeight:700,fontFamily:mono,color:totalNewMo<curMo?C.green:C.red}}>{fmtD(totalNewMo)}</div>
                  <div style={{fontSize:8,color:C.dim}}>energy {fmtD(newEnergyMo)}{useFinance?` + finance ${fmtD(finMo)}`:""}</div>
                </div>
                <div style={{flex:1,textAlign:"right"}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:2}}>{diff>0?"SAVING":"EXTRA"}</div>
                  <div style={{fontSize:16,fontWeight:700,fontFamily:mono,color:diff>0?C.green:C.red}}>{fmtD(Math.abs(diff))}/mo</div>
                  <div style={{fontSize:8,color:C.dim}}>{fmt(Math.abs(diff*12))}/yr</div>
                </div>
              </div>
              {isNoBrainer && (
                <div style={{marginTop:8,padding:"6px 10px",background:"rgba(52,211,153,0.15)",borderRadius:6,
                  fontSize:10,color:C.green,fontWeight:600,textAlign:"center"}}>
                  ✅ Costs less from day 1 — you save {fmtD(diff)}/mo even while paying the loan. No upfront cost needed.
                </div>
              )}
              {useFinance && diff < 0 && (
                <div style={{marginTop:8,padding:"6px 10px",background:"rgba(248,113,113,0.1)",borderRadius:6,
                  fontSize:10,color:C.dim,textAlign:"center"}}>
                  ⚠️ Costs {fmtD(Math.abs(diff))}/mo more during the {financeTerm}y loan, then saves {fmtD(annualSaving/12)}/mo after.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <div style={{display:"flex",gap:0,padding:"0 14px",borderBottom:`1px solid ${C.border}`,overflowX:"auto"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{
            background:"none",border:"none",color:activeTab===t.id?C.accent:C.muted,
            padding:"8px 10px",fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",
            borderBottom:activeTab===t.id?`2px solid ${C.accent}`:"2px solid transparent",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{padding:"12px 14px",maxHeight:"calc(100vh - 230px)",overflowY:"auto"}}>

        {/* ═══ OVERVIEW ═══ */}
        {activeTab==="overview"&&(
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <h3 style={{fontSize:12,fontWeight:600,margin:0}}>Monthly Cost Comparison</h3>
                <div style={{display:"flex",gap:8,fontSize:9,color:C.dim}}>
                  <span><span style={{display:"inline-block",width:7,height:7,borderRadius:2,background:C.red,marginRight:3,opacity:0.6}}/>Current</span>
                  <span><span style={{display:"inline-block",width:7,height:7,borderRadius:2,background:C.green,marginRight:3,opacity:0.6}}/>New</span>
                </div>
              </div>
              <StackedBar current={results.months.map(m=>m.currentTotal)} new_={results.months.map(m=>m.newTotal)} months={MONTHS}/>
            </div>

            <div style={{background:C.accentDim,border:"1px solid rgba(34,211,238,0.18)",borderRadius:10,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:0.8}}>Simple Payback</div>
                  <div style={{fontSize:22,fontWeight:800,color:C.accent,fontFamily:mono,marginTop:2}}>
                    {simplePayback<100?`${simplePayback.toFixed(1)} years`:"N/A"}
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>Net Investment</div>
                  <div style={{fontSize:17,fontWeight:700,color:C.text,fontFamily:mono,marginTop:2}}>{fmt(netCost)}</div>
                  {busGrant>0&&<div style={{fontSize:9,color:C.green}}>incl. BUS grant {fmt(busGrant)}</div>}
                </div>
              </div>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 8px"}}>Annual Energy Flows</h3>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,fontSize:11}}>
                {[
                  {l:"SOLAR GENERATED",v:`${results.solarGenerated.toFixed(0)} kWh`,bg:C.yellowDim,c:C.yellow},
                  {l:"SELF-CONSUMED",v:`${results.solarSelfConsumed.toFixed(0)} kWh`,bg:C.greenDim,c:C.green},
                  {l:"GRID IMPORT",v:`${results.gridImport.toFixed(0)} kWh`,bg:C.orangeDim,c:C.orange},
                  {l:"GRID EXPORT",v:`${results.gridExport.toFixed(0)} kWh`,bg:C.purpleDim,c:C.purple},
                ].map((item,i)=>(
                  <div key={i} style={{padding:8,background:item.bg,borderRadius:7}}>
                    <div style={{color:C.muted,fontSize:8,marginBottom:2,letterSpacing:0.5}}>{item.l}</div>
                    <div style={{color:item.c,fontWeight:700,fontFamily:mono}}>{item.v}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:7,padding:8,background:C.accentDim,borderRadius:7}}>
                <div style={{color:C.muted,fontSize:8}}>HEAT PUMP ELECTRICITY</div>
                <div style={{color:C.accent,fontWeight:700,fontFamily:mono,marginTop:1}}>
                  {results.hpElectricity.toFixed(0)} kWh <span style={{color:C.dim,fontWeight:400,fontSize:10}}>replaces {annualGas.toLocaleString()} kWh gas</span>
                </div>
              </div>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 6px"}}>Battery Arbitrage</h3>
              <div style={{display:"flex",gap:7}}>
                <div style={{flex:1,padding:8,background:C.greenDim,borderRadius:7,textAlign:"center"}}>
                  <div style={{fontSize:8,color:C.muted}}>ANNUAL VALUE</div>
                  <div style={{color:C.green,fontWeight:700,fontFamily:mono,fontSize:16,marginTop:2}}>{fmt(results.batteryArbitrageRevenue)}</div>
                </div>
                <div style={{flex:1,padding:8,background:C.purpleDim,borderRadius:7,textAlign:"center"}}>
                  <div style={{fontSize:8,color:C.muted}}>EXPORT REVENUE</div>
                  <div style={{color:C.purple,fontWeight:700,fontFamily:mono,fontSize:16,marginTop:2}}>{fmt(results.months.reduce((s,m)=>s+m.exportRevenue,0))}</div>
                </div>
              </div>
              {(results.usingRealData || results.usingRealSolar) && (
                <div style={{fontSize:10,color:C.dim,marginTop:8,lineHeight:1.5}}>
                  {results.usingRealData && <span>Agile: {results.realDataDays}d real prices.
                  Peak (4-7pm): <span style={{color:C.red,fontFamily:mono}}>{results.peakAvg.toFixed(1)}p</span> ·
                  Off-peak: <span style={{color:C.green,fontFamily:mono}}>{results.offpeakAvg.toFixed(1)}p</span>
                  {results.negativeSlots > 0 && <span> · <span style={{color:C.accent}}>{results.negativeSlots}</span> negative slots</span>}<br/></span>}
                  {results.usingRealSolar && <span>Solar: {results.realSolarDays}d real irradiance from Open-Meteo satellite data.</span>}
                </div>
              )}
            </div>

            {/* Optimizer */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <h3 style={{fontSize:12,fontWeight:600,margin:0,color:C.accent}}>🎯 Optimizer</h3>
                <span style={{fontSize:9,color:C.dim}}>Multi-restart DE</span>
              </div>
              <div style={{fontSize:10,color:C.dim,marginBottom:8,lineHeight:1.5}}>
                Tap badges: <span style={{color:C.green}}>FREE</span> = full range, <span style={{color:C.yellow}}>CLAMP</span> = constrained range, <span style={{color:C.red}}>FIXED</span> = locked. Expand CLAMP params to set min/max.
              </div>

              {/* Target selector */}
              <div style={{marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:600,color:C.text,marginBottom:4}}>Optimize for:</div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {[
                    {id:"monthly",label:"Min monthly cost"},
                    {id:"annualReturn",label:"Max annual return %"},
                    {id:"roi20",label:"Max 20Y ROI %"},
                    {id:"netMonthly",label:"Max net saving/mo"},
                  ].map(t => (
                    <button key={t.id} onClick={()=>{setOptTarget(t.id);setBestEverCost(null);}} style={{
                      padding:"4px 8px",borderRadius:5,fontSize:9,fontWeight:600,cursor:"pointer",
                      background:optTarget===t.id?C.accent:"#1e293b",
                      color:optTarget===t.id?C.bg:C.dim,
                      border:`1px solid ${optTarget===t.id?C.accent:"#334155"}`,
                    }}>{t.label}</button>
                  ))}
                </div>
              </div>

              {/* Param badges with clamp editing */}
              <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:8}}>
                {paramDefs.map(p => {
                  const c = clamps[p.key];
                  const mode = (c && c.mode) || "free";
                  const isClamp = mode === "clamp";
                  return (
                    <button key={p.key} onClick={()=>cycleClamp(p.key,p.get(),p.min,p.max)} style={{
                      padding:"3px 7px",borderRadius:5,fontSize:9,fontWeight:700,cursor:"pointer",
                      background:mode==="fixed"?"rgba(248,113,113,0.1)":isClamp?"rgba(251,191,36,0.1)":"rgba(52,211,153,0.1)",
                      color:mode==="fixed"?C.red:isClamp?C.yellow:C.green,
                      border:`1px solid ${mode==="fixed"?"rgba(248,113,113,0.2)":isClamp?"rgba(251,191,36,0.2)":"rgba(52,211,153,0.25)"}`,
                    }}>{mode==="fixed"?"FIXED":isClamp?`CLAMP ${c.min!=null?c.min:p.min}–${c.max!=null?c.max:p.max}`:"FREE"} {p.label}</button>
                  );
                })}
              </div>

              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                <label style={{fontSize:10,color:C.dim,whiteSpace:"nowrap"}}>Generations:</label>
                <input type="range" min={10} max={200} step={10} value={optGenerations}
                  onChange={e=>setOptGenerations(parseInt(e.target.value))}
                  style={{flex:1,height:4,borderRadius:2,appearance:"none",
                    background:`linear-gradient(to right,${C.accent} ${(optGenerations-10)/190*100}%,#334155 ${(optGenerations-10)/190*100}%)`,cursor:"pointer"}}/>
                <span style={{fontSize:11,color:C.accent,fontFamily:mono,fontWeight:600,minWidth:28,textAlign:"right"}}>{optGenerations}</span>
              </div>
              <button onClick={runOptimizer} disabled={optimizing} style={{
                width:"100%",padding:"10px 0",
                background:optimizing?"#334155":C.accent,
                border:"none",borderRadius:6,color:C.bg,
                fontSize:12,fontWeight:700,cursor:optimizing?"wait":"pointer",
              }}>{optimizing?`Optimizing... ${(optProgress*100).toFixed(0)}%`:"Run Optimizer"}</button>
              {optimizing && (
                <div style={{height:4,background:"#1e293b",borderRadius:2,overflow:"hidden",marginTop:6}}>
                  <div style={{height:"100%",width:`${optProgress*100}%`,background:C.accent,borderRadius:2,transition:"width 0.3s"}}/>
                </div>
              )}
              {optResult && (
                <div style={{fontSize:10,color:optResult.includes("Improved")?C.green:C.dim,marginTop:8,lineHeight:1.5,
                  padding:8,background:optResult.includes("Improved")?C.greenDim:"#1a1a2e",borderRadius:6}}>
                  {optResult}
                </div>
              )}
            </div>
          </div>
        )}
        {/* ═══ INVESTMENT ═══ */}
        {activeTab==="investment"&&(
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 10px",color:C.blue}}>🔧 Equipment & Installation</h3>
              <Slider label="Heat Pump (ASHP)" unit="" prefix="£" value={hpCost} onChange={setHpCost} min={6000} max={18000} step={500} color={C.blue} clampMode={(clamps.hpCost||{}).mode} clampMin={(clamps.hpCost||{}).min} clampMax={(clamps.hpCost||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,hpCost:{...(p.hpCost||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("hpCost",hpCost,6000,18000)}/>
              <Slider label={`Solar ${solarKWp}kWp (£${solarKWp>0?Math.round(solarCost/solarKWp).toLocaleString():0}/kWp)`} unit="" prefix="£" value={solarCost} onChange={handleSolarCostChange} min={0} max={15000} step={250} color={C.yellow} clampMode={(clamps.solarCost||{}).mode} clampMin={(clamps.solarCost||{}).min} clampMax={(clamps.solarCost||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,solarCost:{...(p.solarCost||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("solarCost",solarCost,0,15000)}/>
              <Slider label={`Battery ${batteryKWh}kWh (£${batteryKWh>0?Math.round(batteryCost/batteryKWh).toLocaleString():0}/kWh)`} unit="" prefix="£" value={batteryCost} onChange={handleBatteryCostChange} min={0} max={14000} step={250} color={C.accent} clampMode={(clamps.batteryCost||{}).mode} clampMin={(clamps.batteryCost||{}).min} clampMax={(clamps.batteryCost||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,batteryCost:{...(p.batteryCost||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("batteryCost",batteryCost,0,14000)}/>
              <Slider label="Installation Labour" unit="" prefix="£" value={installCost} onChange={setInstallCost} min={1000} max={8000} step={250} color={C.purple}/>
              <Slider label="Scaffolding" unit="" prefix="£" value={scaffolding} onChange={setScaffolding} min={0} max={2500} step={100} color={C.dim}/>
              <div style={{borderTop:`1px solid ${C.border}`,marginTop:8,paddingTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4,color:C.dim}}>
                  <span>Gross</span><span style={{fontFamily:mono,fontWeight:600,color:C.text}}>{fmt(grossCost)}</span>
                </div>
                <Slider label="BUS Grant" unit="" prefix="£" value={busGrant} onChange={setBusGrant} min={0} max={7500} step={500} color={C.green}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700,padding:"6px 0",borderTop:`1px solid ${C.border}`}}>
                  <span>Net Cost</span><span style={{fontFamily:mono,color:C.accent}}>{fmt(netCost)}</span>
                </div>
              </div>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <h3 style={{fontSize:12,fontWeight:600,margin:0,color:C.orange}}>💳 Finance</h3>
                <button onClick={()=>setUseFinance(!useFinance)} style={{
                  background:useFinance?C.orange:"#1e293b",color:useFinance?C.bg:C.muted,
                  border:`1px solid ${useFinance?C.orange:"#334155"}`,borderRadius:20,
                  padding:"4px 13px",fontSize:10,fontWeight:600,cursor:"pointer",
                }}>{useFinance?"FINANCED":"CASH"}</button>
              </div>
              {useFinance?(
                <span>
                  <Slider label="Deposit" unit="" prefix="£" value={deposit} onChange={setDeposit} min={0} max={netCost} step={500} color={C.green} clampMode={(clamps.deposit||{}).mode} clampMin={(clamps.deposit||{}).min} clampMax={(clamps.deposit||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,deposit:{...(p.deposit||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("deposit",deposit,0,netCost)}/>
                  <Slider label="APR" unit="%" value={financeRate} onChange={setFinanceRate} min={0} max={15} step={0.1} color={C.orange} clampMode={(clamps.financeRate||{}).mode} clampMin={(clamps.financeRate||{}).min} clampMax={(clamps.financeRate||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,financeRate:{...(p.financeRate||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("financeRate",financeRate,0,15)}/>
                  <Slider label="Term" unit=" years" value={financeTerm} onChange={setFinanceTerm} min={3} max={25} step={1} color={C.orange} clampMode={(clamps.financeTerm||{}).mode} clampMin={(clamps.financeTerm||{}).min} clampMax={(clamps.financeTerm||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,financeTerm:{...(p.financeTerm||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("financeTerm",financeTerm,3,25)}/>
                  <div style={{background:C.orangeDim,borderRadius:8,padding:10,marginTop:6}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,fontSize:11}}>
                      {[
                        {l:"FINANCED",v:fmt(financedAmt),c:C.text},
                        {l:"MONTHLY",v:`${fmtD(mp)}/mo`,c:C.orange},
                        {l:"TOTAL REPAID",v:fmt(totalFinCost),c:C.text},
                        {l:"TOTAL INTEREST",v:fmt(totalInterest),c:C.red},
                      ].map((f,i)=>(
                        <div key={i}>
                          <div style={{fontSize:8,color:C.muted,letterSpacing:0.5}}>{f.l}</div>
                          <div style={{fontFamily:mono,fontWeight:700,color:f.c,marginTop:1}}>{f.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </span>
              ):(
                <div style={{fontSize:11,color:C.dim}}>Cash purchase — toggle to model loan repayments.</div>
              )}
            </div>

            <div style={{background:netMonthly>0?C.greenDim:C.redDim,border:`1px solid ${netMonthly>0?"rgba(52,211,153,0.18)":"rgba(248,113,113,0.18)"}`,borderRadius:10,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>Net Monthly</div>
                  <div style={{fontSize:22,fontWeight:800,fontFamily:mono,marginTop:2,color:netMonthly>=0?C.green:C.red}}>
                    {netMonthly>=0?"+":"-"}{fmtD(Math.abs(netMonthly))}<span style={{fontSize:12,color:C.dim}}>/mo</span>
                  </div>
                </div>
                <div style={{textAlign:"right",fontSize:10,color:C.dim}}>
                  <div>Saving: <span style={{color:C.green,fontFamily:mono}}>{fmtD(annualSaving/12)}/mo</span></div>
                  {useFinance&&<div>Finance: <span style={{color:C.orange,fontFamily:mono}}>-{fmtD(mp)}/mo</span></div>}
                </div>
              </div>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <h3 style={{fontSize:12,fontWeight:600,margin:0}}>Cumulative Returns</h3>
                <span style={{fontSize:9,color:C.dim}}>20-year</span>
              </div>
              <CumulativeChart annualSaving={annualSaving} totalCost={netCost} financeMonthly={mp} financeTerm={financeTerm} useFinance={useFinance}/>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 8px"}}>Investment Returns</h3>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:7}}>
                {[
                  {l:"PAYBACK",v:breakEvenYear?`${breakEvenYear}y`:(simplePayback<100?`~${simplePayback.toFixed(1)}y`:"N/A"),sub:useFinance?"incl. finance":"break even",bg:C.accentDim,c:C.accent},
                  {l:"ANNUAL RETURN",v:`${annualReturn.toFixed(1)}%`,sub:"CAGR over 20y",bg:C.yellowDim,c:annualReturn>0?C.yellow:C.red},
                  {l:"20Y NET PROFIT",v:`${profit20>=0?"":"-"}${fmt(Math.abs(profit20))}`,sub:`spent ${fmt(totalSpent20Y)} over 20y`,bg:C.greenDim,c:profit20>0?C.green:C.red},
                  {l:"20Y ROI",v:`${roi20.toFixed(0)}%`,sub:`saved ${fmt(totalSavings20Y)}`,bg:C.blueDim,c:roi20>0?C.blue:C.red},
                ].map((s,i)=>(
                  <div key={i} style={{padding:8,background:s.bg,borderRadius:7,textAlign:"center"}}>
                    <div style={{fontSize:8,color:C.muted}}>{s.l}</div>
                    <div style={{fontSize:15,fontWeight:700,fontFamily:mono,color:s.c,marginTop:2}}>{s.v}</div>
                    <div style={{fontSize:8,color:C.dim}}>{s.sub}</div>
                  </div>
                ))}
              </div>
              {useFinance && (
                <div style={{display:"grid",gridTemplateColumns:freeYears>0?"1fr 1fr":"1fr",gap:7,marginBottom:7}}>
                  <div style={{padding:8,background:"#1a1a2e",borderRadius:7,border:"1px solid #1e293b",textAlign:"center"}}>
                    <div style={{fontSize:8,color:C.muted}}>NET MONTHLY (YRS 1–{finYears})</div>
                    <div style={{fontSize:14,fontWeight:700,fontFamily:mono,color:netAnnualDuringFinance>0?C.green:C.red,marginTop:2}}>{fmtD(netAnnualDuringFinance/12)}/mo</div>
                    <div style={{fontSize:8,color:C.dim}}>saving {fmtD(annualSaving/12)} − finance {fmtD(mp)}</div>
                  </div>
                  {freeYears > 0 && (
                    <div style={{padding:8,background:"#1a1a2e",borderRadius:7,border:"1px solid #1e293b",textAlign:"center"}}>
                      <div style={{fontSize:8,color:C.muted}}>NET MONTHLY (YRS {finYears+1}–20)</div>
                      <div style={{fontSize:14,fontWeight:700,fontFamily:mono,color:C.green,marginTop:2}}>{fmtD(annualSaving/12)}/mo</div>
                      <div style={{fontSize:8,color:C.dim}}>loan paid off — full saving</div>
                    </div>
                  )}
                </div>
              )}
              <div style={{fontSize:9,color:C.dim,lineHeight:1.6}}>
                {annualSaving > 0 ? (
                  <span>
                    Energy saving: <span style={{color:C.green}}>{fmt(annualSaving)}/yr</span> ({fmtD(annualSaving/12)}/mo).
                    {useFinance && <span> Finance: <span style={{color:C.orange}}>{fmtD(mp)}/mo</span> for {financeTerm}y (total {fmt(totalFinCost)}, interest {fmt(totalInterest)}).</span>}
                    {useFinance && netAnnualDuringFinance > 0 && deposit === 0 && (
                      <span style={{color:C.green,fontWeight:600}}> With £0 deposit, you save {fmtD(netAnnualDuringFinance/12)}/mo from day 1 — the equipment pays for itself while you use it. Your ROI is effectively infinite on zero capital.</span>
                    )}
                    {useFinance && netAnnualDuringFinance > 0 && deposit > 0 && (
                      <span> Net {fmtD(netAnnualDuringFinance/12)}/mo positive from day 1 on £{deposit.toLocaleString()} deposit.</span>
                    )}
                    {" "}Over 20 years: <span style={{color:profit20>0?C.green:C.red}}>{profit20>=0?"":"-"}{fmt(Math.abs(profit20))} {profit20>0?"profit":"loss"}</span> on {fmt(totalSpent20Y)} spent = <span style={{color:C.blue}}>{roi20.toFixed(0)}% ROI</span>.
                    {breakEvenYear && <span> Break-even: <span style={{color:C.accent}}>year {breakEvenYear}</span>.</span>}
                    {annualReturn > 0 && <span> Equivalent to {annualReturn.toFixed(1)}% compound annual return.</span>}
                  </span>
                ) : (
                  <span>New setup costs more than current — no positive return.</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══ ENERGY CONFIG ═══ */}
        {activeTab==="config"&&(
          <div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 10px",color:C.red}}>🔥 Current — Gas Boiler + Fixed</h3>

              {/* Upload usage data */}
              <div style={{background:"rgba(248,113,113,0.06)",border:"1px solid rgba(248,113,113,0.12)",borderRadius:8,padding:10,marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:600,color:C.red,marginBottom:6}}>📊 UPLOAD YOUR USAGE DATA</div>
                <div style={{fontSize:10,color:C.dim,marginBottom:8,lineHeight:1.5}}>
                  Upload CSVs from Octopus Energy, British Gas, or any supplier. Half-hourly or hourly data with date + kWh columns. Missing slots are interpolated automatically.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:6}}>
                  <div>
                    <label style={{
                      display:"block",textAlign:"center",padding:"8px 0",
                      background:elecUsageData?C.greenDim:"#1e293b",
                      border:`1px dashed ${elecUsageData?C.green:"#475569"}`,
                      borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,
                      color:elecUsageData?C.green:C.dim,
                    }}>
                      {elecUsageData?`⚡ ${elecUsageData.totalDays}d loaded`:"⚡ Electricity CSV"}
                      <input type="file" accept=".csv,.tsv,.txt" style={{display:"none"}}
                        onChange={e=>{if(e.target.files[0])handleFileUpload(e.target.files[0],"electricity");}}/>
                    </label>
                  </div>
                  <div>
                    <label style={{
                      display:"block",textAlign:"center",padding:"8px 0",
                      background:gasUsageData?C.greenDim:"#1e293b",
                      border:`1px dashed ${gasUsageData?C.green:"#475569"}`,
                      borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,
                      color:gasUsageData?C.green:C.dim,
                    }}>
                      {gasUsageData?`🔥 ${gasUsageData.totalDays}d loaded`:"🔥 Gas CSV"}
                      <input type="file" accept=".csv,.tsv,.txt" style={{display:"none"}}
                        onChange={e=>{if(e.target.files[0])handleFileUpload(e.target.files[0],"gas");}}/>
                    </label>
                  </div>
                </div>
                {uploadStatus.elec && <div style={{fontSize:9,color:uploadStatus.elec.startsWith("Error")?C.red:C.green,marginBottom:2}}>Elec: {uploadStatus.elec}</div>}
                {uploadStatus.gas && <div style={{fontSize:9,color:uploadStatus.gas.startsWith("Error")?C.red:C.green,marginBottom:2}}>Gas: {uploadStatus.gas}</div>}
                {(elecUsageData||gasUsageData) && (
                  <div style={{display:"flex",gap:6,marginTop:6}}>
                    {elecUsageData && (
                      <div style={{flex:1,padding:6,background:C.accentDim,borderRadius:6,textAlign:"center"}}>
                        <div style={{fontSize:8,color:C.muted}}>ELEC UPLOADED</div>
                        <div style={{fontSize:13,fontWeight:700,fontFamily:mono,color:C.accent}}>{elecUsageData.totalDays}d</div>
                        <div style={{fontSize:8,color:C.dim}}>Target: {annualElec.toLocaleString()} kWh/yr</div>
                      </div>
                    )}
                    {gasUsageData && (
                      <div style={{flex:1,padding:6,background:C.orangeDim,borderRadius:6,textAlign:"center"}}>
                        <div style={{fontSize:8,color:C.muted}}>GAS UPLOADED</div>
                        <div style={{fontSize:13,fontWeight:700,fontFamily:mono,color:C.orange}}>{gasUsageData.totalDays}d</div>
                        <div style={{fontSize:8,color:C.dim}}>Target: {annualGas.toLocaleString()} kWh/yr</div>
                      </div>
                    )}
                    <button onClick={()=>{setElecUsageData(null);setGasUsageData(null);setUploadStatus({elec:null,gas:null});}} style={{
                      background:"#1e293b",border:`1px solid #475569`,borderRadius:6,
                      padding:"4px 10px",fontSize:9,color:C.dim,cursor:"pointer",alignSelf:"center",
                    }}>Clear</button>
                  </div>
                )}
              </div>
              <Slider label="Annual Gas" unit=" kWh" value={annualGas} onChange={setAnnualGas} min={5000} max={25000} step={500} color={C.orange}/>
              <Slider label="Annual Electricity" unit=" kWh" value={annualElec} onChange={setAnnualElec} min={1000} max={8000} step={100} color={C.orange}/>
              <Slider label="Hot Water" unit=" kWh/day" value={hotWaterKWhPerDay} onChange={setHotWaterKWhPerDay} min={5} max={20} step={1} color={C.orange}/>
              <Slider label="Boiler Efficiency" unit="%" value={boilerEfficiency} onChange={setBoilerEfficiency} min={70} max={98} step={1} color={C.orange}/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginTop:6}}>
                {[
                  {l:"Elec (p/kWh)",v:fixedElecRate,s:setFixedElecRate},
                  {l:"Gas (p/kWh)",v:fixedGasRate,s:setFixedGasRate},
                  {l:"Elec stndg (p/d)",v:fixedElecStanding,s:setFixedElecStanding},
                  {l:"Gas stndg (p/d)",v:fixedGasStanding,s:setFixedGasStanding},
                ].map((f,i)=>(
                  <div key={i}><label style={{fontSize:10,color:C.muted}}>{f.l}</label>
                  <input type="number" value={f.v} onChange={e=>f.s(parseFloat(e.target.value)||0)} style={inputSt} step="0.01"/></div>
                ))}
              </div>
            </div>

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 10px",color:C.green}}>🌿 New Setup</h3>

              <div style={{background:"rgba(251,191,36,0.06)",border:"1px solid rgba(251,191,36,0.12)",borderRadius:8,padding:10,marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:600,color:C.yellow,marginBottom:8}}>☀️ SOLAR</div>
                <Slider label="System Size" unit=" kWp" value={solarKWp} onChange={setSolarKWp} min={0} max={12} step={0.5} color={C.yellow} clampMode={(clamps.solarKWp||{}).mode} clampMin={(clamps.solarKWp||{}).min} clampMax={(clamps.solarKWp||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,solarKWp:{...(p.solarKWp||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("solarKWp",solarKWp,0,12)}/>
                <Slider label="Roof Tilt" unit="°" value={solarTilt} onChange={setSolarTilt} min={0} max={90} step={5} color={C.yellow} clampMode={(clamps.solarTilt||{}).mode} clampMin={(clamps.solarTilt||{}).min} clampMax={(clamps.solarTilt||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,solarTilt:{...(p.solarTilt||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("solarTilt",solarTilt,0,90)}/>
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <button onClick={()=>cycleClamp("solarAzimuth",solarAzimuth,0,355)} style={{
                        background:(clamps.solarAzimuth||{}).mode==="fixed"?"rgba(248,113,113,0.15)":(clamps.solarAzimuth||{}).mode==="clamp"?"rgba(251,191,36,0.15)":"rgba(52,211,153,0.12)",
                        border:`1px solid ${(clamps.solarAzimuth||{}).mode==="fixed"?"rgba(248,113,113,0.3)":(clamps.solarAzimuth||{}).mode==="clamp"?"rgba(251,191,36,0.3)":"rgba(52,211,153,0.25)"}`,
                        borderRadius:4,padding:"1px 5px",cursor:"pointer",fontSize:8,fontWeight:700,lineHeight:"16px",
                        color:(clamps.solarAzimuth||{}).mode==="fixed"?C.red:(clamps.solarAzimuth||{}).mode==="clamp"?C.yellow:C.green,
                      }}>{(clamps.solarAzimuth||{}).mode==="fixed"?"FIXED":(clamps.solarAzimuth||{}).mode==="clamp"?"CLAMP":"FREE"}</button>
                      <span style={{fontSize:12,color:C.dim}}>Azimuth</span>
                    </div>
                    <span style={{fontSize:13,color:C.yellow,fontFamily:mono,fontWeight:600}}>{solarAzimuth}° {
                      solarAzimuth===0?"N":solarAzimuth===90?"E":solarAzimuth===180?"S":solarAzimuth===270?"W":
                      solarAzimuth<90?"N-E":solarAzimuth<180?"E-S":solarAzimuth<270?"S-W":"W-N"
                    }</span>
                  </div>
                  <input type="range" min={0} max={355} step={5} value={solarAzimuth}
                    onChange={e=>(clamps.solarAzimuth||{}).mode!=="fixed"&&setSolarAzimuth(parseFloat(e.target.value))}
                    disabled={(clamps.solarAzimuth||{}).mode==="fixed"}
                    style={{width:"100%",height:6,borderRadius:3,appearance:"none",
                      background:`linear-gradient(to right,${C.orange},${C.yellow} 25%,${C.green} 50%,${C.yellow} 75%,${C.orange})`,
                      cursor:(clamps.solarAzimuth||{}).mode==="fixed"?"not-allowed":"pointer",
                      opacity:(clamps.solarAzimuth||{}).mode==="fixed"?0.4:1}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:C.muted,marginTop:2}}>
                    <span>N</span><span>E</span><span>S ✓</span><span>W</span><span>N</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{position:"relative",width:50,height:50,flexShrink:0}}>
                    <svg width="50" height="50" viewBox="0 0 50 50">
                      <circle cx="25" cy="25" r="23" fill="none" stroke={C.border} strokeWidth="1.5"/>
                      {["N","E","S","W"].map((d,i)=>{
                        const a=i*90-90,r2=19;
                        return <text key={d} x={25+r2*Math.cos(a*Math.PI/180)} y={25+r2*Math.sin(a*Math.PI/180)+3} fill={d==="S"?C.green:C.muted} fontSize="7" textAnchor="middle" fontFamily={mono}>{d}</text>;
                      })}
                      {(()=>{const a=(solarAzimuth-90)*Math.PI/180; return (<line x1="25" y1="25" x2={25+14*Math.cos(a)} y2={25+14*Math.sin(a)} stroke={C.yellow} strokeWidth="2.5" strokeLinecap="round"/>);})()}
                      <circle cx="25" cy="25" r="2" fill={C.yellow}/>
                    </svg>
                  </div>
                  <div style={{fontSize:10,color:C.dim,lineHeight:1.5}}>
                    Azimuth: <span style={{color:C.yellow,fontFamily:mono}}>{(azimuthCorrectionFactor(solarAzimuth)*100).toFixed(0)}%</span> of south ·
                    Annual: <span style={{color:C.yellow,fontFamily:mono,fontWeight:600}}>{results.solarGenerated.toFixed(0)} kWh</span>
                  </div>
                </div>
              </div>

              <div style={{background:"rgba(34,211,238,0.06)",border:"1px solid rgba(34,211,238,0.12)",borderRadius:8,padding:10,marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:600,color:C.accent,marginBottom:8}}>🔋 BATTERY</div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                  {[{l:"None",k:0,p:0},{l:"5kWh",k:5,p:2.5},{l:"10kWh",k:10,p:5},{l:"13.5kWh",k:13.5,p:5},{l:"15kWh",k:15,p:5},{l:"20kWh",k:20,p:6}].map(pr=>(
                    <button key={pr.l} onClick={()=>{setBatteryKWh(pr.k);setBatteryPowerKW(pr.p);}} style={{
                      background:Math.abs(batteryKWh-pr.k)<0.5?C.accent:"#1e293b",color:Math.abs(batteryKWh-pr.k)<0.5?C.bg:C.dim,
                      border:`1px solid ${Math.abs(batteryKWh-pr.k)<0.5?C.accent:"#334155"}`,borderRadius:6,
                      padding:"3px 8px",fontSize:10,fontWeight:600,cursor:"pointer",
                    }}>{pr.l}</button>
                  ))}
                </div>
                <Slider label="Capacity" unit=" kWh" value={batteryKWh} onChange={setBatteryKWh} min={0} max={25} step={0.5} color={C.accent} clampMode={(clamps.batteryKWh||{}).mode} clampMin={(clamps.batteryKWh||{}).min} clampMax={(clamps.batteryKWh||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,batteryKWh:{...(p.batteryKWh||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("batteryKWh",batteryKWh,0,25)}/>
                <Slider label="Power" unit=" kW" value={batteryPowerKW} onChange={setBatteryPowerKW} min={1} max={12} step={0.5} color={C.accent} clampMode={(clamps.batteryPowerKW||{}).mode} clampMin={(clamps.batteryPowerKW||{}).min} clampMax={(clamps.batteryPowerKW||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,batteryPowerKW:{...(p.batteryPowerKW||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("batteryPowerKW",batteryPowerKW,1,12)}/>
                <Slider label="Efficiency" unit="%" value={batteryEfficiency} onChange={setBatteryEfficiency} min={80} max={98} step={1} color={C.accent} clampMode={(clamps.batteryEfficiency||{}).mode} clampMin={(clamps.batteryEfficiency||{}).min} clampMax={(clamps.batteryEfficiency||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,batteryEfficiency:{...(p.batteryEfficiency||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("batteryEfficiency",batteryEfficiency,80,98)}/>

                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:C.dim,marginBottom:4}}>Battery Strategy</div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {[
                      {id:"peak",label:"Peak Shave",desc:"Charge overnight, discharge only 4-7pm peak"},
                      {id:"smart",label:"Smart",desc:"Use battery when it saves vs grid import"},
                      {id:"maxExport",label:"Max Export",desc:"Aggressively charge cheap, export at peak"},
                      {id:"solarFirst",label:"Solar First",desc:"Minimize grid use, battery powers home first"},
                    ].map(s => (
                      <button key={s.id} onClick={()=>setBattStrategy(s.id)} style={{
                        padding:"4px 8px",borderRadius:5,fontSize:9,fontWeight:600,cursor:"pointer",
                        background:battStrategy===s.id?C.accent:"#1e293b",
                        color:battStrategy===s.id?C.bg:C.dim,
                        border:`1px solid ${battStrategy===s.id?C.accent:"#334155"}`,
                      }}>{s.label}</button>
                    ))}
                  </div>
                  <div style={{fontSize:9,color:C.muted,marginTop:4}}>
                    {battStrategy==="peak"?"Charge overnight at cheapest rates. Only discharge during 4-7pm peak. Conservative.":
                     battStrategy==="smart"?"Discharge to home when price > charge cost + losses. Export at peak. Best all-rounder.":
                     battStrategy==="maxExport"?"Charge aggressively at cheap rates. Discharge home at mid-price. Export maximum at peak.":
                     "Prioritize solar storage and self-use. Minimal grid charging. Battery powers home before grid."}
                  </div>
                </div>
              </div>

              <div style={{background:"rgba(52,211,153,0.06)",border:"1px solid rgba(52,211,153,0.12)",borderRadius:8,padding:10,marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:600,color:C.green,marginBottom:8}}>🌡️ HEAT PUMP</div>
                <Slider label="Flow Temp" unit="°C" value={hpFlowTemp} onChange={setHpFlowTemp} min={35} max={55} step={5} color={C.green} clampMode={(clamps.hpFlowTemp||{}).mode} clampMin={(clamps.hpFlowTemp||{}).min} clampMax={(clamps.hpFlowTemp||{}).max} onClampChange={(lo,hi)=>setClamps(p=>({...p,hpFlowTemp:{...(p.hpFlowTemp||{mode:"clamp"}),min:lo,max:hi}}))} onCycleClamp={()=>cycleClamp("hpFlowTemp",hpFlowTemp,35,55)}/>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr",gap:7,marginTop:8}}>
                <div><label style={{fontSize:10,color:C.muted}}>Agile standing charge (p/day)</label>
                <input type="number" value={agileStanding} onChange={e=>setAgileStanding(parseFloat(e.target.value)||0)} style={inputSt} step="0.01"/></div>
                {!exportPriceData && (
                  <div><label style={{fontSize:10,color:C.muted}}>Fixed export rate (p/kWh) — used when no Agile Outgoing data loaded</label>
                  <input type="number" value={exportRate} onChange={e=>setExportRate(parseFloat(e.target.value)||0)} style={inputSt} step="0.1"/></div>
                )}
                <div style={{fontSize:9,color:C.dim,lineHeight:1.5,padding:"6px 0"}}>
                  Export pricing: {exportPriceData
                    ? <span style={{color:C.green}}>Agile Outgoing half-hourly rates loaded ✓</span>
                    : <span style={{color:C.orange}}>Using fixed {exportRate}p/kWh (load Agile Outgoing data in the Agile Data tab for real rates)</span>
                  }. Strategy: {battStrategy==="peak"?"Peak Shave":battStrategy==="smart"?"Smart Arbitrage":battStrategy==="maxExport"?"Max Export":"Solar First"}.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ 30-DAY DETAIL ═══ */}
        {activeTab==="detail"&&(()=>{
          const toggle = (key) => setChartHidden(p => ({...p, [key]: !p[key]}));
          const hid = chartHidden;
          const fullLog = results.dailyLog;
          if (!fullLog || fullLog.length === 0) return (<div style={{padding:20,textAlign:"center",color:C.dim}}>No simulation data</div>);

          // Filter to selected month and re-index days from 0
          const log = fullLog.filter(r => r.m === detailMonth);
          const daysInMonth = log.length > 0 ? Math.max(...log.map(r=>r.day)) - Math.min(...log.map(r=>r.day)) + 1 : 0;
          const dayOffset = log.length > 0 ? log[0].day : 0;

          const ttFmt = (v,p) => {
            const r = p&&p[0]&&p[0].payload;
            if (!r) return "";
            const dayInMonth = r.day - dayOffset + 1;
            return `${MONTHS[detailMonth]} day ${dayInMonth}, ${String(Math.floor(r.slot/2)).padStart(2,"0")}:${r.slot%2===0?"00":"30"} — ${r.price.toFixed(1)}p`;
          };
          const xFmt = (v,i) => { const r = chartData[i]; return r && r.slot === 0 ? `${r.day-dayOffset+1}` : ""; };
          const ttS = {background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,fontSize:10};

          // Slice data to synced view range
          const vs = Math.max(0, Math.min(viewStart, log.length));
          const ve = Math.min(viewEnd, log.length);
          const chartData = log.slice(vs, ve);
          const onRangeChange = (s, e) => { setViewStart(s); setViewEnd(Math.min(e, log.length)); };

          const Leg = ({items}) => (
            <div style={{display:"flex",flexWrap:"wrap",gap:2,marginBottom:6}}>
              {items.map(({color,label,k})=>(
                <span key={k} onClick={()=>toggle(k)} style={{
                  cursor:"pointer",fontSize:9,padding:"2px 6px",borderRadius:4,
                  background:hid[k]?"transparent":"rgba(255,255,255,0.04)",
                  opacity:hid[k]?0.3:1,display:"inline-flex",alignItems:"center",gap:3,
                  border:`1px solid ${hid[k]?"transparent":"rgba(255,255,255,0.06)"}`,
                }}>
                  <span style={{width:10,height:3,borderRadius:1,background:color,display:"inline-block"}}/>
                  {label}
                </span>
              ))}
            </div>
          );

          // ── SANKEY from full-year monthly results (not 30-day log) ──
          const ms = results.months;
          const sA = {
            solarSelf: ms.reduce((s,m)=>s+m.solarSelfConsumed,0),
            solarBatt: ms.reduce((s,m)=>s+Math.max(0,m.solarGen-m.solarSelfConsumed-m.solarExport),0),
            solarExport: ms.reduce((s,m)=>s+m.solarExport,0),
            gridHome: ms.reduce((s,m)=>s+m.gridImport-m.gridBatt,0),
            gridBatt: ms.reduce((s,m)=>s+m.gridBatt,0),
            battHome: ms.reduce((s,m)=>s+m.battHome,0),
            battExport: ms.reduce((s,m)=>s+m.battExport,0),
          };
          const fk = v => v >= 1000 ? `${(v/1000).toFixed(1)}MWh` : `${Math.round(v)}kWh`;

          return (
          <div style={{padding:"0 4px"}}>
            {/* Month selector */}
            <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:10}}>
              {MONTHS.map((mn,i)=>(
                <button key={i} onClick={()=>{setDetailMonth(i);setViewStart(0);setViewEnd(144);}} style={{
                  background:detailMonth===i?C.accent:C.card,color:detailMonth===i?C.bg:C.muted,
                  border:`1px solid ${detailMonth===i?C.accent:C.border}`,borderRadius:6,
                  padding:"4px 7px",fontSize:10,fontWeight:600,cursor:"pointer",
                }}>{mn}</button>
              ))}
            </div>
            {/* Range selector — syncs all charts */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 13px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <span style={{fontSize:10,color:C.dim}}>Day range (drag handles or slide window)</span>
                <span style={{fontSize:10,color:C.accent,fontFamily:mono}}>Day {Math.floor(viewStart/48)+1}–{Math.ceil(viewEnd/48)} of {Math.ceil(log.length/48)}</span>
              </div>
              <RangeBrush total={log.length} start={viewStart} end={viewEnd} onChange={onRangeChange} color={C.accent}/>
              <div style={{display:"flex",gap:4,justifyContent:"center"}}>
                {[3,7,14,0].map(d=>(
                  <button key={d} onClick={()=>{const span=d===0?log.length:d*48;setViewStart(0);setViewEnd(Math.min(span,log.length));}} style={{
                    padding:"2px 8px",borderRadius:4,fontSize:9,cursor:"pointer",
                    background:(d===0&&viewEnd>=log.length)||(d>0&&(viewEnd-viewStart)===d*48)?C.accent:"#1e293b",
                    color:(d===0&&viewEnd>=log.length)||(d>0&&(viewEnd-viewStart)===d*48)?C.bg:C.dim,
                    border:`1px solid ${(d===0&&viewEnd>=log.length)||(d>0&&(viewEnd-viewStart)===d*48)?C.accent:"#334155"}`,
                  }}>{d===0?"All":`${d}d`}</button>
                ))}
              </div>
            </div>

            {/* Chart 1: Battery SOC + Price */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 4px"}}>Battery & Price</h3>
              <Leg items={[{color:C.accent,label:"SOC (kWh)",k:"soc"},{color:C.orange,label:"Import (p)",k:"pr"},{color:C.green,label:"Export (p)",k:"ep"}]}/>
              <TouchChart height={180}>
                <ResponsiveContainer>
                  <ComposedChart data={chartData} margin={{top:5,right:5,left:-15,bottom:0}} barCategoryGap={0} barGap={0}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="slot" tick={{fontSize:8,fill:C.muted}} tickFormatter={xFmt}/>
                    <YAxis yAxisId="soc" tick={{fontSize:8,fill:C.muted}} unit="kWh"/>
                    <YAxis yAxisId="pr" orientation="right" tick={{fontSize:8,fill:C.muted}} unit="p"/>
                    <Tooltip contentStyle={ttS} labelFormatter={ttFmt}/>
                    {!hid.soc&&<Bar yAxisId="soc" dataKey="battSOC" fill={C.accent} opacity={0.6} name="SOC" isAnimationActive={false}/>}
                    {!hid.pr&&<Line yAxisId="pr" type="stepAfter" dataKey="price" stroke={C.orange} dot={false} strokeWidth={1.5} name="Import" isAnimationActive={false}/>}
                    {!hid.ep&&<Line yAxisId="pr" type="stepAfter" dataKey="expPrice" stroke={C.green} dot={false} strokeWidth={1} opacity={0.7} name="Export" isAnimationActive={false}/>}
                  </ComposedChart>
                </ResponsiveContainer>
              </TouchChart>
            </div>

            {/* Chart 2: Home supply sources + demand */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 4px"}}>Home Energy (stacked = total demand)</h3>
              <Leg items={[
                {color:C.yellow,label:"Solar→Home",k:"sd"},
                {color:"#60a5fa",label:"Batt→Home",k:"bh"},
                {color:C.red,label:"Grid→Home",k:"gh"},
              ]}/>
              <TouchChart height={170}>
                <ResponsiveContainer>
                  <BarChart data={chartData} margin={{top:5,right:5,left:-15,bottom:0}} barCategoryGap={0} barGap={0}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="slot" tick={{fontSize:8,fill:C.muted}} tickFormatter={xFmt}/>
                    <YAxis tick={{fontSize:8,fill:C.muted}} unit="kWh"/>
                    <Tooltip contentStyle={ttS} labelFormatter={ttFmt}/>
                    {!hid.sd&&<Bar dataKey="solarDirect" stackId="home" fill={C.yellow} opacity={0.85} name="Solar→Home" isAnimationActive={false}/>}
                    {!hid.bh&&<Bar dataKey="battHome" stackId="home" fill="#60a5fa" opacity={0.85} name="Batt→Home" isAnimationActive={false}/>}
                    {!hid.gh&&<Bar dataKey="gridHome" stackId="home" fill={C.red} opacity={0.6} name="Grid→Home" isAnimationActive={false}/>}
                  </BarChart>
                </ResponsiveContainer>
              </TouchChart>
            </div>

            {/* Chart 3: Charging & Export */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 4px"}}>Battery Charging & Export</h3>
              <Leg items={[
                {color:C.yellow,label:"Solar→Batt",k:"sbb"},
                {color:"#3b82f6",label:"Grid→Batt",k:"gb"},
                {color:C.purple,label:"Batt→Grid",k:"be"},
                {color:C.green,label:"Solar→Grid",k:"se"},
              ]}/>
              <TouchChart height={170}>
                <ResponsiveContainer>
                  <BarChart data={chartData} margin={{top:5,right:5,left:-15,bottom:0}} barCategoryGap={0} barGap={0}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="slot" tick={{fontSize:8,fill:C.muted}} tickFormatter={xFmt}/>
                    <YAxis tick={{fontSize:8,fill:C.muted}} unit="kWh"/>
                    <Tooltip contentStyle={ttS} labelFormatter={ttFmt}/>
                    {!hid.sbb&&<Bar dataKey="solarBatt" stackId="ce" fill={C.yellow} opacity={0.85} name="Solar→Batt" isAnimationActive={false}/>}
                    {!hid.gb&&<Bar dataKey="gridBatt" stackId="ce" fill="#3b82f6" opacity={0.85} name="Grid→Batt" isAnimationActive={false}/>}
                    {!hid.be&&<Bar dataKey="battExport" stackId="ce" fill={C.purple} opacity={0.85} name="Batt→Grid" isAnimationActive={false}/>}
                    {!hid.se&&<Bar dataKey="solarExport" stackId="ce" fill={C.green} opacity={0.85} name="Solar→Grid" isAnimationActive={false}/>}
                  </BarChart>
                </ResponsiveContainer>
              </TouchChart>
            </div>

            <div style={{fontSize:9,color:C.dim,lineHeight:1.5,padding:"0 4px 8px"}}>
              Showing {MONTHS[detailMonth]} ({daysInMonth} days, {log.length} half-hour slots). Sankey: full annual flows. Tap legend to toggle lines.
            </div>

            {/* Sankey */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 10px"}}>Annual Energy Flow</h3>
              <svg viewBox="0 0 400 220" style={{width:"100%",height:"auto"}}>
                {(()=>{
                  const allFlows = [
                    {from:"solar",to:"home",val:sA.solarSelf,color:C.yellow,id:"sh"},
                    {from:"solar",to:"batt",val:sA.solarBatt,color:C.yellow,id:"sb"},
                    {from:"solar",to:"export",val:sA.solarExport,color:C.yellow,id:"se"},
                    {from:"grid",to:"home",val:sA.gridHome,color:C.red,id:"gh"},
                    {from:"grid",to:"batt",val:sA.gridBatt,color:"#60a5fa",id:"gb"},
                    {from:"batt",to:"home",val:sA.battHome,color:C.accent,id:"bh"},
                    {from:"batt",to:"export",val:sA.battExport,color:C.purple,id:"be"},
                  ].filter(f => f.val > 10);
                  if (allFlows.length === 0) return <text x={200} y={110} fill={C.dim} fontSize="11" textAnchor="middle">No flows to display</text>;

                  // Column X positions for node bars
                  const barW = 10;
                  const col = [15, 175, 375];
                  const totalH = 190, topPad = 10;

                  // Compute node totals (max of in/out for sizing)
                  const totals = {};
                  for (const f of allFlows) {
                    if (!totals[f.from]) totals[f.from] = {out:0, in:0};
                    if (!totals[f.to]) totals[f.to] = {out:0, in:0};
                    totals[f.from].out += f.val;
                    totals[f.to].in += f.val;
                  }
                  const nodeSize = {};
                  for (const [k,v] of Object.entries(totals)) nodeSize[k] = Math.max(v.out, v.in);
                  const maxVal = Math.max(1, ...Object.values(nodeSize));
                  const scale = totalH / maxVal;

                  // Node definitions: column, order within column, color, label
                  const nodeDefs = [
                    {id:"solar",col:0,color:C.yellow,label:`${fk(results.solarGenerated)} Solar`},
                    {id:"grid",col:0,color:C.red,label:`${fk(results.gridImport)} Grid`},
                    {id:"batt",col:1,color:C.accent,label:`Battery ${batteryKWh}kWh`},
                    {id:"home",col:2,color:C.green,label:`${fk(results.months.reduce((s,m)=>s+m.elecUsage+m.hpElec,0))} Home`},
                    {id:"export",col:2,color:C.purple,label:`${fk(results.gridExport)} Export`},
                  ].filter(n => nodeSize[n.id]);

                  // Position nodes within columns with gaps
                  const colNodes = [[], [], []];
                  for (const n of nodeDefs) colNodes[n.col].push(n);

                  const nodePos = {};
                  for (let c = 0; c < 3; c++) {
                    const ns = colNodes[c];
                    const totalBarH = ns.reduce((s,n) => s + nodeSize[n.id] * scale, 0);
                    const gapTotal = Math.max(0, (ns.length - 1) * 12);
                    let y = topPad + (totalH - totalBarH - gapTotal) / 2;
                    for (const n of ns) {
                      const h = Math.max(8, nodeSize[n.id] * scale);
                      nodePos[n.id] = {x: col[c], y, h, color: n.color, label: n.label, col: c};
                      y += h + 12;
                    }
                  }

                  // Stack flows on node edges
                  const outOff = {}, inOff = {};
                  for (const id of Object.keys(nodePos)) { outOff[id] = 0; inOff[id] = 0; }

                  // Order: top-to-top first, then top-to-mid, etc to minimize crossings
                  const flowOrder = ["sh","sb","se","gb","gh","bh","be"];
                  const ordered = flowOrder.map(id => allFlows.find(f=>f.id===id)).filter(Boolean);

                  const ribbons = ordered.map(f => {
                    const sn = nodePos[f.from], dn = nodePos[f.to];
                    const sh = (f.val / Math.max(1, totals[f.from].out)) * sn.h;
                    const dh = (f.val / Math.max(1, totals[f.to].in)) * dn.h;
                    const sy = sn.y + outOff[f.from];
                    const dy = dn.y + inOff[f.to];
                    outOff[f.from] += sh;
                    inOff[f.to] += dh;
                    return {color: f.color, val: f.val, sx: sn.x + barW, sy, sh, dx: dn.x, dy, dh};
                  });

                  return (
                    <g>
                      {ribbons.map((r,i) => {
                        const mx = (r.sx + r.dx) / 2;
                        return (
                          <path key={i} d={[
                            `M${r.sx},${r.sy}`,
                            `C${mx},${r.sy} ${mx},${r.dy} ${r.dx},${r.dy}`,
                            `L${r.dx},${r.dy+r.dh}`,
                            `C${mx},${r.dy+r.dh} ${mx},${r.sy+r.sh} ${r.sx},${r.sy+r.sh}`,
                            `Z`
                          ].join(" ")} fill={r.color} opacity={0.3}/>
                        );
                      })}
                      {ribbons.map((r,i) => {
                        const mx = (r.sx + r.dx) / 2;
                        const ly = (r.sy + r.sh/2 + r.dy + r.dh/2) / 2;
                        return (
                          <text key={`t${i}`} x={mx} y={ly} fill={r.color} fontSize="7" textAnchor="middle" fontFamily={mono} opacity={0.85}>
                            {fk(r.val)}
                          </text>
                        );
                      })}
                      {Object.entries(nodePos).map(([id, n]) => {
                        const nd = nodeDefs.find(d=>d.id===id);
                        const labelRight = n.col < 2;
                        return (
                          <g key={id}>
                            <rect x={n.x} y={n.y} width={barW} height={n.h} rx={3} fill={n.color} opacity={0.85}/>
                            <text x={labelRight ? n.x + barW + 5 : n.x - 5} y={n.y + n.h/2 + 4}
                              fill={n.color} fontSize="9" fontWeight="600"
                              textAnchor={labelRight ? "start" : "end"}>{nd ? nd.label : id}</text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })()}
              </svg>
            </div>

          </div>
          );
        })()}

        {/* ═══ YEARLY ═══ */}
        {activeTab==="yearly"&&(
          <div>
            {useFinance && (
              <div style={{marginBottom:8}}>
                <button onClick={()=>setShowFinInTabs(!showFinInTabs)} style={{
                  padding:"3px 10px",borderRadius:5,fontSize:9,fontWeight:600,cursor:"pointer",
                  background:showFinInTabs?C.orangeDim:"#1e293b",
                  color:showFinInTabs?C.orange:C.dim,
                  border:`1px solid ${showFinInTabs?"rgba(251,146,60,0.3)":"#334155"}`,
                }}>{showFinInTabs?"Showing":"Show"} finance costs</button>
              </div>
            )}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>Annual Summary</h3>
              <table style={{width:"100%",fontSize:11,borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                  <th style={{textAlign:"left",padding:"4px 2px",color:C.muted,fontWeight:500}}></th>
                  <th style={{textAlign:"right",padding:"4px 2px",color:C.red,fontWeight:600}}>Current</th>
                  <th style={{textAlign:"right",padding:"4px 2px",color:C.green,fontWeight:600}}>New</th>
                  <th style={{textAlign:"right",padding:"4px 2px",color:C.accent,fontWeight:600}}>Diff</th>
                </tr></thead>
                <tbody>
                  {[
                    {l:"Gas",cv:results.months.reduce((s,m)=>s+m.gasUsage,0),nv:0,u:"kWh"},
                    {l:"Elec (base)",cv:results.months.reduce((s,m)=>s+m.elecUsage,0),nv:results.months.reduce((s,m)=>s+m.baseElec,0),u:"kWh"},
                    {l:"HP Elec",cv:0,nv:results.hpElectricity,u:"kWh",nc:C.accent},
                    {l:"Solar Gen",cv:0,nv:results.solarGenerated,u:"kWh",nc:C.yellow},
                    {l:"Grid Import",cv:results.months.reduce((s,m)=>s+m.elecUsage,0),nv:results.gridImport,u:"kWh",nc:C.orange},
                    {l:"Grid Export",cv:0,nv:results.gridExport,u:"kWh",nc:C.purple},
                  ].map((r,i)=>(
                    <tr key={i}>
                      <td style={{padding:"3px 2px",color:C.dim}}>{r.l}</td>
                      <td style={{textAlign:"right",padding:"3px 2px",fontFamily:mono}}>{r.cv>0?`${r.cv.toFixed(0)} ${r.u}`:"—"}</td>
                      <td style={{textAlign:"right",padding:"3px 2px",fontFamily:mono,color:r.nc||C.text}}>{r.nv>0?`${r.nv.toFixed(0)} ${r.u}`:"—"}</td>
                      <td style={{textAlign:"right",padding:"3px 2px",fontFamily:mono,fontSize:10,color:r.nv<r.cv?C.green:r.nv>r.cv?C.red:C.dim}}>
                        {r.nv!==r.cv?`${r.nv<r.cv?"-":"+"}${Math.abs(r.nv-r.cv).toFixed(0)}`:""}</td>
                    </tr>
                  ))}
                  <tr style={{borderTop:`2px solid ${C.border}`}}>
                    <td style={{padding:"6px 2px",fontWeight:700}}>Energy Cost</td>
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.red,fontWeight:700}}>{fmt(results.currentTotal)}</td>
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.green,fontWeight:700}}>{fmt(results.newTotal)}</td>
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.accent,fontWeight:700}}>{fmt(annualSaving)}</td>
                  </tr>
                  {showFinInTabs && useFinance && (
                    <tr>
                      <td style={{padding:"4px 2px",color:C.orange,fontWeight:600}}>Finance</td>
                      <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.dim}}>—</td>
                      <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.orange,fontWeight:600}}>+{fmt(mp*12)}</td>
                      <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.orange,fontSize:10}}>({fmtD(mp)}/mo)</td>
                    </tr>
                  )}
                  {showFinInTabs && useFinance && (
                    <tr style={{borderTop:`2px solid ${C.border}`}}>
                      <td style={{padding:"6px 2px",fontWeight:700}}>Net Annual</td>
                      <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.red,fontWeight:700}}>{fmt(results.currentTotal)}</td>
                      <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:(results.newTotal+mp*12)<results.currentTotal?C.green:C.red,fontWeight:700}}>
                        {fmt(results.newTotal+mp*12)}</td>
                      <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,
                        color:netAnnualDuringFinance>0?C.green:C.red,fontWeight:700}}>
                        {netAnnualDuringFinance>=0?"":"-"}{fmt(Math.abs(netAnnualDuringFinance))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Monthly breakdown bars */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 8px"}}>Monthly Breakdown</h3>
              <table style={{width:"100%",fontSize:10,borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                  <th style={{textAlign:"left",padding:"3px 2px",color:C.muted,fontWeight:500,fontSize:9}}>Month</th>
                  <th style={{textAlign:"right",padding:"3px 2px",color:C.red,fontWeight:600,fontSize:9}}>Current</th>
                  <th style={{textAlign:"right",padding:"3px 2px",color:C.green,fontWeight:600,fontSize:9}}>Energy</th>
                  {showFinInTabs&&useFinance&&<th style={{textAlign:"right",padding:"3px 2px",color:C.orange,fontWeight:600,fontSize:9}}>+Fin</th>}
                  <th style={{textAlign:"right",padding:"3px 2px",color:C.accent,fontWeight:600,fontSize:9}}>Saving</th>
                </tr></thead>
                <tbody>
                  {results.months.map((md,i)=>{
                    const moFin = showFinInTabs && useFinance ? mp : 0;
                    const moTotal = md.newTotal + moFin;
                    const sav = md.currentTotal - moTotal;
                    return (
                      <tr key={i} style={{borderBottom:`1px solid ${C.border}22`}}>
                        <td style={{padding:"4px 2px",color:C.dim,fontWeight:600}}>{md.month.substring(0,3)}</td>
                        <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.red}}>{fmtD(md.currentTotal)}</td>
                        <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.green}}>{fmtD(md.newTotal)}</td>
                        {showFinInTabs&&useFinance&&<td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,color:C.orange}}>{fmtD(moTotal)}</td>}
                        <td style={{textAlign:"right",padding:"4px 2px",fontFamily:mono,fontWeight:600,
                          color:sav>=0?C.accent:C.red}}>{sav>=0?"":"-"}{fmtD(Math.abs(sav))}</td>
                      </tr>
                    );
                  })}
                  <tr style={{borderTop:`2px solid ${C.border}`}}>
                    <td style={{padding:"6px 2px",fontWeight:700}}>Total</td>
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.red,fontWeight:700}}>{fmt(results.currentTotal)}</td>
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.green,fontWeight:700}}>{fmt(results.newTotal)}</td>
                    {showFinInTabs&&useFinance&&<td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,color:C.orange,fontWeight:700}}>{fmt(results.newTotal+mp*12)}</td>}
                    <td style={{textAlign:"right",padding:"6px 2px",fontFamily:mono,fontWeight:700,
                      color:(showFinInTabs&&useFinance?netAnnualDuringFinance:annualSaving)>=0?C.accent:C.red}}>
                      {(showFinInTabs&&useFinance?netAnnualDuringFinance:annualSaving)>=0?"":"-"}
                      {fmt(Math.abs(showFinInTabs&&useFinance?netAnnualDuringFinance:annualSaving))}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Annual stats */}
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
              {[
                {l:"SOLAR",v:`${results.solarGenerated.toFixed(0)} kWh`,sub:`${solarKWp} kWp`,bg:C.yellowDim,c:solarKWp>0?C.yellow:C.dim},
                {l:"SELF-USE",v:`${results.solarSelfConsumed.toFixed(0)} kWh`,sub:`${results.solarGenerated>0?((results.solarSelfConsumed/results.solarGenerated)*100).toFixed(0):0}%`,bg:C.greenDim,c:C.green},
                {l:"GRID IMPORT",v:`${results.gridImport.toFixed(0)} kWh`,sub:"from grid",bg:C.orangeDim,c:C.orange},
                {l:"GRID EXPORT",v:`${results.gridExport.toFixed(0)} kWh`,sub:"sold to grid",bg:C.purpleDim,c:C.purple},
                {l:"HP ELEC",v:`${results.hpElectricity.toFixed(0)} kWh`,sub:"heat pump",bg:C.accentDim,c:C.accent},
                {l:"BATTERY",v:`${batteryKWh} kWh`,sub:`${batteryPowerKW} kW`,bg:C.blueDim,c:batteryKWh>0?C.blue:C.dim},
              ].map((s,i)=>(
                <div key={i} style={{flex:"1 1 30%",background:s.bg,borderRadius:7,padding:8,textAlign:"center"}}>
                  <div style={{fontSize:8,color:C.muted}}>{s.l}</div>
                  <div style={{fontSize:14,color:s.c,fontWeight:700,fontFamily:mono,marginTop:2}}>{s.v}</div>
                  {s.sub && <div style={{fontSize:8,color:C.dim,marginTop:1}}>{s.sub}</div>}
                </div>
              ))}
            </div>

            {/* 25-Year Projection */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13}}>
              <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>25-Year Projection</h3>
              {(()=>{
                const rows = [];
                let cumCash = useFinance ? -deposit : -netCost;
                let cumSaving = 0;
                let cumFinance = 0;
                let hitBreakEven = false;

                for (let y = 1; y <= 25; y++) {
                  const inFinTerm = useFinance && y <= financeTerm;
                  const yrFinance = inFinTerm ? mp * 12 : 0;
                  const yrNet = annualSaving - yrFinance;
                  cumSaving += annualSaving;
                  cumFinance += yrFinance;
                  cumCash += yrNet;
                  const isBreakEven = !hitBreakEven && cumCash >= 0;
                  if (isBreakEven) hitBreakEven = true;

                  rows.push({
                    y, saving: annualSaving, finance: yrFinance, net: yrNet,
                    cumCash, cumSaving, cumFinance, isBreakEven, inFinTerm,
                  });
                }

                return (
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",fontSize:10,borderCollapse:"collapse",minWidth:showFinInTabs&&useFinance?420:320}}>
                      <thead><tr style={{borderBottom:`2px solid ${C.border}`}}>
                        <th style={{textAlign:"left",padding:"4px 3px",color:C.muted,fontWeight:500,position:"sticky",left:0,background:C.card,zIndex:1}}>Yr</th>
                        <th style={{textAlign:"right",padding:"4px 3px",color:C.green,fontWeight:600}}>Saving</th>
                        {showFinInTabs&&useFinance&&<th style={{textAlign:"right",padding:"4px 3px",color:C.orange,fontWeight:600}}>Finance</th>}
                        {showFinInTabs&&useFinance&&<th style={{textAlign:"right",padding:"4px 3px",color:C.accent,fontWeight:600}}>Net</th>}
                        <th style={{textAlign:"right",padding:"4px 3px",color:C.blue,fontWeight:600}}>Cumulative</th>
                      </tr></thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.y} style={{
                            borderBottom:`1px solid ${C.border}22`,
                            background:r.isBreakEven?"rgba(52,211,153,0.08)":r.cumCash<0?"rgba(248,113,113,0.03)":"transparent",
                          }}>
                            <td style={{padding:"4px 3px",fontWeight:r.isBreakEven?700:400,color:r.isBreakEven?C.green:C.dim,
                              position:"sticky",left:0,background:r.isBreakEven?"rgba(52,211,153,0.08)":C.card,zIndex:1}}>
                              {r.y}{r.isBreakEven?" ✓":""}
                            </td>
                            <td style={{textAlign:"right",padding:"4px 3px",fontFamily:mono,color:C.green}}>{fmt(r.saving)}</td>
                            {showFinInTabs&&useFinance&&<td style={{textAlign:"right",padding:"4px 3px",fontFamily:mono,
                              color:r.inFinTerm?C.orange:C.dim}}>{r.inFinTerm?`-${fmt(r.finance)}`:"—"}</td>}
                            {showFinInTabs&&useFinance&&<td style={{textAlign:"right",padding:"4px 3px",fontFamily:mono,fontWeight:600,
                              color:r.net>=0?C.green:C.red}}>{r.net>=0?"":"-"}{fmt(Math.abs(r.net))}</td>}
                            <td style={{textAlign:"right",padding:"4px 3px",fontFamily:mono,fontWeight:600,
                              color:r.cumCash>=0?C.blue:C.red}}>{r.cumCash>=0?"":"-"}{fmt(Math.abs(r.cumCash))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* ═══ AGILE DATA ═══ */}
        {activeTab==="agile"&&(
          <div>
            {/* Region selector and load button */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 8px",color:C.orange}}>📡 Real Data Sources</h3>
              <div style={{fontSize:10,color:C.dim,marginBottom:10,lineHeight:1.5}}>
                Upload real data for accurate results. Without uploads, the simulator uses synthetic UK averages.
              </div>

              {/* ── AGILE PRICES ── */}
              <div style={{background:C.orangeDim,border:"1px solid rgba(251,146,60,0.2)",borderRadius:8,padding:10,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{fontSize:10,fontWeight:600,color:C.orange}}>⚡ AGILE IMPORT PRICES</div>
                  {priceData && <span style={{fontSize:8,color:C.green,background:C.greenDim,padding:"2px 6px",borderRadius:8,fontWeight:600}}>
                    {Object.keys(priceData.dayData).length}d loaded
                  </span>}
                </div>
                <div style={{display:"flex",gap:6,marginBottom:6}}>
                  <label style={{
                    flex:1,display:"block",textAlign:"center",padding:"8px 0",
                    background:priceData?"rgba(52,211,153,0.08)":"#1e293b",
                    border:`1px dashed ${priceData?C.green:"#475569"}`,
                    borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,
                    color:priceData?C.green:C.dim,
                  }}>
                    {priceData?"✓ Loaded — replace":"📁 Upload file"}
                    <input type="file" accept=".csv,.tsv,.json,.txt" style={{display:"none"}}
                      onChange={e=>{if(e.target.files[0])handleAgileCSV(e.target.files[0]);}}/>
                  </label>
                  <button onClick={()=>{setPasteMode(pasteMode==="agile"?null:"agile");setPasteText("");}} style={{
                    flex:1,padding:"8px 0",background:pasteMode==="agile"?C.orangeDim:"#1e293b",
                    border:`1px solid ${pasteMode==="agile"?C.orange:"#475569"}`,borderRadius:6,
                    fontSize:10,fontWeight:600,color:pasteMode==="agile"?C.orange:C.dim,cursor:"pointer",
                  }}>{pasteMode==="agile"?"Cancel":"📋 Paste JSON"}</button>
                </div>
                {loadError && <div style={{fontSize:10,color:loadError.startsWith("Paste error")?C.red:C.green,marginBottom:6,lineHeight:1.4}}>{loadError.startsWith("Paste error")?"⚠️ ":"✓ "}{loadError}</div>}

                {pasteMode==="agile" ? (
                  <div>
                    <textarea value={pasteText} onChange={e=>setPasteText(e.target.value)}
                      placeholder="Paste the JSON data from the Octopus API here..."
                      style={{...inputSt,width:"100%",height:100,resize:"vertical",fontSize:10,marginBottom:6}}/>
                    <button onClick={handlePasteLoad} disabled={!pasteText.trim()} style={{
                      width:"100%",padding:"8px 0",background:pasteText.trim()?C.orange:"#334155",
                      border:"none",borderRadius:6,color:pasteText.trim()?C.bg:C.muted,
                      fontSize:11,fontWeight:700,cursor:pasteText.trim()?"pointer":"default",marginBottom:4,
                    }}>Load pasted data</button>
                  </div>
                ) : (
                  <div>
                    <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
                      <select value={region} onChange={e=>setRegion(e.target.value)} style={{flex:1,fontSize:10,padding:"5px 6px"}}>
                        {DNO_REGIONS.map(r=><option key={r.code} value={r.code}>{r.code} — {r.name}</option>)}
                      </select>
                    </div>
                    <div style={{fontSize:10,color:C.text,fontWeight:600,marginBottom:4}}>Open each month → Select All → Copy → Paste:</div>
                    <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:6}}>
                      {agileMonthUrls.map((m,i) => (
                        <a key={i} href={m.url} target="_blank" rel="noopener" style={{
                          padding:"4px 7px",background:"#1e293b",textDecoration:"none",
                          border:"1px solid #475569",borderRadius:5,
                          color:C.orange,fontSize:9,fontWeight:600,
                        }}>{m.label}</a>
                      ))}
                    </div>
                    <div style={{fontSize:9,color:C.dim,lineHeight:1.5}}>
                      Each link = 1 month. Paste accumulates — do all 12 for a full year.
                      Or: <a href="https://energy-stats.uk/download-historical-pricing-data/" target="_blank" rel="noopener" style={{color:C.orange,textDecoration:"underline"}}>energy-stats.uk</a> has full-year CSV downloads.
                      {agileRaw && <button onClick={()=>{setAgileRaw(null);setLoadError(null);}} style={{
                        marginLeft:6,fontSize:8,color:C.red,background:"none",border:`1px solid ${C.red}`,
                        borderRadius:4,padding:"1px 5px",cursor:"pointer",opacity:0.7,
                      }}>Clear</button>}
                    </div>
                  </div>
                )}
              </div>

              {/* ── AGILE EXPORT PRICES ── */}
              <div style={{background:C.purpleDim,border:"1px solid rgba(167,139,250,0.2)",borderRadius:8,padding:10,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{fontSize:10,fontWeight:600,color:C.purple}}>📤 AGILE OUTGOING (Export Prices)</div>
                  {exportPriceData && <span style={{fontSize:8,color:C.green,background:C.greenDim,padding:"2px 6px",borderRadius:8,fontWeight:600}}>
                    {Object.keys(exportPriceData.dayData).length}d loaded
                  </span>}
                </div>
                <div style={{display:"flex",gap:6,marginBottom:6}}>
                  <label style={{
                    flex:1,display:"block",textAlign:"center",padding:"8px 0",
                    background:exportPriceData?"rgba(52,211,153,0.08)":"#1e293b",
                    border:`1px dashed ${exportPriceData?C.green:"#475569"}`,
                    borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,
                    color:exportPriceData?C.green:C.dim,
                  }}>
                    {exportPriceData?"✓ Loaded — replace":"📁 Upload file"}
                    <input type="file" accept=".csv,.tsv,.json,.txt" style={{display:"none"}}
                      onChange={e=>{if(e.target.files[0])handleAgileCSV(e.target.files[0],true);}}/>
                  </label>
                  <button onClick={()=>{setPasteMode(pasteMode==="export"?null:"export");setPasteText("");}} style={{
                    flex:1,padding:"8px 0",background:pasteMode==="export"?C.purpleDim:"#1e293b",
                    border:`1px solid ${pasteMode==="export"?C.purple:"#475569"}`,borderRadius:6,
                    fontSize:10,fontWeight:600,color:pasteMode==="export"?C.purple:C.dim,cursor:"pointer",
                  }}>{pasteMode==="export"?"Cancel":"📋 Paste JSON"}</button>
                </div>
                {exportLoadError && <div style={{fontSize:10,color:exportLoadError.startsWith("Paste error")||exportLoadError.startsWith("CSV error")?C.red:C.green,marginBottom:6,lineHeight:1.4}}>{exportLoadError.startsWith("Paste error")||exportLoadError.startsWith("CSV error")?"⚠️ ":"✓ "}{exportLoadError}</div>}

                {pasteMode==="export" ? (
                  <div>
                    <textarea value={pasteText} onChange={e=>setPasteText(e.target.value)}
                      placeholder="Paste the JSON data from the Octopus Agile Outgoing API here..."
                      style={{...inputSt,width:"100%",height:100,resize:"vertical",fontSize:10,marginBottom:6}}/>
                    <button onClick={handlePasteLoad} disabled={!pasteText.trim()} style={{
                      width:"100%",padding:"8px 0",background:pasteText.trim()?C.purple:"#334155",
                      border:"none",borderRadius:6,color:pasteText.trim()?C.bg:C.muted,
                      fontSize:11,fontWeight:700,cursor:pasteText.trim()?"pointer":"default",marginBottom:4,
                    }}>Load pasted export data</button>
                  </div>
                ) : (
                  <div>
                    <div style={{fontSize:10,color:C.text,fontWeight:600,marginBottom:4}}>Open each month → Select All → Copy → Paste:</div>
                    <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:6}}>
                      {exportMonthUrls.map((m,i) => (
                        <a key={i} href={m.url} target="_blank" rel="noopener" style={{
                          padding:"4px 7px",background:"#1e293b",textDecoration:"none",
                          border:"1px solid #475569",borderRadius:5,
                          color:C.purple,fontSize:9,fontWeight:600,
                        }}>{m.label}</a>
                      ))}
                    </div>
                    <div style={{fontSize:9,color:C.dim,lineHeight:1.5}}>
                      Same process as import — different Octopus product ({AGILE_EXPORT_PRODUCT}).
                      {!exportPriceData && <span style={{color:C.orange}}> Without export data, a fixed rate of {exportRate}p/kWh is used.</span>}
                      {agileExportRaw && <button onClick={()=>setAgileExportRaw(null)} style={{
                        marginLeft:6,fontSize:8,color:C.red,background:"none",border:`1px solid ${C.red}`,
                        borderRadius:4,padding:"1px 5px",cursor:"pointer",opacity:0.7,
                      }}>Clear</button>}
                    </div>
                  </div>
                )}
              </div>

              {/* ── SOLAR IRRADIANCE ── */}
              <div style={{background:C.yellowDim,border:"1px solid rgba(251,191,36,0.2)",borderRadius:8,padding:10,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{fontSize:10,fontWeight:600,color:C.yellow}}>☀️ SOLAR IRRADIANCE</div>
                  {solarDataProcessed && <span style={{fontSize:8,color:C.green,background:C.greenDim,padding:"2px 6px",borderRadius:8,fontWeight:600}}>
                    {Object.keys(solarRaw).length}d loaded
                  </span>}
                </div>
                <div style={{display:"flex",gap:6,marginBottom:6}}>
                  <label style={{
                    flex:1,display:"block",textAlign:"center",padding:"8px 0",
                    background:solarDataProcessed?"rgba(52,211,153,0.08)":"#1e293b",
                    border:`1px dashed ${solarDataProcessed?C.green:"#475569"}`,
                    borderRadius:6,cursor:"pointer",fontSize:10,fontWeight:600,
                    color:solarDataProcessed?C.green:C.dim,
                  }}>
                    {solarDataProcessed?"✓ Loaded — replace":"📁 Upload file"}
                    <input type="file" accept=".csv,.tsv,.json,.txt" style={{display:"none"}}
                      onChange={e=>{if(e.target.files[0])handleSolarCSV(e.target.files[0]);}}/>
                  </label>
                  <button onClick={()=>{setPasteMode(pasteMode==="solar"?null:"solar");setPasteText("");}} style={{
                    flex:1,padding:"8px 0",background:pasteMode==="solar"?C.yellowDim:"#1e293b",
                    border:`1px solid ${pasteMode==="solar"?C.yellow:"#475569"}`,borderRadius:6,
                    fontSize:10,fontWeight:600,color:pasteMode==="solar"?C.yellow:C.dim,cursor:"pointer",
                  }}>{pasteMode==="solar"?"Cancel":"📋 Paste JSON"}</button>
                </div>
                {solarError && <div style={{fontSize:10,color:solarError.startsWith("Paste error")?C.red:C.green,marginBottom:6,lineHeight:1.4}}>{solarError.startsWith("Paste error")?"⚠️ ":"✓ "}{solarError}</div>}

                {pasteMode==="solar" ? (
                  <div>
                    <textarea value={pasteText} onChange={e=>setPasteText(e.target.value)}
                      placeholder="Paste the JSON from Open-Meteo here..."
                      style={{...inputSt,width:"100%",height:100,resize:"vertical",fontSize:10,marginBottom:6}}/>
                    <button onClick={handlePasteLoad} disabled={!pasteText.trim()} style={{
                      width:"100%",padding:"8px 0",background:pasteText.trim()?C.yellow:"#334155",
                      border:"none",borderRadius:6,color:pasteText.trim()?C.bg:C.muted,
                      fontSize:11,fontWeight:700,cursor:pasteText.trim()?"pointer":"default",marginBottom:4,
                    }}>Load pasted data</button>
                  </div>
                ) : (
                  <div>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
                      {[
                        {l:"London",la:51.5,lo:-0.12},{l:"Manchester",la:53.48,lo:-2.24},
                        {l:"Birmingham",la:52.49,lo:-1.89},{l:"Edinburgh",la:55.95,lo:-3.19},
                        {l:"Bristol",la:51.45,lo:-2.59},{l:"Cardiff",la:51.48,lo:-3.18},
                      ].map(c=>(
                        <button key={c.l} onClick={()=>{setLat(c.la);setLon(c.lo);}} style={{
                          background:Math.abs(lat-c.la)<0.1&&Math.abs(lon-c.lo)<0.1?C.yellow:"#1e293b",
                          color:Math.abs(lat-c.la)<0.1&&Math.abs(lon-c.lo)<0.1?C.bg:C.dim,
                          border:`1px solid ${Math.abs(lat-c.la)<0.1&&Math.abs(lon-c.lo)<0.1?C.yellow:"#334155"}`,
                          borderRadius:5,padding:"2px 6px",fontSize:9,fontWeight:600,cursor:"pointer",
                        }}>{c.l}</button>
                      ))}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 70px",gap:6,marginBottom:6}}>
                      <div><label style={{fontSize:8,color:C.muted}}>Lat</label>
                      <input type="number" value={lat} onChange={e=>setLat(parseFloat(e.target.value)||51.5)} style={{...inputSt,fontSize:11,padding:"4px 6px"}} step="0.01"/></div>
                      <div><label style={{fontSize:8,color:C.muted}}>Lon</label>
                      <input type="number" value={lon} onChange={e=>setLon(parseFloat(e.target.value)||0)} style={{...inputSt,fontSize:11,padding:"4px 6px"}} step="0.01"/></div>
                      <div><label style={{fontSize:8,color:C.muted}}>&nbsp;</label>
                      <a href={solarApiUrl} target="_blank" rel="noopener" style={{
                        width:"100%",padding:"4px 0",background:"#1e293b",textDecoration:"none",textAlign:"center",
                        border:"1px solid #475569",borderRadius:6,display:"block",
                        color:C.dim,fontSize:9,fontWeight:600,
                      }}>Open</a></div>
                    </div>
                    <div style={{fontSize:10,color:C.dim,lineHeight:1.5}}>
                      Tap "Open" → Select All → Copy → come back → "Paste JSON".
                      {solarRaw && <button onClick={()=>{setSolarRaw(null);setSolarError(null);}} style={{
                        marginLeft:6,fontSize:8,color:C.red,background:"none",border:`1px solid ${C.red}`,
                        borderRadius:4,padding:"1px 5px",cursor:"pointer",opacity:0.7,
                      }}>Clear</button>}
                    </div>
                  </div>
                )}
              </div>

              {/* Data summary */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
                <div style={{padding:8,background:priceData?C.greenDim:"#1a1a2e",borderRadius:7,textAlign:"center"}}>
                  <div style={{fontSize:8,color:C.muted}}>AGILE PRICES</div>
                  <div style={{fontSize:14,fontWeight:700,fontFamily:mono,color:priceData?C.green:C.muted,marginTop:2}}>
                    {priceData?`${Object.keys(priceData.dayData).length} days`:"synthetic"}
                  </div>
                </div>
                <div style={{padding:8,background:solarDataProcessed?C.yellowDim:"#1a1a2e",borderRadius:7,textAlign:"center"}}>
                  <div style={{fontSize:8,color:C.muted}}>SOLAR IRRADIANCE</div>
                  <div style={{fontSize:14,fontWeight:700,fontFamily:mono,color:solarDataProcessed?C.yellow:C.muted,marginTop:2}}>
                    {solarRaw?`${Object.keys(solarRaw).length} days`:"synthetic"}
                  </div>
                </div>
              </div>

              {solarDataProcessed && (
                <div style={{marginTop:8,padding:8,background:C.yellowDim,borderRadius:7}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:4}}>REAL SOLAR GENERATION ({solarKWp} kWp at {solarTilt}° / {solarAzimuth}°)</div>
                  <div style={{display:"flex",gap:6,fontSize:10}}>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{color:C.yellow,fontFamily:mono,fontWeight:700,fontSize:14}}>
                        {solarDataProcessed.stats.reduce((s,m)=>s+m.totalKWh,0).toFixed(0)}
                      </div>
                      <div style={{color:C.dim,fontSize:8}}>kWh/year</div>
                    </div>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{color:C.green,fontFamily:mono,fontWeight:700,fontSize:14}}>
                        {Math.max(...solarDataProcessed.stats.map(m=>m.peakDay)).toFixed(1)}
                      </div>
                      <div style={{color:C.dim,fontSize:8}}>best day kWh</div>
                    </div>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{color:C.orange,fontFamily:mono,fontWeight:700,fontSize:14}}>
                        {(solarDataProcessed.stats.reduce((s,m)=>s+m.totalKWh,0)/365).toFixed(1)}
                      </div>
                      <div style={{color:C.dim,fontSize:8}}>avg/day kWh</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Day-ahead explainer */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 6px"}}>Day-Ahead Battery Optimisation</h3>
              <div style={{fontSize:11,color:C.dim,lineHeight:1.7}}>
                <p style={{margin:"0 0 6px"}}>Octopus publishes the next day's 48 half-hourly prices between <strong style={{color:C.orange}}>4pm and 8pm</strong> each day, based on the day-ahead wholesale market.</p>
                <p style={{margin:"0 0 6px"}}>A smart battery controller (e.g. GivEnergy, Capture AI, Predbat) uses these prices to plan optimal charge/discharge cycles — charging in the cheapest ~4 hour window and discharging during the most expensive ~4 hours.</p>
                <p style={{margin:0}}>This simulator models that strategy: for each day it identifies the cheapest and most expensive slots from the full day's prices and schedules the battery accordingly. This is realistic for any system with day-ahead optimisation.</p>
              </div>
            </div>

            {/* Monthly price profiles */}
            <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
              {MONTHS.map((m,i)=>(
                <button key={i} onClick={()=>setSelectedMonth(i)} style={{
                  background:selectedMonth===i?C.orange:C.card,color:selectedMonth===i?C.bg:C.muted,
                  border:`1px solid ${selectedMonth===i?C.orange:C.border}`,borderRadius:6,
                  padding:"4px 8px",fontSize:10,fontWeight:600,cursor:"pointer",
                }}>{m}</button>
              ))}
            </div>

            {priceData && priceData.monthStats[selectedMonth].days > 0 ? (
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <h3 style={{fontSize:12,fontWeight:600,margin:0}}>
                    Real Agile Profile — {MONTHS[selectedMonth]}
                    <span style={{fontSize:10,fontWeight:400,color:C.dim,marginLeft:6}}>({priceData.monthStats[selectedMonth].days} days avg)</span>
                  </h3>
                  <span style={{fontSize:9,color:C.orange}}>━ avg · <span style={{opacity:0.3}}>█</span> range</span>
                </div>
                <RealPriceChart monthStats={priceData.monthStats} month={selectedMonth}/>
                <div style={{display:"flex",gap:5,marginTop:7}}>
                  {[
                    {l:"LOW",v:`${priceData.monthStats[selectedMonth].minPrice.toFixed(1)}p`,bg:C.greenDim,c:C.green},
                    {l:"AVG",v:`${priceData.monthStats[selectedMonth].avgPrice.toFixed(1)}p`,bg:C.accentDim,c:C.accent},
                    {l:"PEAK",v:`${priceData.monthStats[selectedMonth].maxPrice.toFixed(1)}p`,bg:C.redDim,c:C.red},
                  ].map((s,i)=>(
                    <div key={i} style={{flex:1,padding:6,background:s.bg,borderRadius:6,textAlign:"center"}}>
                      <div style={{fontSize:7,color:C.muted}}>{s.l}</div>
                      <div style={{fontSize:13,fontWeight:700,fontFamily:mono,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13}}>
                <div style={{fontSize:11,color:C.dim}}>No real data for {MONTHS[selectedMonth]}. Load data to see actual Agile price profiles.</div>
              </div>
            )}

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:13}}>
              <h3 style={{fontSize:12,fontWeight:600,margin:"0 0 7px"}}>Battery Strategy</h3>
              <div style={{fontSize:11,color:C.dim,lineHeight:1.8}}>
                {[
                  {c:C.green,l:"CHARGE",d:"cheapest ~4h window (day-ahead optimised)"},
                  {c:C.yellow,l:"STORE SOLAR",d:"excess PV → battery before grid export"},
                  {c:C.red,l:"DISCHARGE",d:"most expensive ~4h (avoid peak import)"},
                  {c:C.purple,l:"EXPORT",d:"Expensive slots: sell surplus to grid at Agile rate"},
                ].map((s,i)=>(
                  <div key={i} style={{display:"flex",gap:7,alignItems:"center",marginBottom:3}}>
                    <span style={{background:s.c,width:8,height:8,borderRadius:"50%",flexShrink:0}}/>
                    <span><strong style={{color:s.c}}>{s.l}</strong> {s.d}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
