import React, { useRef, useEffect, useCallback, useState } from "react";
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
import { C, mono, fmt, fmtD, MONTHS } from "./utils";

export function RangeBrush({
  total,
  start,
  end,
  onChange,
  color = C.accent,
}: {
  total: number;
  start: number;
  end: number;
  onChange: (s: number, e: number) => void;
  color?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const loRef = useRef<HTMLDivElement>(null);
  const hiRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const loLabel = useRef<HTMLDivElement>(null);
  const hiLabel = useRef<HTMLDivElement>(null);
  const dragRef = useRef<any>(null);
  const liveRef = useRef({ s: start, e: end });

  useEffect(() => {
    liveRef.current = { s: start, e: end };
  }, [start, end]);

  const updateDOM = useCallback(() => {
    const { s, e } = liveRef.current;
    if (!trackRef.current) return;
    const lp = total > 0 ? (s / total) * 100 : 0;
    const rp = total > 0 ? (e / total) * 100 : 100;
    if (loRef.current) loRef.current.style.left = `calc(${lp}% - 7px)`;
    if (hiRef.current) hiRef.current.style.left = `calc(${rp}% - 7px)`;
    if (winRef.current) {
      winRef.current.style.left = `${lp}%`;
      winRef.current.style.width = `${rp - lp}%`;
    }
    if (outlineRef.current) {
      outlineRef.current.style.left = `${lp}%`;
      outlineRef.current.style.width = `${rp - lp}%`;
    }
    if (loLabel.current) {
      loLabel.current.style.left = `${lp}%`;
      loLabel.current.textContent = String(Math.floor(s / 48) + 1);
    }
    if (hiLabel.current) {
      hiLabel.current.style.right = `${100 - rp}%`;
      hiLabel.current.textContent = String(Math.ceil(e / 48));
    }
  }, [total]);

  const pxToIdx = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total);
    },
    [total]
  );

  const onDown = useCallback((which: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cx = e.clientX;
    dragRef.current = { type: which, panX: cx, panS: liveRef.current.s, panE: liveRef.current.e };
    if ((e.target as HTMLElement).setPointerCapture) (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cx = e.clientX;
      const { s, e: en } = liveRef.current;
      if (d.type === "lo") {
        const v = pxToIdx(cx);
        liveRef.current.s = Math.max(0, Math.min(v, en - 24));
      } else if (d.type === "hi") {
        const v = pxToIdx(cx);
        liveRef.current.e = Math.min(total, Math.max(v, s + 24));
      } else if (d.type === "pan") {
        if (!trackRef.current) return;
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
    },
    [total, pxToIdx, updateDOM]
  );

  const onUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    onChange(liveRef.current.s, liveRef.current.e);
  }, [onChange]);

  const leftPct = total > 0 ? (start / total) * 100 : 0;
  const rightPct = total > 0 ? (end / total) * 100 : 100;

  return (
    <div
      ref={trackRef}
      style={{
        position: "relative",
        height: 28,
        marginBottom: 10,
        touchAction: "none",
        userSelect: "none",
      } as React.CSSProperties}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 0,
          right: 0,
          height: 12,
          borderRadius: 6,
          background: "rgba(255,255,255,0.05)",
        }}
      />
      <div
        ref={winRef}
        style={{
          position: "absolute",
          top: 8,
          left: `${leftPct}%`,
          width: `${rightPct - leftPct}%`,
          height: 12,
          borderRadius: 4,
          background: color,
          opacity: 0.15,
          cursor: "grab",
        }}
        onPointerDown={(e) => onDown("pan", e)}
      />
      <div
        ref={outlineRef}
        style={{
          position: "absolute",
          top: 7,
          left: `${leftPct}%`,
          width: `${rightPct - leftPct}%`,
          height: 14,
          borderRadius: 4,
          border: `1.5px solid ${color}`,
          opacity: 0.5,
          pointerEvents: "none",
        }}
      />
      <div
        ref={loRef}
        onPointerDown={(e) => onDown("lo", e)}
        style={{
          position: "absolute",
          top: 4,
          left: `calc(${leftPct}% - 7px)`,
          width: 14,
          height: 20,
          borderRadius: 4,
          background: color,
          cursor: "ew-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ width: 2, height: 8, background: C.bg, borderRadius: 1 }} />
      </div>
      <div
        ref={hiRef}
        onPointerDown={(e) => onDown("hi", e)}
        style={{
          position: "absolute",
          top: 4,
          left: `calc(${rightPct}% - 7px)`,
          width: 14,
          height: 20,
          borderRadius: 4,
          background: color,
          cursor: "ew-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ width: 2, height: 8, background: C.bg, borderRadius: 1 }} />
      </div>
      <div
        ref={loLabel}
        style={{
          position: "absolute",
          top: 0,
          left: `${leftPct}%`,
          transform: "translateX(-50%)",
          fontSize: 7,
          color: C.dim,
        }}
      >
        {Math.floor(start / 48) + 1}
      </div>
      <div
        ref={hiLabel}
        style={{
          position: "absolute",
          top: 0,
          right: `${100 - rightPct}%`,
          transform: "translateX(50%)",
          fontSize: 7,
          color: C.dim,
        }}
      >
        {Math.ceil(end / 48)}
      </div>
    </div>
  );
}

export function TouchChart({ children, height }: { children: React.ReactNode; height: number | string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: TouchEvent) => {
      e.preventDefault();
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);
  return (
    <div ref={ref} style={{ width: "100%", height, touchAction: "none" }}>
      {children}
    </div>
  );
}

export function Slider({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  step,
  color = C.accent,
  prefix = "",
  clampMode,
  onCycleClamp,
  clampMin,
  clampMax,
  onClampChange,
}: any) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const pct = ((value - min) / (max - min)) * 100;
  const isFixed = clampMode === "fixed";
  const isClamped = clampMode === "clamp" && clampMin != null && clampMax != null;
  const cLeftPct = isClamped ? Math.max(0, ((clampMin - min) / (max - min)) * 100) : 0;
  const cRightPct = isClamped ? Math.min(100, ((clampMax - min) / (max - min)) * 100) : 100;

  const pctToVal = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return value;
      const rect = trackRef.current.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = min + frac * (max - min);
      return Math.max(min, Math.min(max, Math.round(raw / step) * step));
    },
    [min, max, step, value]
  );

  const onPointerDown = useCallback((which: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(which);
    if ((e.target as HTMLElement).setPointerCapture) (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag || !onClampChange) return;
      const v = pctToVal(e.clientX);
      if (drag === "lo") onClampChange(Math.min(v, clampMax != null ? clampMax : max), clampMax);
      else if (drag === "hi") onClampChange(clampMin, Math.max(v, clampMin != null ? clampMin : min));
    },
    [drag, pctToVal, clampMin, clampMax, min, max, onClampChange]
  );

  const onPointerUp = useCallback(() => setDrag(null), []);

  const dotStyle = (leftPct: number, col: string, size: number): React.CSSProperties => ({
    position: "absolute",
    top: 3 - size / 2,
    left: `calc(${leftPct}% - ${size / 2}px)`,
    width: size,
    height: size,
    borderRadius: "50%",
    background: col,
    border: `2px solid ${C.bg}`,
    zIndex: 5,
    cursor: "pointer",
    boxShadow: `0 0 4px ${col}55`,
    touchAction: "none",
  });

  return (
    <div style={{ marginBottom: 14, opacity: isFixed ? 0.45 : 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {onCycleClamp && (
            <button
              className="glass-pill"
              onClick={onCycleClamp}
              style={{
                borderRadius: 4,
                padding: "1px 5px",
                cursor: "pointer",
                fontSize: 8,
                fontWeight: 700,
                lineHeight: "16px",
                color: isFixed ? C.red : isClamped ? C.yellow : C.green,
              } as React.CSSProperties}
            >
              {isFixed ? "FIXED" : isClamped ? "CLAMP" : "FREE"}
            </button>
          )}
          <span style={{ fontSize: 12, color: C.text, letterSpacing: 0.3 }}>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {isClamped && (
            <span style={{ fontSize: 9, color: C.yellow, fontFamily: mono }}>
              {clampMin}–{clampMax}
            </span>
          )}
          <span style={{ fontSize: 13, color, fontFamily: mono, fontWeight: 600 }}>
            {prefix}
            {typeof value === "number" ? value.toLocaleString() : value}
            {unit}
          </span>
        </div>
      </div>
      <div
        ref={trackRef}
        style={{ position: "relative", height: 6, marginTop: isClamped ? 6 : 0, marginBottom: isClamped ? 6 : 0 }}
      >
        <div
          className="glass-pill"
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, borderRadius: 3, zIndex: 0 }}
        />
        {isClamped && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 6,
              borderRadius: 3,
              overflow: "hidden",
              zIndex: 1,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                width: `${cLeftPct}%`,
                height: "100%",
                background: "rgba(248,113,113,0.3)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: `${cLeftPct}%`,
                width: `${Math.max(0, cRightPct - cLeftPct)}%`,
                height: "100%",
                background: "rgba(251,191,36,0.12)",
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 0,
                width: `${Math.max(0, 100 - cRightPct)}%`,
                height: "100%",
                background: "rgba(248,113,113,0.3)",
              }}
            />
          </div>
        )}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: `${pct}%`,
            height: 6,
            borderRadius: 3,
            background: color,
            opacity: 0.7,
            zIndex: 2,
            pointerEvents: "none",
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => !isFixed && onChange(parseFloat(e.target.value))}
          disabled={isFixed}
          style={{
            width: "100%",
            height: 6,
            borderRadius: 3,
            appearance: "none",
            position: "relative",
            zIndex: 3,
            background: "transparent",
            cursor: isFixed ? "not-allowed" : "pointer",
          } as React.CSSProperties}
        />
        {isClamped && (
          <div
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ position: "absolute", top: -6, left: 0, right: 0, bottom: -6, zIndex: drag ? 10 : 4 }}
          >
            <div onPointerDown={(e) => onPointerDown("lo", e)} style={dotStyle(cLeftPct, C.yellow, 14)} />
            <div onPointerDown={(e) => onPointerDown("hi", e)} style={dotStyle(cRightPct, C.yellow, 14)} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, color = C.accent, icon }: any) {
  return (
    <div className="glass-card" style={{ borderRadius: 20, padding: "16px 18px", flex: 1, minWidth: 110 }}>
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          marginBottom: 6,
        }}
      >
        {icon && <span style={{ marginRight: 4 }}>{icon}</span>}
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: mono }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export function CumulativeChart({
  annualSaving,
  totalCost,
  financeMonthly,
  financeTerm,
  useFinance,
}: {
  annualSaving: number;
  totalCost: number;
  financeMonthly: number;
  financeTerm: number;
  useFinance: boolean;
}) {
  const yrs = 20;
  const pts = [];
  let cum = useFinance ? 0 : -totalCost;
  for (let y = 0; y <= yrs; y++) {
    if (useFinance) cum += annualSaving - (y > 0 && y <= financeTerm ? financeMonthly * 12 : 0);
    else cum += y > 0 ? annualSaving : 0;
    pts.push({ year: y, value: cum });
  }
  const minV = Math.min(...pts.map((p) => p.value)),
    maxV = Math.max(...pts.map((p) => p.value));
  const range = maxV - minV || 1;
  const w = 480,
    h = 150,
    pad = 20;
  const zY = pad + (maxV / range) * (h - 2 * pad);
  const beY = pts.find((p) => p.value >= 0)?.year;
  return (
    <div>
      <svg width="100%" height={h + 20} viewBox={`0 0 ${w} ${h + 20}`} preserveAspectRatio="none">
        <line x1="0" y1={zY} x2={w} y2={zY} stroke={C.muted} strokeWidth="1" strokeDasharray="4,4" />
        <polygon
          fill={C.green}
          opacity="0.15"
          points={`${pts
            .map((p, i) => {
              const x = (i / yrs) * w,
                y = pad + ((maxV - p.value) / range) * (h - 2 * pad);
              return `${x},${y}`;
            })
            .join(" ")} ${w},${zY} 0,${zY}`}
        />
        <polyline
          fill="none"
          stroke={C.green}
          strokeWidth="3"
          points={pts
            .map((p, i) => {
              const x = (i / yrs) * w,
                y = pad + ((maxV - p.value) / range) * (h - 2 * pad);
              return `${x},${y}`;
            })
            .join(" ")}
        />
        {beY != null && (
          <g>
            <line
              x1={(beY / yrs) * w}
              y1={pad - 4}
              x2={(beY / yrs) * w}
              y2={h - pad + 4}
              stroke={C.accent}
              strokeWidth="2"
              strokeDasharray="4,4"
            />
            <text
              x={(beY / yrs) * w}
              y={pad - 10}
              fill={C.accent}
              fontSize="12"
              textAnchor="middle"
              fontFamily={mono}
            >
              Yr {beY}
            </text>
          </g>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginTop: 0 }}>
        {[0, 5, 10, 15, 20].map((y) => (
          <span key={y} style={{ flex: 1, textAlign: "center" }}>
            Y{y}
          </span>
        ))}
      </div>
    </div>
  );
}
