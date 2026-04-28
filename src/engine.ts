import {
  SOLAR_KWH_PER_KWP_BASE,
  UK_MONTHLY_TEMPS,
  heatingDegrees,
  DAYS_IN_MONTH,
} from "./utils";

export const heatPumpCOP = (t: number) => Math.max(1.8, Math.min(5.0, 2.8 + 0.09 * t));

export const tiltCorrection = (tilt: number, month: number) => {
  const dev = tilt - 35;
  const elev = [18, 24, 33, 44, 52, 56, 54, 47, 37, 28, 20, 16][month];
  const bias = (tilt - 35) * (35 - elev) * 0.0004;
  return Math.max(0.45, Math.min(1.05, 1 - 0.00015 * dev * dev + bias));
};

export const azimuthCorrectionFactor = (az: number) => {
  const dev = Math.min(Math.abs(az - 180), 360 - Math.abs(az - 180));
  return Math.max(0.5, 0.55 + 0.45 * Math.cos((dev * Math.PI) / 180));
};

export const azimuthTimeShift = (az: number) => {
  const d = (az - 180 + 360) % 360;
  return (d > 180 ? d - 360 : d) / 180 * 3;
};

export const correctedSolarKWh = (tilt: number, az: number) => {
  const af = azimuthCorrectionFactor(az);
  return SOLAR_KWH_PER_KWP_BASE.map((b, m) => b * tiltCorrection(tilt, m) * af);
};

export const generateSolarProfile = (month: number, az = 180) => {
  const p = [];
  const sr = [8.2, 7.5, 6.5, 5.8, 5.0, 4.5, 4.8, 5.5, 6.3, 7.0, 7.5, 8.3][month];
  const ss = [16.2, 17.0, 18.0, 19.5, 20.5, 21.2, 21.0, 20.2, 19.0, 17.5, 16.5, 15.8][month];
  const pk = (sr + ss) / 2 + azimuthTimeShift(az);
  const dl = ss - sr;
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    if (h < sr || h > ss) p.push(0);
    else {
      const x = (h - pk) / (dl / 4);
      p.push(Math.exp(-x * x));
    }
  }
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.map((v) => v / s) : p;
};

export const generateDemandProfile = () => {
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let f;
    if (h < 5) f = 0.008;
    else if (h < 7) f = 0.015;
    else if (h < 9) f = 0.035;
    else if (h < 12) f = 0.02;
    else if (h < 14) f = 0.025;
    else if (h < 16) f = 0.02;
    else if (h < 19) f = 0.04;
    else if (h < 22) f = 0.03;
    else f = 0.012;
    p.push(f);
  }
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / s);
};

export const generateHeatingProfile = () => {
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let f;
    if (h < 5) f = 0.01;
    else if (h < 7) f = 0.04;
    else if (h < 9) f = 0.05;
    else if (h < 16) f = 0.015;
    else if (h < 21) f = 0.04;
    else if (h < 23) f = 0.02;
    else f = 0.008;
    p.push(f);
  }
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / s);
};

export const generateSyntheticAgile = (month: number) => {
  const isSummer = month >= 3 && month <= 8;
  const isWinter = month <= 1 || month >= 10;
  const p = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let pr;
    if (h < 4) pr = isSummer ? 8 : 12;
    else if (h < 5) pr = isSummer ? 6 : 10;
    else if (h < 7) pr = isSummer ? 12 : 18;
    else if (h < 9) pr = isSummer ? 22 : 32;
    else if (h < 12) pr = isSummer ? 15 : 24;
    else if (h < 14) pr = isSummer ? 10 : 20;
    else if (h < 16) pr = isSummer ? 8 : 22;
    else if (h < 19) pr = isSummer ? 28 : 42;
    else if (h < 21) pr = isSummer ? 18 : 28;
    else if (h < 23) pr = isSummer ? 14 : 20;
    else pr = isSummer ? 10 : 15;
    const mf = isWinter ? 1.1 : isSummer ? 0.9 : 1.0;
    if (isSummer && h >= 11 && h <= 15 && month >= 4 && month <= 7) pr = Math.max(-5, pr - 12);
    p.push(pr * mf);
  }
  return p;
};

export const DEMAND_PROFILE = generateDemandProfile();
export const HEATING_PROFILE = generateHeatingProfile();

export function dailySolarOutput(dayData: any, kWp: number, tilt: number, azimuth: number, month: number) {
  const { ghi, temp } = dayData;
  const perfRatio = 0.83;
  const tiltFact = tiltCorrection(tilt, month);
  const azFact = azimuthCorrectionFactor(azimuth);
  const horizontalToTilt35 = 1.13;
  const tiltVsHorizontal = tiltFact * horizontalToTilt35;
  const transposition = tiltVsHorizontal * azFact;
  const tempCoeff = -0.004;

  const halfHourly = new Array(48).fill(0);
  for (let h = 0; h < 24 && h < ghi.length; h++) {
    const irr = Math.max(0, ghi[h]);
    const cellTemp = (temp[h] || 15) + irr * 0.03;
    const tempDerate = 1 + tempCoeff * Math.max(0, cellTemp - 25);
    const hourOutput = (irr / 1000) * kWp * transposition * perfRatio * Math.max(0.7, tempDerate);
    halfHourly[h * 2] = hourOutput / 2;
    halfHourly[h * 2 + 1] = hourOutput / 2;
  }
  return halfHourly;
}

export function monthlySolarStats(solarDays: any, arrays: any[]) {
  const stats = Array.from({ length: 12 }, () => ({
    days: 0,
    totalKWh: 0,
    peakDay: 0,
    worstDay: Infinity,
    avgDailyKWh: 0,
    totalGHI: 0,
    dailyOutputs: [] as number[][],
    dailyTemps: [] as number[][],
  }));

  for (const [date, dayData] of Object.entries(solarDays)) {
    const m = parseInt(date.split("-")[1]) - 1;
    const dData = dayData as any;
    const dayOutput = new Array(48).fill(0);
    for (const arr of arrays) {
      if (arr.kWp <= 0) continue;
      const arrOutput = dailySolarOutput(dayData, arr.kWp, arr.tilt, arr.azimuth, m);
      for (let i = 0; i < 48; i++) dayOutput[i] += arrOutput[i];
    }
    const dayTotal = dayOutput.reduce((a, b) => a + b, 0);
    const dayGHI = (dayData as any).ghi.reduce((a: number, b: number) => a + (b || 0), 0) / 1000;

    stats[m].days++;
    stats[m].totalKWh += dayTotal;
    stats[m].totalGHI += dayGHI;
    stats[m].peakDay = Math.max(stats[m].peakDay, dayTotal);
    stats[m].worstDay = Math.min(stats[m].worstDay, dayTotal);
    stats[m].dailyOutputs.push(dayOutput);
    stats[m].dailyTemps.push(dData.temp || new Array(24).fill(UK_MONTHLY_TEMPS[m]));
  }

  for (const s of stats) {
    if (s.days > 0) {
      s.avgDailyKWh = s.totalKWh / s.days;
      if (s.worstDay === Infinity) s.worstDay = 0;
    }
  }
  return stats;
}

export async function fetchSolarData(lat: number, lon: number, onProgress?: (p: number) => void) {
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
  } catch (fetchErr: any) {
    throw new Error(`Fetch failed: ${fetchErr.message || "Network/CORS error"}. Upload a CSV instead.`);
  }
  if (!resp.ok) throw new Error(`API returned ${resp.status} ${resp.statusText}`);
  onProgress && onProgress(0.6);

  const data = await resp.json();
  onProgress && onProgress(0.9);

  if (!data.hourly || !data.hourly.shortwave_radiation) {
    throw new Error("No solar radiation data returned");
  }

  const days: any = {};
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

  const completeDays: any = {};
  for (const [date, d] of Object.entries(days)) {
    const entry = d as any;
    if (entry.ghi.length >= 23) {
      while (entry.ghi.length < 24) {
        entry.ghi.push(0);
        entry.temp.push(entry.temp[entry.temp.length - 1] || 10);
        entry.cloud.push(50);
      }
      completeDays[date] = entry;
    }
  }

  onProgress && onProgress(1.0);
  return completeDays;
}

export async function fetchAgileData(region: string, product: string, onProgress?: (p: number) => void) {
  const tariffCode = `E-1R-${product}-${region}`;
  const baseUrl = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;

  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  const testUrl = `${baseUrl}?page_size=2`;
  let testResp;
  try {
    testResp = await fetch(testUrl);
  } catch (fetchErr: any) {
    throw new Error(`Fetch failed: ${fetchErr.message || "Network/CORS error"}. Upload a CSV instead.`);
  }
  if (!testResp.ok) {
    throw new Error(`API returned ${testResp.status} ${testResp.statusText}. Check region code.`);
  }
  onProgress && onProgress(0.05);

  const allResults: any[] = [];
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
      if (resp.ok) {
        const data = await resp.json();
        if (data.results) allResults.push(...data.results);
      }
    } catch (e) {}
    fetched++;
    onProgress && onProgress(0.05 + (fetched / 12) * 0.95);
    await new Promise((r) => setTimeout(r, 150));
  }

  allResults.sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime());
  const seen = new Set();
  const deduped = allResults.filter((r) => {
    if (seen.has(r.valid_from)) return false;
    seen.add(r.valid_from);
    return true;
  });

  return deduped;
}

export function calcMP(principal: number, rate: number, years: number) {
  if (principal <= 0) return 0;
  if (rate <= 0) return principal / (years * 12);
  const r = rate / 100 / 12,
    n = years * 12;
  return (principal * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1);
}

export function simulate(params: any, priceData: any, solarData: any, elecUsage: any, gasUsage: any, exportPriceData: any) {
  const {
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
    solarTilt,
    solarAzimuth,
    extraSolarArrays = [],
    battStrategy = "smart",
  } = params;

  const solarArrays = [{ kWp: solarKWp, tilt: solarTilt, azimuth: solarAzimuth }, ...extraSolarArrays];

  const annualHeatingGas = annualGas;
  const annualUsefulHeat = annualHeatingGas * (boilerEfficiency / 100);

  const hasRealData = priceData && Object.keys(priceData.dayData).length > 100;
  const monthStats = hasRealData ? priceData.monthStats : null;
  const hasRealExportData = exportPriceData && Object.keys(exportPriceData.dayData).length > 100;
  const exportMonthStats = hasRealExportData ? exportPriceData.monthStats : null;
  const hasRealSolarData = solarData && solarData.days && Object.keys(solarData.days).length > 100;
  const hasRealElec = elecUsage && elecUsage.totalDays > 10;
  const hasRealGas = gasUsage && gasUsage.totalDays > 10;

  const elecSeasonFactors = [1.15, 1.1, 1.0, 0.9, 0.85, 0.8, 0.8, 0.85, 0.95, 1.05, 1.1, 1.15];
  const gasSeasonFactors = DAYS_IN_MONTH.map((d, m) => heatingDegrees(UK_MONTHLY_TEMPS[m]) * d);
  const gasSeasonTotal = gasSeasonFactors.reduce((a, b) => a + b, 0);

  const elecMonthRaw = [];
  const gasMonthRaw = [];
  const elecProfilesPerMonth = [];

  for (let m = 0; m < 12; m++) {
    const days = DAYS_IN_MONTH[m];
    if (hasRealElec && elecUsage.monthStats[m].days > 0) {
      elecMonthRaw.push(elecUsage.monthStats[m].avgDailyKWh * days);
      elecProfilesPerMonth.push(elecUsage.monthStats[m].dailyProfiles);
    } else {
      elecMonthRaw.push((annualElec / 12) * elecSeasonFactors[m]);
      elecProfilesPerMonth.push(null);
    }
    if (hasRealGas && gasUsage.monthStats[m].days > 0) {
      gasMonthRaw.push(gasUsage.monthStats[m].avgDailyKWh * days);
    } else {
      const heating = gasSeasonTotal > 0 ? (annualHeatingGas * gasSeasonFactors[m]) / gasSeasonTotal : 0;
      gasMonthRaw.push(heating);
    }
  }

  const elecRawTotal = elecMonthRaw.reduce((a, b) => a + b, 0);
  const elecScale = elecRawTotal > 0 ? annualElec / elecRawTotal : 1;
  const elecMonthScaled = elecMonthRaw.map((v) => v * elecScale);

  const gasRawTotal = gasMonthRaw.reduce((a, b) => a + b, 0);
  const gasScale = gasRawTotal > 0 ? annualGas / gasRawTotal : 1;
  const gasMonthScaled = gasMonthRaw.map((v) => v * gasScale);

  const results = {
    months: [] as any[],
    currentTotal: 0,
    newTotal: 0,
    solarGenerated: 0,
    solarSelfConsumed: 0,
    solarExported: 0,
    batteryArbitrageRevenue: 0,
    gridImport: 0,
    gridExport: 0,
    hpElectricity: 0,
    usingRealData: hasRealData,
    usingRealSolar: hasRealSolarData,
    usingRealElec: hasRealElec,
    usingRealGas: hasRealGas,
    realDataDays: hasRealData ? Object.keys(priceData.dayData).length : 0,
    realSolarDays: hasRealSolarData ? Object.keys(solarData.days).length : 0,
    negativeSlots: 0,
    peakAvg: 0,
    offpeakAvg: 0,
    dailyLog: [] as any[],
    annualSaving: 0,
  };
  const dailyLog = results.dailyLog;
  let totalDayCount = 0;

  let totalPeakSlots = 0,
    totalPeakSum = 0,
    totalOffpeakSlots = 0,
    totalOffpeakSum = 0;

  for (let m = 0; m < 12; m++) {
    const days = DAYS_IN_MONTH[m];
    const temp = UK_MONTHLY_TEMPS[m];
    const copMult = hpFlowTemp >= 55 ? 0.85 : hpFlowTemp >= 50 ? 0.92 : 1.0;
    const cop = heatPumpCOP(temp) * copMult;

    const monthGas = gasMonthScaled[m];
    const monthElec = elecMonthScaled[m];
    const currentGasCost = monthGas * (fixedGasRate / 100) + (fixedGasStanding / 100) * days;
    const currentElecCost = monthElec * (fixedElecRate / 100) + (fixedElecStanding / 100) * days;
    const currentTotal = currentGasCost + currentElecCost;

    const monthUsefulHeat = monthGas * (boilerEfficiency / 100);
    const hpTotalElec = monthUsefulHeat / cop;

    const realProfiles = elecProfilesPerMonth[m];
    let scaledProfiles = null;
    if (realProfiles && realProfiles.length > 0) {
      const profileDayTotal = realProfiles.reduce((s: number, p: number[]) => s + p.reduce((a, b) => a + b, 0), 0) / realProfiles.length;
      const targetDayTotal = monthElec / days;
      const pScale = profileDayTotal > 0 ? targetDayTotal / profileDayTotal : 1;
      scaledProfiles = realProfiles.map((p: number[]) => p.map((v) => v * pScale));
    }

    const hasRealSolar = solarData && solarData.stats && solarData.stats[m].days > 0;
    let monthSolar = 0;
    let daySolarArrays = null;

    let dayTempArrays = null;
    if (hasRealSolar) {
      daySolarArrays = solarData.stats[m].dailyOutputs;
      dayTempArrays = solarData.stats[m].dailyTemps;
      monthSolar = (solarData.stats[m].totalKWh / solarData.stats[m].days) * days;
    } else {
      for (const arr of solarArrays) {
        const arrKWhPerKWp = correctedSolarKWh(arr.tilt, arr.azimuth);
        monthSolar += arr.kWp * arrKWhPerKWp[m];
      }
    }

    const solarProfile = generateSolarProfile(m, solarAzimuth);

    let dayPriceArrays;
    if (hasRealData && monthStats[m].days > 0) {
      dayPriceArrays = monthStats[m].allDayPrices;
    } else {
      const synth = generateSyntheticAgile(m);
      dayPriceArrays = Array.from({ length: days }, () => synth);
    }

    let dayExportPriceArrays: any[] | null;
    if (hasRealExportData && exportMonthStats[m].days > 0) {
      dayExportPriceArrays = exportMonthStats[m].allDayPrices;
    } else {
      dayExportPriceArrays = null;
    }

    let mGridImport = 0,
      mGridExport = 0,
      mGridCost = 0,
      mExportRev = 0,
      mSolarSelf = 0,
      mBattArb = 0;
    let mGridBatt = 0,
      mBattHome = 0,
      mBattExport = 0,
      mSolarExport = 0;
    let battSOC = batteryKWh * 0.5;
    const maxCR = batteryPowerKW * 0.5;
    const bMin = batteryKWh * 0.05;
    const bMax = batteryKWh * 0.95;

    for (let d = 0; d < days; d++) {
      const dayPrices = dayPriceArrays[d % dayPriceArrays.length];
      const dayExportPrices = dayExportPriceArrays ? dayExportPriceArrays[d % dayExportPriceArrays.length] : null;

      const daySolar = [],
        dayDemand = [],
        dayHeating = [];

      let dayCop = cop;
      let dayHeatingWeight = 1.0;

      if (dayTempArrays) {
        const dTempArr = dayTempArrays[d % dayTempArrays.length];
        const avgT = dTempArr.reduce((a: number, b: number) => a + b, 0) / dTempArr.length;
        dayCop = heatPumpCOP(avgT) * copMult;
        // Degree days relative to 15.5C base
        const dd = Math.max(0, 15.5 - avgT);
        const monthAvgDD = heatingDegrees(temp);
        dayHeatingWeight = monthAvgDD > 0 ? dd / monthAvgDD : 1.0;
      }

      for (let s = 0; s < 48; s++) {
        const bd = scaledProfiles ? scaledProfiles[d % scaledProfiles.length][s] : (monthElec / days) * DEMAND_PROFILE[s];
        // Heating demand scaled by weather
        const hd = (monthUsefulHeat / days / dayCop) * HEATING_PROFILE[s] * dayHeatingWeight;
        const sg = daySolarArrays ? daySolarArrays[d % daySolarArrays.length][s] : (monthSolar / days) * solarProfile[s];
        daySolar.push(sg);
        dayDemand.push(bd + hd);
        dayHeating.push(hd);
      }

      const dailyTotalDemand = dayDemand.reduce((a, b) => a + b, 0);
      const dailyTotalSolar = daySolar.reduce((a, b) => a + b, 0);

      const sorted = dayPrices.slice().sort((a: number, b: number) => a - b);
      const cheapThresh = sorted[Math.min(9, sorted.length - 1)];
      const expThresh = sorted[Math.max(0, sorted.length - 9)];

      for (let slot = 0; slot < 48; slot++) {
        const price = dayPrices[slot];
        const expPrice = dayExportPrices ? dayExportPrices[slot] : exportRate;
        const solarGen = daySolar[slot];
        const totalDemand = Math.max(0, dayDemand[slot]);
        const solarDirect = Math.min(solarGen, totalDemand);
        let solarSurplus = Math.max(0, solarGen - totalDemand);
        let netDemand = Math.max(0, totalDemand - solarGen);
        mSolarSelf += solarDirect;

        if (price < 0) results.negativeSlots++;
        const h = slot / 2;
        if (h >= 16 && h < 19) {
          totalPeakSlots++;
          totalPeakSum += price;
        } else {
          totalOffpeakSlots++;
          totalOffpeakSum += price;
        }

        let slotGridHome = 0,
          slotGridBatt = 0,
          slotBattHome = 0,
          slotBattExport = 0,
          slotSolarExport = 0,
          slotSolarBatt = 0;
        const isCheap = price <= cheapThresh;
        const isExpensive = price >= expThresh;
        const medPrice = sorted[24];

        if (solarSurplus > 0 && battSOC < bMax) {
          const toStore = Math.min(solarSurplus, maxCR, (bMax - battSOC) / (batteryEfficiency / 100));
          battSOC += toStore * (batteryEfficiency / 100);
          solarSurplus -= toStore;
          slotSolarBatt = toStore;
        }

        if (solarSurplus > 0) {
          slotSolarExport = solarSurplus;
          mGridExport += solarSurplus;
          mSolarExport += solarSurplus;
          mExportRev += solarSurplus * (expPrice / 100);
        }

        if (battStrategy === "peak") {
          if (h >= 16 && h < 19 && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency / 100), netDemand);
            battSOC -= del / (batteryEfficiency / 100);
            netDemand -= del;
            slotBattHome = del;
            mBattHome += del;
            mBattArb += del * (price / 100);
          }
          if (h >= 16 && h < 19 && netDemand <= 0 && battSOC > bMin + 0.5) {
            const canExp = Math.min(maxCR, battSOC - bMin - 0.3);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency / 100);
              battSOC -= canExp;
              slotBattExport = exp;
              mGridExport += exp;
              mBattExport += exp;
              mExportRev += exp * (expPrice / 100);
              mBattArb += exp * (expPrice / 100);
            }
          }
          if (isCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency / 100));
            battSOC += c * (batteryEfficiency / 100);
            slotGridBatt = c;
            mGridImport += c;
            mGridBatt += c;
            mGridCost += c * (price / 100);
            mBattArb -= c * (price / 100);
          }
        } else if (battStrategy === "smart") {
          // Look ahead for the day - if we have high demand coming and low solar, be more aggressive charging
          const remainingDemand = dayDemand.slice(slot).reduce((a, b) => a + b, 0);
          const remainingSolar = daySolar.slice(slot).reduce((a, b) => a + b, 0);
          const needsCharging = remainingDemand > remainingSolar + (battSOC - bMin) * (batteryEfficiency / 100);

          const avgChargeCost = cheapThresh;
          const dischargeCostThresh = (avgChargeCost / (batteryEfficiency / 100)) * 1.1;

          if (price > dischargeCostThresh && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency / 100), netDemand);
            battSOC -= del / (batteryEfficiency / 100);
            netDemand -= del;
            slotBattHome = del;
            mBattHome += del;
            mBattArb += del * (price / 100);
          }
          if (isExpensive && netDemand <= 0 && battSOC > bMin + 0.5) {
            // Only export if we don't expect to need this energy for heating later today
            if (!needsCharging || expPrice > 35) {
              const canExp = Math.min(maxCR, battSOC - bMin - 0.3);
              if (canExp > 0 && expPrice > dischargeCostThresh) {
                const exp = canExp * (batteryEfficiency / 100);
                battSOC -= canExp;
                slotBattExport = exp;
                mGridExport += exp;
                mBattExport += exp;
                mExportRev += exp * (expPrice / 100);
                mBattArb += exp * (expPrice / 100);
              }
            }
          }
          if (isCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency / 100));
            battSOC += c * (batteryEfficiency / 100);
            slotGridBatt = c;
            mGridImport += c;
            mGridBatt += c;
            mGridCost += c * (price / 100);
            mBattArb -= c * (price / 100);
          }
        } else if (battStrategy === "maxExport") {
          if (isCheap && battSOC < bMax - 0.1) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency / 100));
            battSOC += c * (batteryEfficiency / 100);
            slotGridBatt = c;
            mGridImport += c;
            mGridBatt += c;
            mGridCost += c * (price / 100);
            mBattArb -= c * (price / 100);
          }
          if (price > medPrice && netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency / 100), netDemand);
            battSOC -= del / (batteryEfficiency / 100);
            netDemand -= del;
            slotBattHome = del;
            mBattHome += del;
            mBattArb += del * (price / 100);
          }
          if (isExpensive && battSOC > bMin + 0.3) {
            const canExp = Math.min(maxCR, battSOC - bMin - 0.2);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency / 100);
              battSOC -= canExp;
              slotBattExport = exp;
              mGridExport += exp;
              mBattExport += exp;
              mExportRev += exp * (expPrice / 100);
              mBattArb += exp * (expPrice / 100);
            }
          }
        } else if (battStrategy === "solarFirst") {
          if (netDemand > 0 && battSOC > bMin) {
            const d = Math.min(maxCR, battSOC - bMin);
            const del = Math.min(d * (batteryEfficiency / 100), netDemand);
            battSOC -= del / (batteryEfficiency / 100);
            netDemand -= del;
            slotBattHome = del;
            mBattHome += del;
            mBattArb += del * (price / 100);
          }
          const vCheap = sorted[Math.min(6, sorted.length - 1)];
          if (price <= vCheap && battSOC < bMax - 0.3) {
            const c = Math.min(maxCR, (bMax - battSOC) / (batteryEfficiency / 100));
            battSOC += c * (batteryEfficiency / 100);
            slotGridBatt = c;
            mGridImport += c;
            mGridBatt += c;
            mGridCost += c * (price / 100);
            mBattArb -= c * (price / 100);
          }
          if (isExpensive && netDemand <= 0 && battSOC > bMin + 1) {
            const canExp = Math.min(maxCR * 0.5, battSOC - bMin - 1);
            if (canExp > 0) {
              const exp = canExp * (batteryEfficiency / 100);
              battSOC -= canExp;
              slotBattExport = exp;
              mGridExport += exp;
              mBattExport += exp;
              mExportRev += exp * (expPrice / 100);
              mBattArb += exp * (expPrice / 100);
            }
          }
        }

        if (netDemand > 0) {
          slotGridHome = netDemand;
          mGridImport += netDemand;
          mGridCost += netDemand * (price / 100);
        }

        dailyLog.push({
          m,
          day: totalDayCount,
          slot,
          price,
          expPrice,
          battSOC,
          totalDemand,
          heatingDemand: dayHeating[slot],
          solarGen,
          solarDirect,
          gridHome: slotGridHome,
          gridBatt: slotGridBatt,
          solarBatt: slotSolarBatt,
          battHome: slotBattHome,
          battExport: slotBattExport,
          solarExport: slotSolarExport,
          temp: dayTempArrays ? dayTempArrays[d % dayTempArrays.length][Math.floor(slot/2)] : temp
        });
      }
      totalDayCount++;
    }

    const newElecCost = mGridCost + (agileStanding / 100) * days - mExportRev;

    results.months.push({
      month: [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ][m],
      days,
      temp,
      cop: cop.toFixed(2),
      gasUsage: monthGas,
      elecUsage: monthElec,
      currentGasCost,
      currentElecCost,
      currentTotal,
      hpElec: hpTotalElec,
      baseElec: monthElec,
      solarGen: monthSolar,
      solarSelfConsumed: mSolarSelf,
      gridImport: mGridImport,
      gridExport: mGridExport,
      gridBatt: mGridBatt,
      battHome: mBattHome,
      battExport: mBattExport,
      solarExport: mSolarExport,
      exportRevenue: mExportRev,
      batteryArbitrage: mBattArb,
      newElecCost,
      newTotal: newElecCost,
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
