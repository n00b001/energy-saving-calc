import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  C,
  mono,
  fmt,
  fmtD,
  MONTHS,
  DAYS_IN_MONTH,
  repairJSON,
  AGILE_PRODUCT,
  AGILE_EXPORT_PRODUCT,
} from "./utils";
import {
  calcMP,
  simulate,
  monthlySolarStats,
} from "./engine";
import {
  Stat,
  Slider,
  CumulativeChart,
  RangeBrush,
  TouchChart,
} from "./components";

// ─── HELPERS ───

function parseCSV(text: string) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = [];
    let inQuote = false,
      current = "";
    for (const ch of lines[i]) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === delim.charAt(0) && !inQuote) {
        vals.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    vals.push(current.trim());
    if (vals.length >= headers.length - 1) {
      const row: any = {};
      headers.forEach((h, j) => {
        row[h] = vals[j] || "";
      });
      rows.push(row);
    }
  }
  return rows;
}

function detectColumns(rows: any[]) {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const valCol =
    keys.find((k) => /consumption|kwh|usage|value|reading|energy|amount/i.test(k)) ||
    keys.find((k) => {
      const v = parseFloat(rows[0][k]);
      return !isNaN(v) && v >= 0 && v < 100;
    });
  const startCol = keys.find((k) => /^start|start.?date|start.?time|date.?time|timestamp|date|time|period/i.test(k));
  const endCol = keys.find((k) => /^end|end.?date|end.?time/i.test(k));

  let intervalMins = 30; // default half-hourly
  if (startCol && rows.length >= 2) {
    const t1 = new Date(rows[0][startCol]).getTime();
    const t2 = new Date(rows[1][startCol]).getTime();
    if (!isNaN(t1) && !isNaN(t2)) {
      const diff = Math.abs(t2 - t1) / 60000;
      if (diff > 0 && diff < 1500) intervalMins = diff;
    }
  }
  return { valCol, startCol, endCol, intervalMins };
}

function processUsageData(rows: any[], type: string) {
  const cols = detectColumns(rows);
  if (!cols || !cols.valCol || !cols.startCol) return null;

  const readings: any[] = [];
  for (const row of rows) {
    const val = parseFloat(row[cols.valCol]);
    const dt = new Date(row[cols.startCol]);
    if (!isNaN(val) && val >= 0 && !isNaN(dt.getTime())) {
      readings.push({ dt, val });
    }
  }
  if (readings.length === 0) return null;

  readings.sort((a, b) => a.dt - b.dt);

  const days: any = {};
  for (const r of readings) {
    const dateKey = `${r.dt.getFullYear()}-${String(r.dt.getMonth() + 1).padStart(2, "0")}-${String(
      r.dt.getDate()
    ).padStart(2, "0")}`;
    if (!days[dateKey]) days[dateKey] = new Array(48).fill(null);
    const slot = r.dt.getHours() * 2 + Math.floor(r.dt.getMinutes() / 30);
    if (slot >= 0 && slot < 48) {
      if (cols.intervalMins >= 55) {
        days[dateKey][slot] = (days[dateKey][slot] || 0) + r.val / 2;
        if (slot + 1 < 48) days[dateKey][slot + 1] = (days[dateKey][slot + 1] || 0) + r.val / 2;
      } else {
        days[dateKey][slot] = r.val;
      }
    }
  }

  const completeDays = Object.values(days).filter((d: any) => d.filter((v: any) => v !== null).length >= 40);
  const avgProfile = new Array(48).fill(0);
  if (completeDays.length > 0) {
    for (const d of completeDays) {
      for (let i = 0; i < 48; i++) avgProfile[i] += (d as any)[i] || 0;
    }
    for (let i = 0; i < 48; i++) avgProfile[i] /= completeDays.length;
  }

  for (const [date, slots] of Object.entries(days)) {
    const s = slots as (number | null)[];
    const filledCount = s.filter((v) => v !== null).length;
    if (filledCount === 0) {
      delete days[date];
      continue;
    }

    const dayTotal = s.reduce((sum, v) => sum + (v || 0), 0);
    const avgDayTotal = avgProfile.reduce((sum, v) => sum + v, 0);

    for (let i = 0; i < 48; i++) {
      if (s[i] === null) {
        let prev: any = null,
          next: any = null;
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          if (s[j] !== null) {
            prev = { idx: j, val: s[j] };
            break;
          }
        }
        for (let j = i + 1; j <= Math.min(47, i + 4); j++) {
          if (s[j] !== null) {
            next = { idx: j, val: s[j] };
            break;
          }
        }

        if (prev && next) {
          const frac = (i - prev.idx) / (next.idx - prev.idx);
          s[i] = prev.val + frac * (next.val - prev.val);
        } else if (avgDayTotal > 0) {
          const scaleFactor = filledCount > 20 ? dayTotal / ((avgDayTotal * filledCount) / 48) : 1;
          s[i] = avgProfile[i] * scaleFactor;
        } else {
          s[i] = 0;
        }
      }
    }
  }

  const monthStats = Array.from({ length: 12 }, () => ({
    days: 0,
    totalKWh: 0,
    avgProfile: new Array(48).fill(0),
    dailyProfiles: [] as number[][],
    avgDailyKWh: 0,
  }));

  for (const [date, slots] of Object.entries(days)) {
    const s = slots as number[];
    const m = parseInt(date.split("-")[1]) - 1;
    monthStats[m].days++;
    monthStats[m].totalKWh += s.reduce((sum, v) => sum + v, 0);
    monthStats[m].dailyProfiles.push(s);
    for (let i = 0; i < 48; i++) monthStats[m].avgProfile[i] += s[i];
  }
  for (const ms of monthStats) {
    if (ms.days > 0) {
      ms.avgProfile = ms.avgProfile.map((v) => v / ms.days);
      ms.avgDailyKWh = ms.totalKWh / ms.days;
    }
  }

  const totalDays = Object.keys(days).length;
  const totalKWh = Object.values(days).reduce((sum: number, d) => sum + (d as number[]).reduce((a, v) => a + v, 0), 0);
  const annualKWh = totalDays > 0 ? (Number(totalKWh) / totalDays) * 365 : 0;

  return {
    type,
    days,
    monthStats,
    totalDays,
    totalKWh,
    annualKWh,
    avgProfile,
    intervalMins: cols.intervalMins,
    dateRange: { from: readings[0].dt, to: readings[readings.length - 1].dt },
  };
}

function organisePriceData(rawData: any[]) {
  const days: any = {};
  for (const rec of rawData) {
    const dt = new Date(rec.valid_from);
    const dateKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
      dt.getUTCDate()
    ).padStart(2, "0")}`;
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({
      slot: dt.getUTCHours() * 2 + Math.floor(dt.getUTCMinutes() / 30),
      price: rec.value_inc_vat,
    });
  }
  const completeDays: any = {};
  for (const [date, slots] of Object.entries(days)) {
    const s = slots as any[];
    if (s.length >= 44) {
      const priceArr = new Array(48).fill(null);
      for (const entry of s) {
        if (entry.slot >= 0 && entry.slot < 48) priceArr[entry.slot] = entry.price;
      }
      for (let i = 0; i < 48; i++) {
        if (priceArr[i] === null) priceArr[i] = priceArr[i - 1] || priceArr[i + 1] || 15;
      }
      completeDays[date] = priceArr;
    }
  }
  return completeDays;
}

function monthlyPriceStats(dayData: any) {
  const monthStats = Array.from({ length: 12 }, () => ({
    days: 0,
    totalSlots: 0,
    sumPrice: 0,
    minPrice: Infinity,
    maxPrice: -Infinity,
    avgProfile: new Array(48).fill(0),
    allDayPrices: [] as number[][],
    avgPrice: 0,
  }));

  for (const [date, prices] of Object.entries(dayData)) {
    const p = prices as number[];
    const m = parseInt(date.split("-")[1]) - 1;
    monthStats[m].days++;
    monthStats[m].allDayPrices.push(p);
    for (let i = 0; i < 48; i++) {
      const val = p[i];
      monthStats[m].sumPrice += val;
      monthStats[m].totalSlots++;
      monthStats[m].avgProfile[i] += val;
      if (val < monthStats[m].minPrice) monthStats[m].minPrice = val;
      if (val > monthStats[m].maxPrice) monthStats[m].maxPrice = val;
    }
  }

  for (const ms of monthStats) {
    if (ms.days > 0) {
      ms.avgProfile = ms.avgProfile.map((v) => v / ms.days);
      ms.avgPrice = ms.sumPrice / ms.totalSlots;
    } else {
      ms.avgPrice = 20;
      ms.minPrice = 5;
      ms.maxPrice = 45;
    }
  }
  return monthStats;
}

export default function EnergySimulator() {
  const [annualGas, setAnnualGas] = useState(12000);
  const [annualElec, setAnnualElec] = useState(3100);
  const [fixedElecRate, setFixedElecRate] = useState(24.5);
  const [fixedGasRate, setFixedGasRate] = useState(6.76);
  const [fixedElecStanding, setFixedElecStanding] = useState(53.35);
  const [fixedGasStanding, setFixedGasStanding] = useState(31.43);
  const [boilerEfficiency, setBoilerEfficiency] = useState(90);
  const [hotWaterKWhPerDay, setHotWaterKWhPerDay] = useState(10);
  const [solarKWp, setSolarKWp] = useState(4.0);
  const [solarTilt, setSolarTilt] = useState(35);
  const [solarAzimuth, setSolarAzimuth] = useState(180);
  const [extraSolarArrays, setExtraSolarArrays] = useState<any[]>([]);
  const [batteryKWh, setBatteryKWh] = useState(10.0);
  const [batteryPowerKW, setBatteryPowerKW] = useState(5.0);
  const [batteryEfficiency, setBatteryEfficiency] = useState(90);
  const [hpFlowTemp, setHpFlowTemp] = useState(45);
  const [exportRate, setExportRate] = useState(15);
  const [agileStanding, setAgileStanding] = useState(46.36);
  const [battStrategy, setBattStrategy] = useState("smart");
  const [agileExportRaw, setAgileExportRaw] = useState<any[] | null>(null);

  const [hpCost, setHpCost] = useState(12000);
  const [solarCost, setSolarCost] = useState(6000);
  const [batteryCost, setBatteryCost] = useState(5500);
  const [installCost, setInstallCost] = useState(3500);
  const [scaffolding, setScaffolding] = useState(800);
  const [busGrant, setBusGrant] = useState(7500);

  const solarRateRef = useRef(6000 / 4.0);
  const battRateRef = useRef(5500 / 10.0);
  const autoScaling = useRef(false);

  const handleSolarCostChange = useCallback(
    (v: number) => {
      if (!autoScaling.current && solarKWp > 0) solarRateRef.current = v / solarKWp;
      setSolarCost(v);
    },
    [solarKWp]
  );
  const handleBatteryCostChange = useCallback(
    (v: number) => {
      if (!autoScaling.current && batteryKWh > 0) battRateRef.current = v / batteryKWh;
      setBatteryCost(v);
    },
    [batteryKWh]
  );

  useEffect(() => {
    autoScaling.current = true;
    setSolarCost(solarKWp > 0 ? Math.round((solarKWp * solarRateRef.current) / 250) * 250 : 0);
    if (solarKWp === 0 && batteryKWh === 0) setBusGrant(0);
    autoScaling.current = false;
  }, [solarKWp]);

  useEffect(() => {
    autoScaling.current = true;
    setBatteryCost(batteryKWh > 0 ? Math.round((batteryKWh * battRateRef.current) / 250) * 250 : 0);
    if (solarKWp === 0 && batteryKWh === 0) setBusGrant(0);
    autoScaling.current = false;
  }, [batteryKWh]);

  const [useFinance, setUseFinance] = useState(false);
  const [financeRate, setFinanceRate] = useState(7.9);
  const [financeTerm, setFinanceTerm] = useState(10);
  const [deposit, setDeposit] = useState(0);

  const [activeTab, setActiveTab] = useState("overview");
  const [selectedMonth, setSelectedMonth] = useState(0);
  const [showFinInTabs, setShowFinInTabs] = useState(true);

  const [clamps, setClamps] = useState<any>({});
  const getClamp = useCallback(
    (key: string, paramMin: number, paramMax: number) => {
      const c = clamps[key];
      if (!c || c.mode === "free") return { mode: "free", min: paramMin, max: paramMax };
      if (c.mode === "fixed") return { mode: "fixed", min: c.min, max: c.min };
      return { mode: "clamp", min: c.min != null ? c.min : paramMin, max: c.max != null ? c.max : paramMax };
    },
    [clamps]
  );
  const cycleClamp = useCallback((key: string, currentVal: number, paramMin: number, paramMax: number) => {
    setClamps((prev: any) => {
      const c = prev[key];
      if (!c || c.mode === "free") return { ...prev, [key]: { mode: "clamp", min: paramMin, max: paramMax } };
      if (c.mode === "clamp") return { ...prev, [key]: { mode: "fixed", min: currentVal, max: currentVal } };
      return { ...prev, [key]: { mode: "free", min: paramMin, max: paramMax } };
    });
  }, []);

  const [optimizing, setOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState(0);
  const [optResult, setOptResult] = useState<string | null>(null);
  const [optGenerations, setOptGenerations] = useState(50);
  const [bestEverCost, setBestEverCost] = useState<number | null>(null);
  const [optTarget, setOptTarget] = useState("monthly");
  const [chartHidden, setChartHidden] = useState<any>({});
  const [detailMonth, setDetailMonth] = useState(6);
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(144);

  const [region, setRegion] = useState("C");
  const [agileRaw, setAgileRaw] = useState<any[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportLoadError, setExportLoadError] = useState<string | null>(null);

  const [lat, setLat] = useState(51.5);
  const [lon, setLon] = useState(-0.12);
  const [solarRaw, setSolarRaw] = useState<any | null>(null);
  const [solarError, setSolarError] = useState<string | null>(null);

  const [elecUsageData, setElecUsageData] = useState<any | null>(null);
  const [gasUsageData, setGasUsageData] = useState<any | null>(null);
  const [uploadStatus, setUploadStatus] = useState<any>({ elec: null, gas: null });

  const handleFileUpload = useCallback((file: File, type: string) => {
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const rows = parseCSV(e.target.result);
        if (rows.length < 10) throw new Error("Too few rows — need at least 10 data points");
        const processed = processUsageData(rows, type);
        if (!processed) throw new Error("Could not detect date and consumption columns");
        const coveredMonths = processed.monthStats
          .map((ms, i) => (ms.days > 0 ? MONTHS[i] : null))
          .filter(Boolean);
        const gapMonths = 12 - coveredMonths.length;
        const coverageMsg = `${processed.totalDays}d loaded (${coveredMonths.join(", ")}). ${
          gapMonths > 0 ? gapMonths + " months estimated to match your annual target." : "Full year!"
        }`;
        if (type === "electricity") {
          setElecUsageData(processed);
          setUploadStatus((s: any) => ({ ...s, elec: coverageMsg }));
        } else {
          setGasUsageData(processed);
          setUploadStatus((s: any) => ({ ...s, gas: coverageMsg }));
        }
      } catch (err: any) {
        setUploadStatus((s: any) => ({ ...s, [type === "electricity" ? "elec" : "gas"]: `Error: ${err.message}` }));
      }
    };
    reader.readAsText(file);
  }, []);

  const handleAgileCSV = useCallback(
    (file: File, isExport?: boolean) => {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        try {
          const text = e.target.result;
          let records;
          try {
            const json = repairJSON(text);
            records = json.results || json;
            if (!Array.isArray(records) || records.length === 0) throw new Error("no array");
          } catch {
            const lines = text
              .trim()
              .split(/\r?\n/)
              .filter((l: string) => l.trim());
            if (lines.length < 48) throw new Error(`Only ${lines.length} lines — need 48+ for 1 day`);
            const firstFields = lines[0].split(",").map((f: string) => f.trim().replace(/^"|"$/g, ""));
            const firstLooksLikeDate = /^\d{4}-\d{2}-\d{2}/.test(firstFields[0]);
            const startIdx = firstLooksLikeDate ? 0 : 1;
            records = [];
            for (let i = startIdx; i < lines.length; i++) {
              const fields = lines[i].split(",").map((f: string) => f.trim().replace(/^"|"$/g, ""));
              let dt = null;
              for (const f of fields)
                if (/^\d{4}-\d{2}-\d{2}/.test(f)) {
                  dt = f;
                  break;
                }
              let price = null;
              for (let j = fields.length - 1; j >= 0; j--) {
                const v = parseFloat(fields[j]);
                if (!isNaN(v) && v > -50 && v < 200) {
                  price = v;
                  break;
                }
              }
              if (dt && price !== null) records.push({ valid_from: dt, value_inc_vat: price });
            }
          }
          if (!records || records.length < 48) throw new Error("Need 48+ records");
          const existing = isExport ? agileExportRaw : agileRaw;
          if (existing && existing.length > 0) {
            const existingSet = new Set(existing.map((r) => r.valid_from));
            const newRecs = records.filter((r: any) => !existingSet.has(r.valid_from));
            records = [...existing, ...newRecs].sort(
              (a: any, b: any) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime()
            );
          }
          if (isExport) setAgileExportRaw(records);
          else setAgileRaw(records);
          const errFn = isExport ? setExportLoadError : setLoadError;
          errFn(`Loaded ${records.length} ${isExport ? "export" : "import"} records`);
        } catch (err: any) {
          const errFn = isExport ? setExportLoadError : setLoadError;
          errFn(`CSV error: ${err.message}`);
        }
      };
      reader.readAsText(file);
    },
    [agileRaw, agileExportRaw]
  );

  const handleSolarCSV = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const text = e.target.result;
        let solarDays: any;
        try {
          const json = JSON.parse(text);
          if (json.hourly && json.hourly.shortwave_radiation) {
            const days: any = {};
            const times = json.hourly.time;
            const ghi = json.hourly.shortwave_radiation;
            const temp = json.hourly.temperature_2m || times.map(() => 12);
            for (let i = 0; i < times.length; i++) {
              const dateKey = times[i].substring(0, 10);
              if (!days[dateKey]) days[dateKey] = { ghi: [], temp: [], cloud: [] };
              days[dateKey].ghi.push(ghi[i] || 0);
              days[dateKey].temp.push(temp[i] || 12);
            }
            solarDays = {};
            for (const [d, v] of Object.entries(days)) {
              const entry = v as any;
              if (entry.ghi.length >= 23) {
                while (entry.ghi.length < 24) {
                  entry.ghi.push(0);
                  entry.temp.push(12);
                }
                solarDays[d] = entry;
              }
            }
          } else throw new Error("not open-meteo json");
        } catch {
          const rows = parseCSV(text);
          const keys = Object.keys(rows[0]);
          const ghiCol = keys.find((k) => /shortwave|radiation|ghi|irradiance|solar/i.test(k));
          const tempCol = keys.find((k) => /temperature|temp/i.test(k));
          const timeCol = keys.find((k) => /time|date|timestamp/i.test(k));
          solarDays = {};
          if (timeCol && ghiCol) {
            for (const row of rows) {
              const dateKey = (row[timeCol] || "").substring(0, 10);
              if (!dateKey || dateKey.length < 10) continue;
              if (!solarDays[dateKey]) solarDays[dateKey] = { ghi: [], temp: [], cloud: [] };
              solarDays[dateKey].ghi.push(parseFloat(row[ghiCol]) || 0);
              solarDays[dateKey].temp.push(parseFloat(row[tempCol || "12"]) || 12);
            }
            for (const [d, v] of Object.entries(solarDays)) {
              const entry = v as any;
              if (entry.ghi.length < 23) delete solarDays[d];
              else
                while (entry.ghi.length < 24) {
                  entry.ghi.push(0);
                  entry.temp.push(12);
                }
            }
          }
        }
        setSolarRaw(solarDays);
        setSolarError(null);
      } catch (err: any) {
        setSolarError(`CSV error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const priceData = useMemo(() => {
    if (!agileRaw || agileRaw.length === 0) return null;
    const dayData = organisePriceData(agileRaw);
    return { dayData, monthStats: monthlyPriceStats(dayData) };
  }, [agileRaw]);
  const exportPriceData = useMemo(() => {
    if (!agileExportRaw || agileExportRaw.length === 0) return null;
    const dayData = organisePriceData(agileExportRaw);
    return { dayData, monthStats: monthlyPriceStats(dayData) };
  }, [agileExportRaw]);
  const solarDataProcessed = useMemo(() => {
    if (!solarRaw || Object.keys(solarRaw).length === 0) return null;
    const arrays = [{ kWp: solarKWp, tilt: solarTilt, azimuth: solarAzimuth }, ...extraSolarArrays];
    return { days: solarRaw, stats: monthlySolarStats(solarRaw, arrays) };
  }, [solarRaw, solarKWp, solarTilt, solarAzimuth, extraSolarArrays]);

  const [pasteMode, setPasteMode] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");

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
        url: `${base}?period_from=${from.toISOString().split("T")[0]}T00:00Z&period_to=${
          to.toISOString().split("T")[0]
        }T00:00Z&page_size=1500`,
      });
    }
    return urls;
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
      urls.push({
        label,
        url: `${base}?period_from=${from.toISOString().split("T")[0]}T00:00Z&period_to=${
          to.toISOString().split("T")[0]
        }T00:00Z&page_size=1500`,
      });
    }
    return urls;
  }, [region]);

  const solarApiUrl = useMemo(() => {
    const now = new Date();
    const ago = new Date(now);
    ago.setFullYear(now.getFullYear() - 1);
    const end = new Date(now);
    end.setDate(end.getDate() - 2);
    return `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${
      ago.toISOString().split("T")[0]
    }&end_date=${end.toISOString().split("T")[0]}&hourly=shortwave_radiation,temperature_2m&timezone=Europe%2FLondon`;
  }, [lat, lon]);

  const saveConfig = useCallback(() => {
    const config = {
      annualGas,
      annualElec,
      fixedElecRate,
      fixedGasRate,
      fixedElecStanding,
      fixedGasStanding,
      boilerEfficiency,
      hotWaterKWhPerDay,
      solarKWp,
      solarTilt,
      solarAzimuth,
      batteryKWh,
      batteryPowerKW,
      batteryEfficiency,
      hpFlowTemp,
      exportRate,
      agileStanding,
      battStrategy,
      hpCost,
      solarCost,
      batteryCost,
      installCost,
      scaffolding,
      busGrant,
      useFinance,
      financeRate,
      financeTerm,
      deposit,
      clamps,
      optTarget,
      region,
      lat,
      lon,
    };
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "energy-simulator-config.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [
    annualGas,
    annualElec,
    fixedElecRate,
    fixedGasRate,
    fixedElecStanding,
    fixedGasStanding,
    boilerEfficiency,
    hotWaterKWhPerDay,
    solarKWp,
    solarTilt,
    solarAzimuth,
    batteryKWh,
    batteryPowerKW,
    batteryEfficiency,
    hpFlowTemp,
    exportRate,
    agileStanding,
    battStrategy,
    hpCost,
    solarCost,
    batteryCost,
    installCost,
    scaffolding,
    busGrant,
    useFinance,
    financeRate,
    financeTerm,
    deposit,
    clamps,
    optTarget,
    region,
    lat,
    lon,
  ]);

  const loadConfig = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const config = JSON.parse(e.target.result);
        if (config.annualGas != null) setAnnualGas(config.annualGas);
        if (config.annualElec != null) setAnnualElec(config.annualElec);
        if (config.fixedElecRate != null) setFixedElecRate(config.fixedElecRate);
        if (config.fixedGasRate != null) setFixedGasRate(config.fixedGasRate);
        if (config.fixedElecStanding != null) setFixedElecStanding(config.fixedElecStanding);
        if (config.fixedGasStanding != null) setFixedGasStanding(config.fixedGasStanding);
        if (config.boilerEfficiency != null) setBoilerEfficiency(config.boilerEfficiency);
        if (config.hotWaterKWhPerDay != null) setHotWaterKWhPerDay(config.hotWaterKWhPerDay);
        if (config.solarKWp != null) setSolarKWp(config.solarKWp);
        if (config.solarTilt != null) setSolarTilt(config.solarTilt);
        if (config.solarAzimuth != null) setSolarAzimuth(config.solarAzimuth);
        if (config.batteryKWh != null) setBatteryKWh(config.batteryKWh);
        if (config.batteryPowerKW != null) setBatteryPowerKW(config.batteryPowerKW);
        if (config.batteryEfficiency != null) setBatteryEfficiency(config.batteryEfficiency);
        if (config.hpFlowTemp != null) setHpFlowTemp(config.hpFlowTemp);
        if (config.exportRate != null) setExportRate(config.exportRate);
        if (config.agileStanding != null) setAgileStanding(config.agileStanding);
        if (config.battStrategy != null) setBattStrategy(config.battStrategy);
        if (config.hpCost != null) setHpCost(config.hpCost);
        if (config.solarCost != null) setSolarCost(config.solarCost);
        if (config.batteryCost != null) setBatteryCost(config.batteryCost);
        if (config.installCost != null) setInstallCost(config.installCost);
        if (config.scaffolding != null) setScaffolding(config.scaffolding);
        if (config.busGrant != null) setBusGrant(config.busGrant);
        if (config.useFinance != null) setUseFinance(config.useFinance);
        if (config.financeRate != null) setFinanceRate(config.financeRate);
        if (config.financeTerm != null) setFinanceTerm(config.financeTerm);
        if (config.deposit != null) setDeposit(config.deposit);
        if (config.clamps != null) setClamps(config.clamps);
        if (config.optTarget != null) setOptTarget(config.optTarget);
        if (config.region != null) setRegion(config.region);
        if (config.lat != null) setLat(config.lat);
        if (config.lon != null) setLon(config.lon);
        alert("Configuration loaded successfully!");
      } catch (err: any) {
        alert("Error loading config: " + err.message);
      }
    };
    reader.readAsText(file);
  }, []);

  const handlePasteLoad = useCallback(() => {
    if (!pasteText.trim()) return;
    try {
      if (pasteMode === "agile" || pasteMode === "export") {
        const json = repairJSON(pasteText);
        let records = json.results || json;
        if (!Array.isArray(records)) records = [records];
        records = records.filter(
          (r) => r && r.valid_from && (r.value_inc_vat !== undefined || r.value_exc_vat !== undefined)
        );
        records = records.map((r) => ({
          ...r,
          value_inc_vat: r.value_inc_vat != null ? r.value_inc_vat : (r.value_exc_vat || 0) * 1.05,
        }));

        const existing = pasteMode === "export" ? agileExportRaw : agileRaw;
        if (existing && existing.length > 0) {
          const exSet = new Set(existing.map((r) => r.valid_from));
          records = [...existing, ...records.filter((r) => !exSet.has(r.valid_from))].sort(
            (a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime()
          );
        }
        if (pasteMode === "export") {
          setAgileExportRaw(records);
          setExportLoadError(`Loaded ${records.length} records`);
        } else {
          setAgileRaw(records);
          setLoadError(`Loaded ${records.length} records`);
        }
        setPasteMode(null);
        setPasteText("");
      } else if (pasteMode === "solar") {
        const json = repairJSON(pasteText);
        const days: any = {};
        const times = json.hourly.time;
        const ghi = json.hourly.shortwave_radiation;
        for (let i = 0; i < times.length; i++) {
          if (!times[i]) continue;
          const dk = times[i].substring(0, 10);
          if (!days[dk]) days[dk] = { ghi: [], temp: [] };
          days[dk].ghi.push(ghi[i] || 0);
          days[dk].temp.push(12);
        }
        const merged = solarRaw ? { ...solarRaw, ...days } : days;
        setSolarRaw(merged);
        setPasteMode(null);
        setPasteText("");
      }
    } catch (e) {}
  }, [pasteMode, pasteText, agileRaw, agileExportRaw, solarRaw]);

  const paramDefs = useMemo(() => {
    const base = [
      { key: "solarKWp", label: "Solar 1 kWp", min: 0, max: 12, step: 0.5, get: () => solarKWp, set: setSolarKWp, group: "energy" },
      { key: "solarTilt", label: "Solar 1 Tilt", min: 0, max: 90, step: 5, get: () => solarTilt, set: setSolarTilt, group: "energy" },
      {
        key: "solarAzimuth",
        label: "Solar 1 Azimuth",
        min: 0,
        max: 355,
        step: 5,
        get: () => solarAzimuth,
        set: setSolarAzimuth,
        group: "energy",
      },
    ];
    extraSolarArrays.forEach((arr, idx) => {
      base.push({
        key: `extraSolarKWp_${idx}`,
        label: `Solar ${idx + 2} kWp`,
        min: 0,
        max: 12,
        step: 0.5,
        get: () => extraSolarArrays[idx].kWp,
        set: (v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, kWp: v } : a))),
        group: "extraSolar",
      });
      base.push({
        key: `extraSolarTilt_${idx}`,
        label: `Solar ${idx + 2} Tilt`,
        min: 0,
        max: 90,
        step: 5,
        get: () => extraSolarArrays[idx].tilt,
        set: (v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, tilt: v } : a))),
        group: "extraSolar",
      });
      base.push({
        key: `extraSolarAzimuth_${idx}`,
        label: `Solar ${idx + 2} Azimuth`,
        min: 0,
        max: 355,
        step: 5,
        get: () => extraSolarArrays[idx].azimuth,
        set: (v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, azimuth: v } : a))),
        group: "extraSolar",
      });
    });
    base.push(
      { key: "batteryKWh", label: "Battery kWh", min: 0, max: 25, step: 0.5, get: () => batteryKWh, set: setBatteryKWh, group: "energy" },
      {
        key: "batteryPowerKW",
        label: "Battery kW",
        min: 1,
        max: 12,
        step: 0.5,
        get: () => batteryPowerKW,
        set: setBatteryPowerKW,
        group: "energy",
      },
      {
        key: "batteryEfficiency",
        label: "Batt Eff%",
        min: 80,
        max: 98,
        step: 1,
        get: () => batteryEfficiency,
        set: setBatteryEfficiency,
        group: "energy",
      },
      { key: "hpFlowTemp", label: "HP Flow°C", min: 35, max: 55, step: 5, get: () => hpFlowTemp, set: setHpFlowTemp, group: "energy" },
      { key: "hpCost", label: "HP Cost", min: 6000, max: 18000, step: 500, get: () => hpCost, set: setHpCost, group: "cost" },
      { key: "deposit", label: "Deposit", min: 0, max: 30000, step: 500, get: () => deposit, set: setDeposit, group: "finance" },
      {
        key: "financeRate",
        label: "APR %",
        min: 0,
        max: 15,
        step: 0.1,
        get: () => financeRate,
        set: setFinanceRate,
        group: "finance",
      },
      { key: "financeTerm", label: "Term yrs", min: 3, max: 25, step: 1, get: () => financeTerm, set: setFinanceTerm, group: "finance" }
    );
    return base;
  }, [
    solarKWp,
    solarTilt,
    solarAzimuth,
    extraSolarArrays,
    batteryKWh,
    batteryPowerKW,
    batteryEfficiency,
    hpFlowTemp,
    hpCost,
    deposit,
    financeRate,
    financeTerm,
  ]);

  const runOptimizer = useCallback(async () => {
    setOptimizing(true);
    setOptProgress(0);

    const active = paramDefs.filter((p) => {
      const c = clamps[p.key];
      return !c || c.mode !== "fixed";
    });
    if (active.length === 0) {
      setOptResult("No free/clamped parameters");
      setOptimizing(false);
      return;
    }

    const bounds = active.map((p) => {
      const c = clamps[p.key];
      if (c && c.mode === "clamp") return { min: c.min != null ? c.min : p.min, max: c.max != null ? c.max : p.max };
      return { min: p.min, max: p.max };
    });

    const dim = active.length;
    const popSize = Math.max(15, dim * 5);
    const maxGen = optGenerations;
    const numRestarts = 3;
    const gensPerRestart = Math.ceil(maxGen / numRestarts);

    const baseSimParams = {
      annualGas,
      annualElec,
      fixedElecRate,
      fixedGasRate,
      fixedElecStanding,
      fixedGasStanding,
      boilerEfficiency,
      solarKWp,
      batteryKWh,
      batteryPowerKW,
      batteryEfficiency,
      hpFlowTemp,
      exportRate,
      agileStanding,
      hotWaterKWhPerDay,
      solarTilt,
      solarAzimuth,
      extraSolarArrays,
      battStrategy,
    };
    const baseCostParams = { hpCost, solarCost, batteryCost, installCost, scaffolding, busGrant };
    const baseFinParams = { deposit, financeRate, financeTerm, useFinance };
    const solarCostPerKWp = solarRateRef.current;
    const batteryCostPerKWh = battRateRef.current;

    const evaluate = (vec: number[]) => {
      const simP = { ...baseSimParams };
      const costP = { ...baseCostParams };
      const finP = { ...baseFinParams };
      const extraArrays = JSON.parse(JSON.stringify(extraSolarArrays));

      active.forEach((p, i) => {
        const snapped = Math.round(vec[i] / p.step) * p.step;
        const val = Math.max(bounds[i].min, Math.min(bounds[i].max, snapped));
        if (p.group === "energy") (simP as any)[p.key] = val;
        else if (p.group === "cost") (costP as any)[p.key] = val;
        else if (p.group === "finance") (finP as any)[p.key] = val;
        else if (p.group === "extraSolar") {
          const [key, idx] = p.key.split("_");
          const arrayIdx = parseInt(idx);
          if (key === "extraSolarKWp") extraArrays[arrayIdx].kWp = val;
          else if (key === "extraSolarTilt") extraArrays[arrayIdx].tilt = val;
          else if (key === "extraSolarAzimuth") extraArrays[arrayIdx].azimuth = val;
        }
      });
      simP.extraSolarArrays = extraArrays;
      costP.solarCost = simP.solarKWp * solarCostPerKWp;
      costP.batteryCost = simP.batteryKWh * batteryCostPerKWh;

      let currentSolarData = solarDataProcessed;
      if (solarDataProcessed && solarDataProcessed.days) {
        const arrays = [{ kWp: simP.solarKWp, tilt: simP.solarTilt, azimuth: simP.solarAzimuth }, ...extraArrays];
        currentSolarData = { days: solarDataProcessed.days, stats: monthlySolarStats(solarDataProcessed.days, arrays) };
      }

      const res = simulate(simP, priceData, currentSolarData, elecUsageData, gasUsageData, exportPriceData);

      const extraSolarCostTotal = extraArrays.reduce((s: number, a: any) => s + (a.cost || 0), 0);
      const gross =
        costP.hpCost + costP.solarCost + costP.batteryCost + costP.installCost + costP.scaffolding + extraSolarCostTotal;
      const net = Math.max(0, gross - costP.busGrant);
      const finAmt = Math.max(0, net - (finP.deposit || 0));
      let mPay = 0;
      if (finP.useFinance && finAmt > 0 && finP.financeTerm > 0) {
        mPay = calcMP(finAmt, finP.financeRate || 0, finP.financeTerm);
      }
      const saving = res.annualSaving || res.currentTotal - res.newTotal;
      const totalSpent = finP.useFinance ? (finP.deposit || 0) + mPay * 12 * Math.min(finP.financeTerm, 20) : net;
      const totalSav = saving * 20;
      const profit = totalSav - totalSpent;
      const monthlyEnergy = res.newTotal / 12;
      const netMo = saving / 12 - mPay;
      const annRet =
        totalSpent > 0 && totalSav > totalSpent ? (Math.pow(totalSav / totalSpent, 1 / 20) - 1) * 100 : -100;
      const r20 = totalSpent > 0 ? (profit / totalSpent) * 100 : -100;

      if (optTarget === "annualReturn") return -annRet;
      if (optTarget === "roi20") return -r20;
      if (optTarget === "netMonthly") return -netMo;
      return monthlyEnergy + mPay;
    };

    const currentVec = active.map((p) => p.get());
    const currentCost = evaluate(currentVec);
    let globalBest = { vec: currentVec.slice(), cost: currentCost };
    let totalEvals = 0;

    for (let restart = 0; restart < numRestarts; restart++) {
      const pop: any[] = [];
      for (let i = 0; i < popSize; i++) {
        let vec;
        if (i === 0 && restart === 0) {
          vec = currentVec.slice();
        } else if (i === 0 && globalBest.cost < Infinity) {
          vec = globalBest.vec.map((v, d) => {
            const range = bounds[d].max - bounds[d].min;
            return Math.max(bounds[d].min, Math.min(bounds[d].max, v + (Math.random() - 0.5) * range * 0.3));
          });
        } else {
          vec = active.map((p, j) => bounds[j].min + Math.random() * (bounds[j].max - bounds[j].min));
        }
        const cost = evaluate(vec);
        pop.push({ vec, cost });
        totalEvals++;
      }

      let bestIdx = 0;
      pop.forEach((ind, i) => {
        if (ind.cost < pop[bestIdx].cost) bestIdx = i;
      });
      let stagnantGens = 0;
      let prevBest = pop[bestIdx].cost;

      for (let gen = 0; gen < gensPerRestart; gen++) {
        const F = 0.5 + Math.random() * 0.5;
        const CR = 0.3 + Math.random() * 0.6;

        for (let i = 0; i < popSize; i++) {
          const idxs: number[] = [];
          while (idxs.length < 3) {
            const r = Math.floor(Math.random() * popSize);
            if (r !== i && !idxs.includes(r)) idxs.push(r);
          }
          const useCurrentBest = Math.random() < 0.5;
          const baseVec = useCurrentBest ? pop[bestIdx].vec : pop[idxs[0]].vec;
          const diff1 = useCurrentBest ? pop[idxs[0]].vec : pop[idxs[1]].vec;
          const diff2 = useCurrentBest ? pop[idxs[1]].vec : pop[idxs[2]].vec;

          const mutant = baseVec.map((v: number, d: number) => v + F * (diff1[d] - diff2[d]));
          const jrand = Math.floor(Math.random() * dim);
          const trial = pop[i].vec.map((v: number, d: number) => {
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

        if (Math.abs(pop[bestIdx].cost - prevBest) < 0.001) stagnantGens++;
        else {
          stagnantGens = 0;
          prevBest = pop[bestIdx].cost;
        }

        if (stagnantGens > 8) {
          const sorted = pop.map((p, idx) => ({ idx, cost: p.cost })).sort((a, b) => b.cost - a.cost);
          const replaceCount = Math.ceil(popSize * 0.3);
          for (let k = 0; k < replaceCount; k++) {
            const ri = sorted[k].idx;
            if (ri === bestIdx) continue;
            const vec = active.map((p, j) => bounds[j].min + Math.random() * (bounds[j].max - bounds[j].min));
            pop[ri] = { vec, cost: evaluate(vec) };
            totalEvals++;
          }
          stagnantGens = 0;
        }

        const totalProgress = (restart * gensPerRestart + gen + 1) / (numRestarts * gensPerRestart);
        if (gen % 3 === 0) {
          setOptProgress(totalProgress);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
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
      setBestEverCost(globalBest.cost);
      setOptResult(`Improved! Score: ${globalBest.cost.toFixed(2)}`);
    } else {
      setOptResult(`No improvement found after ${totalEvals.toLocaleString()} evals.`);
    }

    setOptProgress(1);
    setOptimizing(false);
  }, [
    paramDefs,
    clamps,
    optTarget,
    optGenerations,
    bestEverCost,
    annualGas,
    annualElec,
    fixedElecRate,
    fixedGasRate,
    fixedElecStanding,
    fixedGasStanding,
    boilerEfficiency,
    solarKWp,
    batteryKWh,
    batteryPowerKW,
    batteryEfficiency,
    hpFlowTemp,
    exportRate,
    agileStanding,
    hotWaterKWhPerDay,
    solarTilt,
    solarAzimuth,
    extraSolarArrays,
    battStrategy,
    hpCost,
    solarCost,
    batteryCost,
    installCost,
    scaffolding,
    busGrant,
    deposit,
    financeRate,
    financeTerm,
    useFinance,
    priceData,
    solarDataProcessed,
    elecUsageData,
    gasUsageData,
    exportPriceData,
  ]);

  const results = useMemo(
    () =>
      simulate(
        {
          annualGas,
          annualElec,
          fixedElecRate,
          fixedGasRate,
          fixedElecStanding,
          fixedGasStanding,
          boilerEfficiency,
          solarKWp,
          batteryKWh,
          batteryPowerKW,
          batteryEfficiency,
          hpFlowTemp,
          exportRate,
          agileStanding,
          hotWaterKWhPerDay,
          solarTilt,
          solarAzimuth,
          extraSolarArrays,
          battStrategy,
        },
        priceData,
        solarDataProcessed,
        elecUsageData,
        gasUsageData,
        exportPriceData
      ),
    [
      annualGas,
      annualElec,
      fixedElecRate,
      fixedGasRate,
      fixedElecStanding,
      fixedGasStanding,
      boilerEfficiency,
      solarKWp,
      batteryKWh,
      batteryPowerKW,
      batteryEfficiency,
      hpFlowTemp,
      exportRate,
      agileStanding,
      hotWaterKWhPerDay,
      solarTilt,
      solarAzimuth,
      extraSolarArrays,
      battStrategy,
      priceData,
      solarDataProcessed,
      elecUsageData,
      gasUsageData,
      exportPriceData,
    ]
  );

  const extraSolarCostTotal = extraSolarArrays.reduce((s, a) => s + (a.cost || 0), 0);
  const grossCost = hpCost + solarCost + batteryCost + installCost + scaffolding + extraSolarCostTotal;
  const netCost = Math.max(0, grossCost - busGrant);
  const financedAmt = Math.max(0, netCost - deposit);
  const mp = calcMP(financedAmt, financeRate, financeTerm);
  const totalFinCost = mp * financeTerm * 12;
  const annualSaving = results.annualSaving;
  const annualFinanceCost = useFinance ? mp * 12 : 0;
  const netAnnualDuringFinance = annualSaving - annualFinanceCost;
  const netMonthly = useFinance ? annualSaving / 12 - mp : annualSaving / 12;
  const finYears = useFinance ? Math.min(financeTerm, 20) : 0;
  const totalSpent20Y = useFinance ? deposit + annualFinanceCost * finYears : netCost;
  const totalSavings20Y = annualSaving * 20;
  const profit20 = totalSavings20Y - totalSpent20Y;
  const roi20 = totalSpent20Y > 0 ? (profit20 / totalSpent20Y) * 100 : 0;

  const annualReturn =
    totalSpent20Y > 0 && totalSavings20Y > totalSpent20Y
      ? (Math.pow(totalSavings20Y / totalSpent20Y, 1 / 20) - 1) * 100
      : totalSpent20Y > 0 && totalSavings20Y > 0
      ? -((1 - Math.pow(totalSavings20Y / totalSpent20Y, 1 / 20)) * 100)
      : 0;

  let breakEvenYear = null;
  let cumCash = useFinance ? -deposit : -netCost;
  for (let y = 1; y <= 25; y++) {
    cumCash += y <= finYears ? netAnnualDuringFinance : annualSaving;
    if (cumCash >= 0 && breakEvenYear === null) breakEvenYear = y;
  }
  const simplePayback = useFinance
    ? netAnnualDuringFinance > 0
      ? deposit / netAnnualDuringFinance
      : Infinity
    : annualSaving > 0
    ? netCost / annualSaving
    : Infinity;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "investment", label: "Investment" },
    { id: "config", label: "Energy Params" },
    { id: "detail", label: "Graph" },
    { id: "yearly", label: "Costs" },
    { id: "agile", label: "Data Sync" },
  ];

  return (
    <div className="mesh-gradient text-slate-100 min-h-screen">
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-tr from-indigo-500 to-purple-500 rounded-2xl flex items-center justify-center shadow-lg">
              ⚡
            </div>
            <h1 className="text-2xl font-bold tracking-tight">VELOCITY</h1>
          </div>
          <div className="flex gap-4">
            {results.usingRealData && (
              <span className="glass-pill px-3 py-1 text-xs text-green-400 font-bold rounded-full flex items-center">
                AGILE LIVE
              </span>
            )}
            {results.usingRealSolar && (
              <span className="glass-pill px-3 py-1 text-xs text-yellow-400 font-bold rounded-full flex items-center">
                SOLAR LIVE
              </span>
            )}
            <button
              onClick={saveConfig}
              className="glass-pill px-4 py-1.5 text-[10px] text-accent font-bold rounded-full hover:bg-white/10 transition tracking-widest uppercase cursor-pointer"
            >
              Save Config
            </button>
            <label className="glass-pill px-4 py-1.5 text-[10px] text-blue-400 font-bold rounded-full hover:bg-white/10 transition tracking-widest uppercase cursor-pointer flex items-center">
              Load Config
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) loadConfig(e.target.files[0]);
                }}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="flex gap-4 px-6 py-4 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-5 py-2.5 rounded-full text-xs uppercase font-bold tracking-widest transition-all ${
              activeTab === t.id ? "bg-white text-slate-900" : "glass-pill text-slate-400 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {activeTab === "overview" && (
          <div className="flex flex-col gap-6">
            <div className="flex gap-6 overflow-x-auto">
              <Stat label="Current Spend" value={fmt(results.currentTotal)} sub="/yr" color={C.red} icon="🔥" />
              <Stat label="New Spend" value={fmt(results.newTotal)} sub="/yr" color={C.green} icon="🌿" />
              <Stat
                label="Net Monthly"
                value={fmtD(netMonthly)}
                sub={useFinance ? "after finance" : "saved/mo"}
                color={netMonthly > 0 ? C.accent : C.red}
                icon="💰"
              />
            </div>

            {(() => {
              const curMo = results.currentTotal / 12;
              const newEnergyMo = results.newTotal / 12;
              const finMo = useFinance ? mp : 0;
              const totalNewMo = newEnergyMo + finMo;
              const diff = curMo - totalNewMo;
              const isNoBrainer = useFinance && diff > 0;
              return (
                <div
                  className={`p-6 rounded-[24px] border ${
                    isNoBrainer ? "bg-green-500/10 border-green-500/20" : "glass-card"
                  }`}
                >
                  <div className="flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex-1 w-full">
                      <div className="text-xs text-slate-400 mb-1 font-bold">CURRENT MONTHLY</div>
                      <div className="text-2xl font-bold font-mono text-red-400">{fmtD(curMo)}</div>
                      <div className="text-[10px] text-slate-500 mt-1">gas + electricity</div>
                    </div>
                    <div className="hidden md:block text-2xl text-slate-600">→</div>
                    <div className="flex-1 w-full">
                      <div className="text-xs text-slate-400 mb-1 font-bold">NEW MONTHLY</div>
                      <div className={`text-2xl font-bold font-mono ${totalNewMo < curMo ? "text-green-400" : "text-red-400"}`}>
                        {fmtD(totalNewMo)}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1">
                        energy {fmtD(newEnergyMo)}
                        {useFinance ? ` + finance ${fmtD(finMo)}` : ""}
                      </div>
                    </div>
                    <div className="flex-1 w-full md:text-right">
                      <div className="text-xs text-slate-400 mb-1 font-bold">{diff > 0 ? "SAVING" : "EXTRA"}</div>
                      <div className={`text-2xl font-bold font-mono ${diff > 0 ? "text-green-400" : "text-red-400"}`}>
                        {fmtD(Math.abs(diff))}/mo
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1">{fmt(Math.abs(diff * 12))}/yr</div>
                    </div>
                  </div>
                  {isNoBrainer && (
                    <div className="mt-4 p-3 bg-green-500/10 rounded-xl text-xs text-green-400 font-bold text-center">
                      ✅ Costs less from day 1 — you save {fmtD(diff)}/mo even while paying the loan. No upfront cost needed.
                    </div>
                  )}
                  {useFinance && diff < 0 && (
                    <div className="mt-4 p-3 bg-red-500/10 rounded-xl text-xs text-slate-400 text-center">
                      ⚠️ Costs {fmtD(Math.abs(diff))}/mo more during the {financeTerm}y loan, then saves {fmtD(annualSaving / 12)}
                      /mo after.
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-6">Investment Returns</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-6 mb-8 overflow-x-auto">
                <Stat
                  label="Payback Time"
                  value={breakEvenYear ? `${breakEvenYear} yrs` : simplePayback < 100 ? `~${simplePayback.toFixed(1)}y` : "N/A"}
                  sub="break even point"
                  color={C.accent}
                />
                <Stat
                  label="Annual Return"
                  value={`${annualReturn.toFixed(1)}%`}
                  sub="CAGR over 20y"
                  color={annualReturn > 0 ? C.yellow : C.red}
                />
                <Stat
                  label="20Y Net Profit"
                  value={`${profit20 >= 0 ? "" : "-"}${fmt(Math.abs(profit20))}`}
                  sub={`spent ${fmt(totalSpent20Y)}`}
                  color={profit20 > 0 ? C.green : C.red}
                />
                <Stat label="20Y ROI" value={`${roi20.toFixed(0)}%`} sub={`saved ${fmt(totalSavings20Y)}`} color={C.blue} />
                <Stat label="Net Outlay" value={fmt(deposit)} sub={useFinance ? "upfront capital" : "initial cost"} color={C.orange} />
              </div>
              <CumulativeChart
                annualSaving={annualSaving}
                totalCost={netCost}
                financeMonthly={mp}
                financeTerm={financeTerm}
                useFinance={useFinance}
              />
            </div>

            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-6 text-accent">Optimizer</h3>
              <div className="flex flex-wrap gap-3 mb-6">
                <button
                  onClick={() => {
                    setOptTarget("netMonthly");
                    setBestEverCost(null);
                  }}
                  className={`px-4 py-2 ${
                    optTarget === "netMonthly" ? "bg-indigo-500 text-white" : "glass-pill"
                  } rounded-full text-xs font-bold`}
                >
                  Max Net Monthly
                </button>
                <button
                  onClick={() => {
                    setOptTarget("roi20");
                    setBestEverCost(null);
                  }}
                  className={`px-4 py-2 ${
                    optTarget === "roi20" ? "bg-indigo-500 text-white" : "glass-pill"
                  } rounded-full text-xs font-bold`}
                >
                  Max 20Y ROI
                </button>
                <button
                  onClick={() => {
                    setOptTarget("monthly");
                    setBestEverCost(null);
                  }}
                  className={`px-4 py-2 ${
                    optTarget === "monthly" ? "bg-indigo-500 text-white" : "glass-pill"
                  } rounded-full text-xs font-bold`}
                >
                  Min Energy Bill
                </button>
              </div>
              <button
                disabled={optimizing}
                onClick={runOptimizer}
                className="w-full glass-pill py-4 rounded-xl font-bold text-sm hover:bg-white/20 transition-all uppercase tracking-widest text-indigo-300"
              >
                {optimizing ? `Optimizing...` : `Run Optimizer Algorithm`}
              </button>
              {optResult && <div className="mt-4 text-xs font-mono text-green-400">{optResult}</div>}
            </div>
          </div>
        )}

        {activeTab === "investment" && (
          <div className="flex flex-col gap-6">
            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-8 text-blue-400">Capital Costs</h3>
              <Slider
                label="Heat Pump"
                unit=""
                prefix="£"
                value={hpCost}
                onChange={setHpCost}
                min={6000}
                max={18000}
                step={500}
                color={C.blue}
                clampMode={(clamps.hpCost || {}).mode}
                clampMin={(clamps.hpCost || {}).min}
                clampMax={(clamps.hpCost || {}).max}
                onClampChange={(lo: number, hi: number) =>
                  setClamps((p: any) => ({ ...p, hpCost: { ...(p.hpCost || { mode: "clamp" }), min: lo, max: hi } }))
                }
                onCycleClamp={() => cycleClamp("hpCost", hpCost, 6000, 18000)}
              />
              <Slider
                label={`Solar Capacity (${solarKWp}kWp)`}
                unit=""
                prefix="£"
                value={solarCost}
                onChange={handleSolarCostChange}
                min={0}
                max={15000}
                step={250}
                color={C.yellow}
                clampMode={(clamps.solarCost || {}).mode}
                clampMin={(clamps.solarCost || {}).min}
                clampMax={(clamps.solarCost || {}).max}
                onClampChange={(lo: number, hi: number) =>
                  setClamps((p: any) => ({ ...p, solarCost: { ...(p.solarCost || { mode: "clamp" }), min: lo, max: hi } }))
                }
                onCycleClamp={() => cycleClamp("solarCost", solarCost, 0, 15000)}
              />
              <Slider
                label={`Battery Size (${batteryKWh}kWh)`}
                unit=""
                prefix="£"
                value={batteryCost}
                onChange={handleBatteryCostChange}
                min={0}
                max={14000}
                step={250}
                color={C.accent}
                clampMode={(clamps.batteryCost || {}).mode}
                clampMin={(clamps.batteryCost || {}).min}
                clampMax={(clamps.batteryCost || {}).max}
                onClampChange={(lo: number, hi: number) =>
                  setClamps((p: any) => ({ ...p, batteryCost: { ...(p.batteryCost || { mode: "clamp" }), min: lo, max: hi } }))
                }
                onCycleClamp={() => cycleClamp("batteryCost", batteryCost, 0, 14000)}
              />
              <Slider
                label="Install Labour"
                unit=""
                prefix="£"
                value={installCost}
                onChange={setInstallCost}
                min={1000}
                max={8000}
                step={250}
                color={C.purple}
              />
              <Slider label="BUS Grant" unit="" prefix="£" value={busGrant} onChange={setBusGrant} min={0} max={7500} step={500} color={C.green} />
            </div>
            <div className="glass-card p-8 rounded-[32px]">
              <div className="flex justify-between mb-8">
                <h3 className="text-xl font-bold text-orange-400">Finance</h3>
                <button
                  onClick={() => setUseFinance(!useFinance)}
                  className={`px-4 py-1 text-xs font-bold rounded-full ${useFinance ? "bg-orange-500 text-white" : "glass-pill"}`}
                >
                  {useFinance ? "ACTIVE" : "INACTIVE"}
                </button>
              </div>
              {useFinance && (
                <>
                  <Slider
                    label="Deposit"
                    unit=""
                    prefix="£"
                    value={deposit}
                    onChange={setDeposit}
                    min={0}
                    max={netCost}
                    step={500}
                    color={C.green}
                    clampMode={(clamps.deposit || {}).mode}
                    clampMin={(clamps.deposit || {}).min}
                    clampMax={(clamps.deposit || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({ ...p, deposit: { ...(p.deposit || { mode: "clamp" }), min: lo, max: hi } }))
                    }
                    onCycleClamp={() => cycleClamp("deposit", deposit, 0, netCost)}
                  />
                  <Slider
                    label="APR"
                    unit="%"
                    value={financeRate}
                    onChange={setFinanceRate}
                    min={0}
                    max={15}
                    step={0.1}
                    color={C.orange}
                    clampMode={(clamps.financeRate || {}).mode}
                    clampMin={(clamps.financeRate || {}).min}
                    clampMax={(clamps.financeRate || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({ ...p, financeRate: { ...(p.financeRate || { mode: "clamp" }), min: lo, max: hi } }))
                    }
                    onCycleClamp={() => cycleClamp("financeRate", financeRate, 0, 15)}
                  />
                  <Slider
                    label="Term"
                    unit=" yrs"
                    value={financeTerm}
                    onChange={setFinanceTerm}
                    min={3}
                    max={25}
                    step={1}
                    color={C.orange}
                    clampMode={(clamps.financeTerm || {}).mode}
                    clampMin={(clamps.financeTerm || {}).min}
                    clampMax={(clamps.financeTerm || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({ ...p, financeTerm: { ...(p.financeTerm || { mode: "clamp" }), min: lo, max: hi } }))
                    }
                    onCycleClamp={() => cycleClamp("financeTerm", financeTerm, 3, 25)}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === "config" && (
          <div className="flex flex-col gap-6">
            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-8">Usage Configuration</h3>
              <Slider label="Annual Gas" unit=" kWh" value={annualGas} onChange={setAnnualGas} min={5000} max={25000} step={500} color={C.orange} />
              <Slider label="Annual Electricity" unit=" kWh" value={annualElec} onChange={setAnnualElec} min={1000} max={8000} step={100} color={C.orange} />
              <Slider label="Hot Water" unit=" kWh/day" value={hotWaterKWhPerDay} onChange={setHotWaterKWhPerDay} min={5} max={20} step={1} color={C.orange} />
              <Slider
                label="HP Flow Temp"
                unit="°C"
                value={hpFlowTemp}
                onChange={setHpFlowTemp}
                min={35}
                max={55}
                step={5}
                color={C.green}
                clampMode={(clamps.hpFlowTemp || {}).mode}
                clampMin={(clamps.hpFlowTemp || {}).min}
                clampMax={(clamps.hpFlowTemp || {}).max}
                onClampChange={(lo: number, hi: number) =>
                  setClamps((p: any) => ({ ...p, hpFlowTemp: { ...(p.hpFlowTemp || { mode: "clamp" }), min: lo, max: hi } }))
                }
                onCycleClamp={() => cycleClamp("hpFlowTemp", hpFlowTemp, 35, 55)}
              />
            </div>

            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-8">Asset Sizing</h3>

              <div className="mb-8 p-6 bg-yellow-500/5 rounded-2xl border border-yellow-500/10">
                <h4 className="text-sm font-bold text-yellow-400 mb-4 uppercase tracking-wider">Solar Array 1 (Main)</h4>
                <Slider
                  label="Size"
                  unit=" kWp"
                  value={solarKWp}
                  onChange={setSolarKWp}
                  min={0}
                  max={12}
                  step={0.5}
                  color={C.yellow}
                  clampMode={(clamps.solarKWp || {}).mode}
                  clampMin={(clamps.solarKWp || {}).min}
                  clampMax={(clamps.solarKWp || {}).max}
                  onClampChange={(lo: number, hi: number) =>
                    setClamps((p: any) => ({ ...p, solarKWp: { ...(p.solarKWp || { mode: "clamp" }), min: lo, max: hi } }))
                  }
                  onCycleClamp={() => cycleClamp("solarKWp", solarKWp, 0, 12)}
                />
                <Slider label="Tilt" unit="°" value={solarTilt} onChange={setSolarTilt} min={0} max={90} step={5} color={C.yellow} />
                <Slider label="Azimuth" unit="°" value={solarAzimuth} onChange={setSolarAzimuth} min={0} max={355} step={5} color={C.yellow} />
              </div>

              {extraSolarArrays.map((arr, idx) => (
                <div key={idx} className="mb-8 p-6 bg-yellow-500/5 rounded-2xl border border-yellow-500/10">
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="text-sm font-bold text-yellow-400 uppercase tracking-wider">Solar Array {idx + 2}</h4>
                    <button
                      onClick={() => setExtraSolarArrays((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-[10px] text-red-400 font-bold glass-pill px-3 py-1 hover:bg-red-500/10 transition"
                    >
                      REMOVE
                    </button>
                  </div>
                  <Slider
                    label="Size"
                    unit=" kWp"
                    value={arr.kWp}
                    onChange={(v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, kWp: v } : a)))}
                    min={0}
                    max={12}
                    step={0.5}
                    color={C.yellow}
                    clampMode={(clamps[`extraSolarKWp_${idx}`] || {}).mode}
                    clampMin={(clamps[`extraSolarKWp_${idx}`] || {}).min}
                    clampMax={(clamps[`extraSolarKWp_${idx}`] || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({
                        ...p,
                        [`extraSolarKWp_${idx}`]: { ...(p[`extraSolarKWp_${idx}`] || { mode: "clamp" }), min: lo, max: hi },
                      }))
                    }
                    onCycleClamp={() => cycleClamp(`extraSolarKWp_${idx}`, arr.kWp, 0, 12)}
                  />
                  <Slider
                    label="Tilt"
                    unit="°"
                    value={arr.tilt}
                    onChange={(v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, tilt: v } : a)))}
                    min={0}
                    max={90}
                    step={5}
                    color={C.yellow}
                    clampMode={(clamps[`extraSolarTilt_${idx}`] || {}).mode}
                    clampMin={(clamps[`extraSolarTilt_${idx}`] || {}).min}
                    clampMax={(clamps[`extraSolarTilt_${idx}`] || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({
                        ...p,
                        [`extraSolarTilt_${idx}`]: { ...(p[`extraSolarTilt_${idx}`] || { mode: "clamp" }), min: lo, max: hi },
                      }))
                    }
                    onCycleClamp={() => cycleClamp(`extraSolarTilt_${idx}`, arr.tilt, 0, 90)}
                  />
                  <Slider
                    label="Azimuth"
                    unit="°"
                    value={arr.azimuth}
                    onChange={(v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, azimuth: v } : a)))}
                    min={0}
                    max={355}
                    step={5}
                    color={C.yellow}
                    clampMode={(clamps[`extraSolarAzimuth_${idx}`] || {}).mode}
                    clampMin={(clamps[`extraSolarAzimuth_${idx}`] || {}).min}
                    clampMax={(clamps[`extraSolarAzimuth_${idx}`] || {}).max}
                    onClampChange={(lo: number, hi: number) =>
                      setClamps((p: any) => ({
                        ...p,
                        [`extraSolarAzimuth_${idx}`]: { ...(p[`extraSolarAzimuth_${idx}`] || { mode: "clamp" }), min: lo, max: hi },
                      }))
                    }
                    onCycleClamp={() => cycleClamp(`extraSolarAzimuth_${idx}`, arr.azimuth, 0, 355)}
                  />
                  <Slider
                    label="Cost"
                    unit=""
                    prefix="£"
                    value={arr.cost || 0}
                    onChange={(v: number) => setExtraSolarArrays((prev) => prev.map((a, i) => (i === idx ? { ...a, cost: v } : a)))}
                    min={0}
                    max={15000}
                    step={250}
                    color={C.yellow}
                  />
                </div>
              ))}

              <button
                onClick={() => setExtraSolarArrays((prev) => [...prev, { kWp: 2, tilt: 35, azimuth: 180, cost: 3000 }])}
                className="w-full mb-8 glass-pill py-3 rounded-xl font-bold text-[10px] hover:bg-white/5 transition tracking-widest uppercase text-yellow-400 border border-yellow-400/20"
              >
                + Add Another Solar Array
              </button>

              <div className="mb-8 pt-8 border-t border-white/5">
                <Slider
                  label="Battery Capacity"
                  unit=" kWh"
                  value={batteryKWh}
                  onChange={setBatteryKWh}
                  min={0}
                  max={25}
                  step={0.5}
                  color={C.accent}
                  clampMode={(clamps.batteryKWh || {}).mode}
                  clampMin={(clamps.batteryKWh || {}).min}
                  clampMax={(clamps.batteryKWh || {}).max}
                  onClampChange={(lo: number, hi: number) =>
                    setClamps((p: any) => ({ ...p, batteryKWh: { ...(p.batteryKWh || { mode: "clamp" }), min: lo, max: hi } }))
                  }
                  onCycleClamp={() => cycleClamp("batteryKWh", batteryKWh, 0, 25)}
                />
                <Slider
                  label="Battery Power"
                  unit=" kW"
                  value={batteryPowerKW}
                  onChange={setBatteryPowerKW}
                  min={1}
                  max={12}
                  step={0.5}
                  color={C.accent}
                  clampMode={(clamps.batteryPowerKW || {}).mode}
                  clampMin={(clamps.batteryPowerKW || {}).min}
                  clampMax={(clamps.batteryPowerKW || {}).max}
                  onClampChange={(lo: number, hi: number) =>
                    setClamps((p: any) => ({ ...p, batteryPowerKW: { ...(p.batteryPowerKW || { mode: "clamp" }), min: lo, max: hi } }))
                  }
                  onCycleClamp={() => cycleClamp("batteryPowerKW", batteryPowerKW, 1, 12)}
                />
              </div>

              <div className="mt-8">
                <h4 className="text-sm font-bold text-accent mb-4">Battery Strategy</h4>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: "peak", label: "Peak Shave", desc: "Charge overnight, discharge only 4-7pm peak" },
                    { id: "smart", label: "Smart", desc: "Use battery when it saves vs grid import" },
                    { id: "maxExport", label: "Max Export", desc: "Aggressively charge cheap, export at peak" },
                    { id: "solarFirst", label: "Solar First", desc: "Minimize grid use, battery powers home first" },
                  ].map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setBattStrategy(s.id)}
                      className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${
                        battStrategy === s.id ? "bg-accent text-slate-900" : "glass-pill text-slate-400 hover:text-white"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-slate-400 mt-4 leading-relaxed">
                  {battStrategy === "peak"
                    ? "Charge overnight at cheapest rates. Only discharge during 4-7pm peak. Conservative."
                    : battStrategy === "smart"
                    ? "Discharge to home when price > charge cost + losses. Export at peak. Best all-rounder."
                    : battStrategy === "maxExport"
                    ? "Charge aggressively at cheap rates. Discharge home at mid-price. Export maximum at peak."
                    : "Prioritize solar storage and self-use. Minimal grid charging. Battery powers home before grid."}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "yearly" && (
          <div className="flex flex-col gap-6">
            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-6">Yearly Cost Breakdown</h3>
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="pb-2">Month</th>
                    <th className="pb-2 text-right">Current</th>
                    <th className="pb-2 text-right">Energy</th>
                    {useFinance && showFinInTabs && <th className="pb-2 text-right border-l border-slate-700 w-24">+Finance</th>}
                    <th className="pb-2 text-right">Saving</th>
                  </tr>
                </thead>
                <tbody>
                  {results.months.map((m, i) => {
                    const finMo = showFinInTabs && useFinance ? mp : 0;
                    const total = m.newTotal + finMo;
                    return (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-slate-400 font-bold">{m.month}</td>
                        <td className="py-2 text-right font-mono text-red-300">{fmtD(m.currentTotal)}</td>
                        <td className="py-2 text-right font-mono text-green-400">{fmtD(m.newTotal)}</td>
                        {useFinance && showFinInTabs && (
                          <td className="py-2 text-right font-mono text-orange-400 border-l border-slate-700">{fmtD(total)}</td>
                        )}
                        <td className="py-2 text-right font-mono font-bold text-accent">{fmtD(m.currentTotal - total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-6">25-Year Projection</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left min-w-[500px]">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="pb-2 sticky left-0 bg-[#0f172a] z-10 w-16">Year</th>
                      <th className="pb-2 text-right text-green-400">Saving</th>
                      {useFinance && <th className="pb-2 text-right text-orange-400">Finance</th>}
                      <th className="pb-2 text-right text-accent">Net</th>
                      <th className="pb-2 text-right text-blue-400">Cumulative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let cum = useFinance ? -deposit : -netCost;
                      const rows = [];
                      let hitBE = false;
                      const finYearsToIterate = useFinance ? Math.min(financeTerm, 25) : 0;
                      for (let y = 1; y <= 25; y++) {
                        const finY = useFinance && y <= financeTerm ? mp * 12 : 0;
                        const netY = annualSaving - finY;
                        cum += netY;
                        const isBE = !hitBE && cum >= 0;
                        if (isBE) hitBE = true;
                        rows.push(
                          <tr key={y} className="border-b border-white/5">
                            <td
                              className={`py-2 sticky left-0 z-10 font-bold ${
                                isBE ? "text-green-400 bg-green-400/10" : "text-slate-400 bg-[#0f172a]"
                              }`}
                            >
                              {y}
                              {isBE ? " ✓" : ""}
                            </td>
                            <td className="py-2 text-right font-mono text-green-400">{fmtD(annualSaving)}</td>
                            {useFinance && (
                              <td className="py-2 text-right font-mono text-orange-400">
                                {finY > 0 ? `-` + fmtD(finY) : "—"}
                              </td>
                            )}
                            <td className={`py-2 text-right font-mono font-bold ${netY > 0 ? "text-green-400" : "text-red-400"}`}>
                              {netY > 0 ? "" : "-"}
                              {fmtD(Math.abs(netY))}
                            </td>
                            <td className={`py-2 text-right font-mono font-bold ${cum > 0 ? "text-blue-400" : "text-red-400"}`}>
                              {cum > 0 ? "" : "-"}
                              {fmtD(Math.abs(cum))}
                            </td>
                          </tr>
                        );
                      }
                      return rows;
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "detail" &&
          (() => {
            const toggle = (key: string) => setChartHidden((p: any) => ({ ...p, [key]: !p[key] }));
            const hid = chartHidden;
            const fullLog = results.dailyLog;
            if (!fullLog || fullLog.length === 0)
              return (
                <div style={{ padding: 20, textAlign: "center", color: C.dim }}>
                  No simulation data
                </div>
              );

            const log = fullLog.filter((r: any) => r.m === detailMonth);
            const dayOffset = log.length > 0 ? log[0].day : 0;

            const ttFmt = (v: any, p: any) => {
              const r = p && p[0] && p[0].payload;
              if (!r) return "";
              const dayInMonth = r.day - dayOffset + 1;
              return `${MONTHS[detailMonth]} day ${dayInMonth}, ${String(Math.floor(r.slot / 2)).padStart(2, "0")}:${
                r.slot % 2 === 0 ? "00" : "30"
              } — ${r.price.toFixed(1)}p`;
            };
            const xFmt = (v: any, i: number) => {
              const r = chartData[i];
              return r && r.slot === 0 ? `${r.day - dayOffset + 1}` : "";
            };
            const ttS = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 10 };

            const vs = Math.max(0, Math.min(viewStart, log.length));
            const ve = Math.min(viewEnd, log.length);
            const chartData = log.slice(vs, ve);
            const onRangeChange = (s: number, e: number) => {
              setViewStart(s);
              setViewEnd(Math.min(e, log.length));
            };

            const Leg = ({ items }: any) => (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginBottom: 6 }}>
                {items.map(({ color, label, k }: any) => (
                  <span
                    key={k}
                    onClick={() => toggle(k)}
                    style={{
                      cursor: "pointer",
                      fontSize: 9,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: hid[k] ? "transparent" : "rgba(255,255,255,0.04)",
                      opacity: hid[k] ? 0.3 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      border: `1px solid ${hid[k] ? "transparent" : "rgba(255,255,255,0.06)"}`,
                    }}
                  >
                    <span style={{ width: 10, height: 3, borderRadius: 1, background: color, display: "inline-block" }} />
                    {label}
                  </span>
                ))}
              </div>
            );

            return (
              <div style={{ padding: "0 4px" }}>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 10 }}>
                  {MONTHS.map((mn, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setDetailMonth(i);
                        setViewStart(0);
                        setViewEnd(144);
                      }}
                      style={{
                        background: detailMonth === i ? C.accent : C.card,
                        color: detailMonth === i ? C.bg : C.muted,
                        border: `1px solid ${detailMonth === i ? C.accent : C.border}`,
                        borderRadius: 6,
                        padding: "4px 7px",
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: "pointer",
                      } as React.CSSProperties}
                    >
                      {mn}
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: "10px 13px",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: C.dim }}>Day range (drag handles or slide window)</span>
                    <span style={{ fontSize: 10, color: C.accent, fontFamily: mono }}>
                      Day {Math.floor(viewStart / 48) + 1}–{Math.ceil(viewEnd / 48)} of {Math.ceil(log.length / 48)}
                    </span>
                  </div>
                  <RangeBrush total={log.length} start={viewStart} end={viewEnd} onChange={onRangeChange} color={C.accent} />
                </div>

                <div
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: 13,
                    marginBottom: 10,
                  }}
                >
                  <h3 style={{ fontSize: 12, fontWeight: 600, margin: "0 0 4px" }}>Battery & Price</h3>
                  <Leg
                    items={[
                      { color: C.accent, label: "SOC (kWh)", k: "soc" },
                      { color: C.orange, label: "Import (p)", k: "pr" },
                      { color: C.green, label: "Export (p)", k: "ep" },
                    ]}
                  />
                  <TouchChart height={180}>
                    <ResponsiveContainer>
                      <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="slot" tick={{ fontSize: 8, fill: C.muted }} tickFormatter={xFmt} />
                        <YAxis yAxisId="soc" tick={{ fontSize: 8, fill: C.muted }} unit="kWh" />
                        <YAxis yAxisId="pr" orientation="right" tick={{ fontSize: 8, fill: C.muted }} unit="p" />
                        <Tooltip contentStyle={ttS} labelFormatter={ttFmt} />
                        {!hid.soc && (
                          <Bar yAxisId="soc" dataKey="battSOC" fill={C.accent} opacity={0.6} name="SOC" isAnimationActive={false} />
                        )}
                        {!hid.pr && (
                          <Line
                            yAxisId="pr"
                            type="stepAfter"
                            dataKey="price"
                            stroke={C.orange}
                            dot={false}
                            strokeWidth={1.5}
                            name="Import"
                            isAnimationActive={false}
                          />
                        )}
                        {!hid.ep && (
                          <Line
                            yAxisId="pr"
                            type="stepAfter"
                            dataKey="expPrice"
                            stroke={C.green}
                            dot={false}
                            strokeWidth={1}
                            opacity={0.7}
                            name="Export"
                            isAnimationActive={false}
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </TouchChart>
                </div>

                <div
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: 13,
                    marginBottom: 10,
                  }}
                >
                  <h3 style={{ fontSize: 12, fontWeight: 600, margin: "0 0 4px" }}>Home Energy</h3>
                  <Leg
                    items={[
                      { color: C.yellow, label: "Solar→Home", k: "sd" },
                      { color: "#60a5fa", label: "Batt→Home", k: "bh" },
                      { color: C.red, label: "Grid→Home", k: "gh" },
                    ]}
                  />
                  <TouchChart height={170}>
                    <ResponsiveContainer>
                      <BarChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="slot" tick={{ fontSize: 8, fill: C.muted }} tickFormatter={xFmt} />
                        <YAxis tick={{ fontSize: 8, fill: C.muted }} unit="kWh" />
                        <Tooltip contentStyle={ttS} labelFormatter={ttFmt} />
                        {!hid.sd && (
                          <Bar
                            dataKey="solarDirect"
                            stackId="home"
                            fill={C.yellow}
                            opacity={0.85}
                            name="Solar→Home"
                            isAnimationActive={false}
                          />
                        )}
                        {!hid.bh && (
                          <Bar
                            dataKey="battHome"
                            stackId="home"
                            fill="#60a5fa"
                            opacity={0.85}
                            name="Batt→Home"
                            isAnimationActive={false}
                          />
                        )}
                        {!hid.gh && (
                          <Bar
                            dataKey="gridHome"
                            stackId="home"
                            fill={C.red}
                            opacity={0.6}
                            name="Grid→Home"
                            isAnimationActive={false}
                          />
                        )}
                      </BarChart>
                    </ResponsiveContainer>
                  </TouchChart>
                </div>
              </div>
            );
          })()}

        {activeTab === "agile" && (
          <div className="flex flex-col gap-6">
            <div className="glass-card p-8 rounded-[32px]">
              <h3 className="text-xl font-bold mb-4">Data Sync</h3>
              <p className="text-sm text-slate-400 mb-6">Upload or paste data to run your simulation with accurate profiles.</p>

              <div className="mb-6 p-6 bg-orange-500/5 rounded-2xl border border-orange-500/10">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="text-sm font-bold text-orange-400 uppercase tracking-wider">⚡ Agile Import Prices</h4>
                  {priceData && (
                    <span className="glass-pill px-3 py-1 text-[10px] text-green-400 font-bold">
                      {Object.keys(priceData.dayData).length}d loaded
                    </span>
                  )}
                </div>
                <div className="flex gap-4 mb-4">
                  <label className="flex-1 glass-pill py-3 text-center cursor-pointer hover:bg-white/5 transition font-bold text-[10px] uppercase tracking-widest">
                    {priceData ? "Replace File" : "Upload CSV/JSON"}
                    <input
                      type="file"
                      accept=".csv,.json,.txt"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files[0]) handleAgileCSV(e.target.files[0]);
                      }}
                    />
                  </label>
                  <button
                    onClick={() => {
                      setPasteMode(pasteMode === "agile" ? null : "agile");
                      setPasteText("");
                    }}
                    className={`flex-1 glass-pill py-3 transition font-bold text-[10px] uppercase tracking-widest ${
                      pasteMode === "agile" ? "bg-orange-500 text-white" : "hover:bg-white/5 text-orange-400"
                    }`}
                  >
                    {pasteMode === "agile" ? "Cancel" : "Paste JSON"}
                  </button>
                </div>
                {pasteMode === "agile" && (
                  <div className="mb-4">
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste Octopus API JSON..."
                      className="w-full h-32 bg-white/5 border border-white/10 rounded-xl p-3 text-xs font-mono mb-2 outline-none focus:border-orange-500/50"
                    />
                    <button onClick={handlePasteLoad} className="w-full bg-orange-500 py-3 rounded-xl font-bold text-xs uppercase tracking-widest">
                      Load Pasted Data
                    </button>
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-tight">Direct API Links:</div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {agileMonthUrls.map((m, i) => (
                    <a
                      key={i}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                      className="glass-pill px-3 py-1 text-[9px] font-bold text-orange-300 hover:bg-white/10 transition"
                    >
                      {m.label}
                    </a>
                  ))}
                </div>
                {loadError && <div className="text-[10px] text-green-400 mt-2 font-mono">{loadError}</div>}
              </div>

              <div className="mb-6 p-6 bg-purple-500/5 rounded-2xl border border-purple-500/10">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="text-sm font-bold text-purple-400 uppercase tracking-wider">📤 Agile Outgoing (Export)</h4>
                  {exportPriceData && (
                    <span className="glass-pill px-3 py-1 text-[10px] text-green-400 font-bold">
                      {Object.keys(exportPriceData.dayData).length}d loaded
                    </span>
                  )}
                </div>
                <div className="flex gap-4 mb-4">
                  <label className="flex-1 glass-pill py-3 text-center cursor-pointer hover:bg-white/5 transition font-bold text-[10px] uppercase tracking-widest">
                    {exportPriceData ? "Replace File" : "Upload CSV/JSON"}
                    <input
                      type="file"
                      accept=".csv,.json,.txt"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files[0]) handleAgileCSV(e.target.files[0], true);
                      }}
                    />
                  </label>
                  <button
                    onClick={() => {
                      setPasteMode(pasteMode === "export" ? null : "export");
                      setPasteText("");
                    }}
                    className={`flex-1 glass-pill py-3 transition font-bold text-[10px] uppercase tracking-widest ${
                      pasteMode === "export" ? "bg-purple-500 text-white" : "hover:bg-white/5 text-purple-400"
                    }`}
                  >
                    {pasteMode === "export" ? "Cancel" : "Paste JSON"}
                  </button>
                </div>
                {pasteMode === "export" && (
                  <div className="mb-4">
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste Octopus Agile Outgoing JSON..."
                      className="w-full h-32 bg-white/5 border border-white/10 rounded-xl p-3 text-xs font-mono mb-2 outline-none focus:border-purple-500/50"
                    />
                    <button onClick={handlePasteLoad} className="w-full bg-purple-500 py-3 rounded-xl font-bold text-xs uppercase tracking-widest">
                      Load Pasted Data
                    </button>
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-tight">Direct API Links:</div>
                <div className="flex flex-wrap gap-2">
                  {exportMonthUrls.map((m, i) => (
                    <a
                      key={i}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                      className="glass-pill px-3 py-1 text-[9px] font-bold text-purple-300 hover:bg-white/10 transition"
                    >
                      {m.label}
                    </a>
                  ))}
                </div>
                {exportLoadError && <div className="text-[10px] text-green-400 mt-2 font-mono">{exportLoadError}</div>}
              </div>

              <div className="mb-6 p-6 bg-yellow-500/5 rounded-2xl border border-yellow-500/10">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="text-sm font-bold text-yellow-400 uppercase tracking-wider">☀️ Solar Irradiance</h4>
                  {solarDataProcessed && (
                    <span className="glass-pill px-3 py-1 text-[10px] text-green-400 font-bold">
                      {Object.keys(solarRaw).length}d loaded
                    </span>
                  )}
                </div>
                <div className="flex gap-4 mb-4">
                  <label className="flex-1 glass-pill py-3 text-center cursor-pointer hover:bg-white/5 transition font-bold text-[10px] uppercase tracking-widest">
                    {solarDataProcessed ? "Replace File" : "Upload CSV/JSON"}
                    <input
                      type="file"
                      accept=".csv,.json,.txt"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files[0]) handleSolarCSV(e.target.files[0]);
                      }}
                    />
                  </label>
                  <button
                    onClick={() => {
                      setPasteMode(pasteMode === "solar" ? null : "solar");
                      setPasteText("");
                    }}
                    className={`flex-1 glass-pill py-3 transition font-bold text-[10px] uppercase tracking-widest ${
                      pasteMode === "solar" ? "bg-yellow-500 text-white" : "hover:bg-white/5 text-yellow-400"
                    }`}
                  >
                    {pasteMode === "solar" ? "Cancel" : "Paste JSON"}
                  </button>
                </div>
                {pasteMode === "solar" && (
                  <div className="mb-4">
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste Open-Meteo JSON..."
                      className="w-full h-32 bg-white/5 border border-white/10 rounded-xl p-3 text-xs font-mono mb-2 outline-none focus:border-yellow-500/50"
                    />
                    <button onClick={handlePasteLoad} className="w-full bg-yellow-500 py-3 rounded-xl font-bold text-xs uppercase tracking-widest">
                      Load Pasted Data
                    </button>
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-tight">API Link:</div>
                <a
                  href={solarApiUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block glass-pill px-4 py-2 text-[9px] font-bold text-yellow-300 hover:bg-white/10 transition uppercase tracking-widest"
                >
                  Open Open-Meteo API
                </a>
              </div>

              <div className="flex flex-col gap-4 mb-6">
                <label className="glass-pill p-6 rounded-2xl cursor-pointer text-center hover:bg-white/10 transition">
                  <div className="text-lg font-bold text-blue-400 mb-2">
                    {elecUsageData ? "✓ Electric Usage Loaded" : "Upload Electricity Usage CSV"}
                  </div>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0], "electricity");
                    }}
                  />
                  {uploadStatus.elec && <div className="text-[10px] text-blue-300 mt-2">{uploadStatus.elec}</div>}
                  <div className="text-[10px] text-slate-500 mt-2">Download from your supplier or n3rgy</div>
                </label>
                <label className="glass-pill p-6 rounded-2xl cursor-pointer text-center hover:bg-white/10 transition">
                  <div className="text-lg font-bold text-green-400 mb-2">
                    {gasUsageData ? "✓ Gas Usage Loaded" : "Upload Gas Usage CSV"}
                  </div>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0], "gas");
                    }}
                  />
                  {uploadStatus.gas && <div className="text-[10px] text-green-300 mt-2">{uploadStatus.gas}</div>}
                  <div className="text-[10px] text-slate-500 mt-2">Download from your supplier or n3rgy</div>
                </label>
              </div>

              <div className="text-xs text-slate-500">
                Data missing? The app automatically interpolates gaps scaling perfectly to your annual totals.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
