'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Two small single-series charts, drawn as inline SVG.
 *
 * Single series throughout, so identity is never carried by colour: one hue
 * (#2a78d6 — validated for the lightness band, chroma floor and >= 3:1 contrast
 * against the white card), a recessive grid, thin marks with 4px rounded
 * data-ends on the baseline, a 2px gap between adjacent bars, direct labels
 * only where they earn their place, and a hover tooltip on every mark. The
 * numbers also exist as tables further down the panel.
 */
const SERIES = '#2a78d6'
const GRID = '#eceaf0'
const AXIS_TEXT = '#a3a2ac'
const INK = '#26262b'
const INK_SOFT = '#6f6e79'

/** Container width in CSS pixels, so mark geometry is never scaled by a viewBox. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}

/** Rect with only the data-end (top) corners rounded. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h)
  return `M${x} ${y + h}V${y + radius}a${radius} ${radius} 0 0 1 ${radius} ${-radius}h${
    w - radius * 2
  }a${radius} ${radius} 0 0 1 ${radius} ${radius}V${y + h}Z`
}

interface Tooltip {
  x: number
  y: number
  title: string
  value: string
}

export function AttendanceBars({
  data,
  formatLabel,
  emptyText = '표시할 데이터가 없습니다.',
}: {
  data: { key: string; label: string; value: number }[]
  formatLabel?: (key: string) => string
  emptyText?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<Tooltip | null>(null)

  const height = 210
  const padding = { top: 18, right: 8, bottom: 26, left: 34 }
  const plotW = Math.max(0, width - padding.left - padding.right)
  const plotH = height - padding.top - padding.bottom

  const max = Math.max(1, ...data.map((d) => d.value))
  const niceMax = niceCeil(max)
  const slot = data.length > 0 ? plotW / data.length : 0
  const barW = Math.max(3, Math.min(46, slot - 2)) // 2px surface gap between bars
  const peak = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0)

  const show = useCallback(
    (index: number, cx: number, cy: number) => {
      const d = data[index]
      setTip({
        x: cx,
        y: cy,
        title: formatLabel ? formatLabel(d.key) : d.label,
        value: `${d.value}명 체크인`,
      })
    },
    [data, formatLabel]
  )

  if (data.length === 0) {
    return <div className="emptyState">{emptyText}</div>
  }

  // Thin the x labels until they stop colliding.
  const labelEvery = Math.max(1, Math.ceil((data.length * 58) / Math.max(plotW, 1)))

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="세션별 체크인 인원">
          {[0, 0.5, 1].map((t) => {
            const y = padding.top + plotH * (1 - t)
            return (
              <g key={t}>
                <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
                <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                  {Math.round(niceMax * t)}
                </text>
              </g>
            )
          })}

          {data.map((d, index) => {
            const h = (d.value / niceMax) * plotH
            const x = padding.left + index * slot + (slot - barW) / 2
            const y = padding.top + plotH - h
            return (
              <g key={d.key}>
                <path d={barPath(x, y, barW, Math.max(h, 1), 4)} fill={SERIES} />
                {index === peak && d.value > 0 && (
                  <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill={INK}>
                    {d.value}
                  </text>
                )}
                {index % labelEvery === 0 && (
                  <text
                    x={x + barW / 2}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize={11}
                    fill={AXIS_TEXT}
                  >
                    {d.label}
                  </text>
                )}
                {/* Hit target is the whole column, not just the mark. */}
                <rect
                  x={padding.left + index * slot}
                  y={padding.top}
                  width={Math.max(slot, 8)}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => show(index, x + barW / 2, y)}
                  onMouseLeave={() => setTip(null)}
                  onTouchStart={() => show(index, x + barW / 2, y)}
                  style={{ cursor: 'pointer' }}
                />
              </g>
            )
          })}
        </svg>
      )}

      {tip && <ChartTooltip {...tip} containerWidth={width} />}
    </div>
  )
}

export function CategoryBars({
  data,
  emptyText = '표시할 데이터가 없습니다.',
}: {
  data: { key: string; label: string; value: number }[]
  emptyText?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<Tooltip | null>(null)

  const rowH = 30
  const gap = 2 // 2px surface gap between adjacent bars
  const labelW = 62
  const valueW = 46
  const plotW = Math.max(0, width - labelW - valueW)
  const max = Math.max(1, ...data.map((d) => d.value))

  if (data.length === 0) {
    return <div className="emptyState">{emptyText}</div>
  }

  const height = data.length * (rowH + gap)

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="학년별 체크인 인원">
          {data.map((d, index) => {
            const w = Math.max(2, (d.value / max) * plotW)
            const y = index * (rowH + gap)
            const barH = 14
            const barY = y + (rowH - barH) / 2
            return (
              <g key={d.key}>
                <text x={0} y={y + rowH / 2 + 4} fontSize={13} fill={INK_SOFT}>
                  {d.label}
                </text>
                <path
                  d={rightRoundedBar(labelW, barY, w, barH, 4)}
                  fill={SERIES}
                />
                <text
                  x={labelW + w + 8}
                  y={y + rowH / 2 + 4}
                  fontSize={13}
                  fontWeight={600}
                  fill={INK}
                >
                  {d.value}
                </text>
                <rect
                  x={0}
                  y={y}
                  width={Math.max(width, 8)}
                  height={rowH}
                  fill="transparent"
                  onMouseEnter={() =>
                    setTip({ x: labelW + w, y: barY, title: d.label, value: `${d.value}명 체크인` })
                  }
                  onMouseLeave={() => setTip(null)}
                  style={{ cursor: 'pointer' }}
                />
              </g>
            )
          })}
        </svg>
      )}
      {tip && <ChartTooltip {...tip} containerWidth={width} />}
    </div>
  )
}

function rightRoundedBar(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  return `M${x} ${y}h${w - radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}v${
    h - radius * 2
  }a${radius} ${radius} 0 0 1 ${-radius} ${radius}h${-(w - radius)}Z`
}

function ChartTooltip({
  x,
  y,
  title,
  value,
  containerWidth,
}: Tooltip & { containerWidth: number }) {
  const width = 150
  const left = Math.max(0, Math.min(containerWidth - width, x - width / 2))
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left,
        top: Math.max(0, y - 54),
        width,
        pointerEvents: 'none',
        background: '#fff',
        border: '1px solid var(--card-border)',
        borderRadius: 6,
        boxShadow: '0 4px 14px rgba(20,12,30,0.16)',
        padding: '7px 10px',
        fontSize: 13,
        zIndex: 5,
      }}
    >
      <div style={{ color: INK_SOFT }}>{title}</div>
      <div style={{ fontWeight: 700, color: INK }}>{value}</div>
    </div>
  )
}

function niceCeil(value: number): number {
  if (value <= 5) return 5
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2)
}
