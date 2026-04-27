// Utility functions and constants for the Energy Simulator

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const UK_MONTHLY_TEMPS = [4.5, 4.6, 6.5, 8.9, 12.0, 14.8, 17.0, 16.7, 14.1, 10.7, 7.3, 4.8];
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const heatingDegrees = (t: number) => Math.max(0, 15.5 - t);
export const SOLAR_KWH_PER_KWP_BASE = [25, 40, 75, 110, 130, 140, 135, 115, 85, 55, 30, 20];

export const DNO_REGIONS = [
  { code: "A", name: "East England" },
  { code: "B", name: "East Midlands" },
  { code: "C", name: "London" },
  { code: "D", name: "Merseyside & N.Wales" },
  { code: "E", name: "West Midlands" },
  { code: "F", name: "North East" },
  { code: "G", name: "North West" },
  { code: "H", name: "Southern" },
  { code: "J", name: "South East" },
  { code: "K", name: "South Wales" },
  { code: "L", name: "South West" },
  { code: "M", name: "Yorkshire" },
  { code: "N", name: "S. Scotland" },
  { code: "P", name: "N. Scotland" },
];

export const AGILE_PRODUCT = "AGILE-FLEX-22-11-25";
export const AGILE_EXPORT_PRODUCT = "AGILE-OUTGOING-19-05-13";

export const repairJSON = (text: string) => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {}
  const resultsIdx = trimmed.indexOf('"results"');
  if (resultsIdx > -1) {
    const lastComplete = trimmed.lastIndexOf("},");
    const lastObj = trimmed.lastIndexOf("}");
    const cutPoint = lastComplete > resultsIdx ? lastComplete + 1 : (lastObj > resultsIdx ? lastObj + 1 : -1);
    if (cutPoint > resultsIdx) {
      try {
        return JSON.parse(trimmed.substring(0, cutPoint) + "]}");
      } catch (e2) {}
    }
  }
  if (trimmed.startsWith("[")) {
    const lc2 = trimmed.lastIndexOf("},");
    const lo2 = trimmed.lastIndexOf("}");
    const cp2 = lc2 > 0 ? lc2 + 1 : (lo2 > 0 ? lo2 + 1 : -1);
    if (cp2 > 0) {
      try {
        return JSON.parse(trimmed.substring(0, cp2) + "]");
      } catch (e3) {}
    }
  }
  if (trimmed.includes('"hourly"')) {
    let attempt = trimmed;
    let braces = 0,
      brackets = 0;
    for (let ci = 0; ci < attempt.length; ci++) {
      const ch = attempt[ci];
      if (ch === "{") braces++;
      else if (ch === "}") braces--;
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
    }
    let end = attempt.length;
    while (end > 0 && !/[\d\]}"null]/.test(attempt[end - 1])) end--;
    if (end > 0 && attempt[end - 1] === ",") end--;
    attempt = attempt.substring(0, end);
    while (brackets > 0) {
      attempt += "]";
      brackets--;
    }
    while (braces > 0) {
      attempt += "}";
      braces--;
    }
    try {
      return JSON.parse(attempt);
    } catch (e4) {}
  }
  throw new Error("Could not parse JSON — try copying a smaller amount of text");
};

export const fmt = (v: number) => `£${Math.abs(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
export const fmtD = (v: number) => `£${v.toFixed(2)}`;

export const C = {
  bg: "#0f172a",
  card: "transparent",
  border: "rgba(255,255,255,0.12)",
  accent: "#22d3ee",
  accentDim: "rgba(34,211,238,0.12)",
  green: "#34d399",
  greenDim: "rgba(52,211,153,0.12)",
  red: "#f87171",
  redDim: "rgba(248,113,113,0.10)",
  orange: "#fb923c",
  orangeDim: "rgba(251,146,60,0.12)",
  yellow: "#fbbf24",
  yellowDim: "rgba(251,191,36,0.12)",
  purple: "#a78bfa",
  purpleDim: "rgba(167,139,250,0.12)",
  blue: "#60a5fa",
  blueDim: "rgba(96,165,250,0.12)",
  text: "#e2e8f0",
  dim: "#94a3b8",
  muted: "#64748b",
};

export const mono = "'JetBrains Mono','Fira Code',monospace";
