'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PrinterIcon, RefreshIcon } from '@/components/icons'
import { renderLabelPreview, waitForFonts } from '@/lib/label'
import {
  bridgeConfigured,
  buildLabelJob,
  fetchBridgeStatus,
  sendToBridge,
  type BridgeStatus,
} from '@/lib/print-client'
import type { LabelPayload, LabelSettings, PrinterSettings } from '@/lib/types'
import { useVisiblePolling } from '@/lib/use-visible-polling'
import { Notice, Panel, Stat, Toggle } from './shared'

const SAMPLE: LabelPayload = {
  koreanName: '김민준',
  englishName: 'Minjun Kim',
  grade: '3rd',
  securityCode: 'H7KM',
  checkedInAt: new Date().toISOString(),
}

const MEDIA_WIDTHS = [62, 54, 50, 38, 29]

export default function PrinterPanel({
  printer,
  label,
  timezone,
  onSave,
}: {
  printer: PrinterSettings
  label: LabelSettings
  timezone: string
  onSave: (patch: { printer?: Partial<PrinterSettings>; label?: Partial<LabelSettings> }) => Promise<void>
}) {
  const [draft, setDraft] = useState<PrinterSettings>(printer)
  const [labelDraft, setLabelDraft] = useState<LabelSettings>(label)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [preview, setPreview] = useState<string>('')

  useEffect(() => setDraft(printer), [printer])
  useEffect(() => setLabelDraft(label), [label])

  // Status comes from the bridge on the LAN, using the *saved* address — the
  // draft may be half-typed.
  const loadStatus = useCallback(async () => {
    if (!bridgeConfigured(printer)) {
      setStatus(null)
      return
    }
    setStatus(await fetchBridgeStatus(printer))
  }, [printer])

  useVisiblePolling(loadStatus, 10000)

  // Redraw the preview whenever anything that affects the label changes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForFonts()
      if (cancelled) return
      try {
        setPreview(
          renderLabelPreview({
            payload: SAMPLE,
            label: labelDraft,
            timezone,
            mediaWidthMm: draft.mediaWidthMm,
            labelLengthMm: draft.labelLengthMm,
            cssWidth: 760,
          })
        )
      } catch {
        setPreview('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [labelDraft, draft.mediaWidthMm, draft.labelLengthMm, timezone])

  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !== JSON.stringify(printer) ||
      JSON.stringify(labelDraft) !== JSON.stringify(label),
    [draft, printer, labelDraft, label]
  )

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await onSave({ printer: draft, label: labelDraft })
      setMessage({ kind: 'ok', text: '저장되었습니다.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '저장 실패' })
    } finally {
      setSaving(false)
    }
  }

  const testPrint = async () => {
    setMessage(null)
    if (dirty) {
      setMessage({ kind: 'warn', text: '먼저 저장한 뒤 테스트 인쇄를 실행해 주세요.' })
      return
    }
    setTesting(true)
    try {
      const job = await buildLabelJob({
        payload: { ...SAMPLE, checkedInAt: new Date().toISOString() },
        label: labelDraft,
        printer: { ...printer, copies: 1 },
        timezone,
      })
      await sendToBridge(printer, job, 'Test print')
      setMessage({ kind: 'ok', text: `테스트 라벨을 인쇄했습니다 (${(job.length / 1024).toFixed(1)} KB).` })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '테스트 인쇄 실패' })
    } finally {
      setTesting(false)
      void loadStatus()
    }
  }

  const set = <K extends keyof PrinterSettings>(key: K, value: PrinterSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const setLabel = <K extends keyof LabelSettings>(key: K, value: LabelSettings[K]) =>
    setLabelDraft((d) => ({ ...d, [key]: value }))

  return (
    <>
      <Panel
        title="프린터 설정"
        actions={
          <button type="button" className="iconBtn" onClick={() => void loadStatus()} aria-label="Refresh">
            <RefreshIcon size={18} />
          </button>
        }
        footer={
          <>
            <button type="button" className="btn" onClick={() => void testPrint()} disabled={testing}>
              {testing ? <span className="spinner" /> : <PrinterIcon size={16} />} 테스트 인쇄
            </button>
            <button type="button" className="btn btnPrimary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <span className="spinner" /> : dirty ? '변경사항 저장' : '저장됨'}
            </button>
          </>
        }
      >
        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        {!bridgeConfigured(printer) && (
          <Notice kind="warn">
            프린트 브릿지 주소가 비어 있습니다. 라즈베리파이 브릿지 주소를 입력하고 저장해 주세요.
          </Notice>
        )}
        {status && !status.bridgeReachable && (
          <Notice kind="warn">
            브릿지에 연결할 수 없습니다. 라즈베리파이가 켜져 있는지, 이 기기가 같은 와이파이에
            있는지 확인해 주세요. 아이패드라면 Safari에서 브릿지 주소를 직접 열어 인증서 경고가
            뜨지 않는지도 확인해 주세요.
          </Notice>
        )}
        {status && status.bridgeReachable && !status.ok && status.messages.length > 0 && (
          <Notice kind="error">{status.messages.join(' / ')}</Notice>
        )}

        <div className="statRow" style={{ margin: '14px 0 20px' }}>
          <Stat value={status?.bridgeReachable ? '연결됨' : '끊김'} label="브릿지" />
          <Stat value={status?.printerReachable ? (status.ok ? '정상' : '오류') : '—'} label="프린터" />
          <Stat
            value={status?.mediaWidthMm ? `${status.mediaWidthMm} mm` : '—'}
            label="들어있는 용지"
          />
          <Stat value={status?.printerHost || '—'} label="프린터 IP (브릿지 설정)" />
        </div>

        {status?.mediaWidthMm !== undefined &&
          status.mediaWidthMm > 0 &&
          status.mediaWidthMm !== draft.mediaWidthMm && (
            <Notice kind="warn">
              프린터에 {status.mediaWidthMm} mm 용지가 들어 있는데 설정은 {draft.mediaWidthMm} mm
              입니다. 아래 테이프 폭을 맞춰 주세요.
            </Notice>
          )}

        <h3 className="sectionTitle">브릿지 연결</h3>
        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="bridgeUrl">브릿지 주소</label>
            <input
              id="bridgeUrl"
              value={draft.bridgeUrl}
              onChange={(event) => set('bridgeUrl', event.target.value)}
              placeholder="https://192.168.1.60:9443"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <span className="fieldHint">라즈베리파이의 고정 IP와 포트. 반드시 https 입니다.</span>
          </div>
          <div className="field">
            <label htmlFor="bridgeKey">브릿지 키</label>
            <input
              id="bridgeKey"
              value={draft.bridgeKey}
              onChange={(event) => set('bridgeKey', event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <span className="fieldHint">브릿지 config.json 의 key 와 같은 값</span>
          </div>
        </div>
        <p className="fieldHint" style={{ marginTop: 8 }}>
          프린터 IP는 라즈베리파이의 <code>bridge/config.json</code> 에서 설정합니다.
        </p>

        <h3 className="sectionTitle" style={{ marginTop: 22 }}>
          용지 / 인쇄
        </h3>
        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="mediaWidth">테이프 폭 (mm)</label>
            <select
              id="mediaWidth"
              value={draft.mediaWidthMm}
              onChange={(event) => set('mediaWidthMm', Number(event.target.value))}
            >
              {MEDIA_WIDTHS.map((mm) => (
                <option key={mm} value={mm}>
                  {mm} mm{mm === 62 ? ' (DK-2205 기본)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="labelLength">라벨 길이 (mm)</label>
            <input
              id="labelLength"
              type="number"
              min={20}
              max={300}
              value={draft.labelLengthMm}
              onChange={(event) => set('labelLengthMm', Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="copies">한 번에 인쇄할 장수</label>
            <input
              id="copies"
              type="number"
              min={1}
              max={5}
              value={draft.copies}
              onChange={(event) => set('copies', Number(event.target.value))}
            />
            <span className="fieldHint">2로 두면 보호자 픽업용 태그가 함께 나옵니다</span>
          </div>
          <div className="field">
            <label htmlFor="feed">여백 피드 (dots)</label>
            <input
              id="feed"
              type="number"
              min={0}
              max={500}
              value={draft.feedDots}
              onChange={(event) => set('feedDots', Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="threshold">흑백 임계값</label>
            <input
              id="threshold"
              type="range"
              min={40}
              max={240}
              value={draft.threshold}
              onChange={(event) => set('threshold', Number(event.target.value))}
              style={{ background: 'transparent', padding: 0 }}
            />
            <span className="fieldHint">{draft.threshold} — 글자가 흐리면 값을 올리세요</span>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <Toggle label="인쇄 사용" value={draft.enabled} onChange={(v) => set('enabled', v)} />
          <Toggle label="라벨마다 자동 커팅" value={draft.autocut} onChange={(v) => set('autocut', v)} />
          <Toggle label="마지막 라벨 후 커팅" value={draft.cutAtEnd} onChange={(v) => set('cutAtEnd', v)} />
          <Toggle
            label="180° 회전"
            hint="라벨이 거꾸로 나오면 켜세요"
            value={draft.rotate180}
            onChange={(v) => set('rotate180', v)}
          />
        </div>
      </Panel>

      <Panel title="라벨 내용">
        <div className="labelPreview" style={{ marginBottom: 18 }}>
          {preview ? <img src={preview} alt="Label preview" /> : <div className="emptyState">미리보기 생성 중…</div>}
        </div>

        <Toggle label="한글 이름" value={labelDraft.showKorean} onChange={(v) => setLabel('showKorean', v)} />
        <Toggle label="영어 이름" value={labelDraft.showEnglish} onChange={(v) => setLabel('showEnglish', v)} />
        <Toggle label="학년" value={labelDraft.showGrade} onChange={(v) => setLabel('showGrade', v)} />
        <Toggle label="픽업 보안코드" value={labelDraft.showCode} onChange={(v) => setLabel('showCode', v)} />
        <Toggle label="날짜 / 시간" value={labelDraft.showDateTime} onChange={(v) => setLabel('showDateTime', v)} />

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="nameScale">이름 크기 ({labelDraft.nameScale.toFixed(2)}×)</label>
          <input
            id="nameScale"
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={labelDraft.nameScale}
            onChange={(event) => setLabel('nameScale', Number(event.target.value))}
            style={{ background: 'transparent', padding: 0 }}
          />
        </div>
      </Panel>

    </>
  )
}
