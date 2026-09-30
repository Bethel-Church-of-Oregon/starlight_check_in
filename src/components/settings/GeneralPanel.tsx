'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PlusIcon, TrashIcon } from '@/components/icons'
import type { GeneralSettings } from '@/lib/types'
import { Notice, Panel } from './shared'

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Asia/Seoul',
]

export default function GeneralPanel({
  general,
  grades,
  onSave,
}: {
  general: GeneralSettings
  grades: string[]
  onSave: (patch: {
    general?: Partial<GeneralSettings>
    grades?: string[]
    adminCode?: string
  }) => Promise<void>
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(general)
  const [gradeDraft, setGradeDraft] = useState<string[]>(grades)
  const [newCode, setNewCode] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => setDraft(general), [general])
  useEffect(() => setGradeDraft(grades), [grades])

  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !== JSON.stringify(general) ||
      JSON.stringify(gradeDraft) !== JSON.stringify(grades),
    [draft, general, gradeDraft, grades]
  )

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await onSave({ general: draft, grades: gradeDraft.filter((g) => g.trim() !== '') })
      setMessage({ kind: 'ok', text: '저장되었습니다.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '저장 실패' })
    } finally {
      setSaving(false)
    }
  }

  const changeCode = async () => {
    if (newCode.trim().length < 4) {
      setMessage({ kind: 'error', text: '관리자 코드는 4자 이상이어야 합니다.' })
      return
    }
    if (newCode !== confirmCode) {
      setMessage({ kind: 'error', text: '두 코드가 일치하지 않습니다.' })
      return
    }
    setSaving(true)
    try {
      await onSave({ adminCode: newCode.trim() })
      setNewCode('')
      setConfirmCode('')
      setMessage({ kind: 'ok', text: '관리자 코드가 변경되었습니다.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '변경 실패' })
    } finally {
      setSaving(false)
    }
  }

  const logout = async () => {
    await fetch('/api/admin/auth', { method: 'DELETE' })
    router.push('/')
  }

  return (
    <>
      <Panel
        title="일반 설정"
        footer={
          <>
            <span />
            <button type="button" className="btn btnPrimary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <span className="spinner" /> : dirty ? '변경사항 저장' : '저장됨'}
            </button>
          </>
        }
      >
        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="churchName">화면 제목</label>
            <input
              id="churchName"
              value={draft.churchName}
              onChange={(event) => setDraft({ ...draft, churchName: event.target.value })}
            />
            <span className="fieldHint">왼쪽 위에 표시됩니다</span>
          </div>
          <div className="field">
            <label htmlFor="locationName">장소 이름</label>
            <input
              id="locationName"
              value={draft.locationName}
              onChange={(event) => setDraft({ ...draft, locationName: event.target.value })}
            />
            <span className="fieldHint">오른쪽 아래에 표시됩니다</span>
          </div>
          <div className="field">
            <label htmlFor="timezone">시간대</label>
            <select
              id="timezone"
              value={draft.timezone}
              onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
            >
              {[draft.timezone, ...TIMEZONES.filter((t) => t !== draft.timezone)].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <span className="fieldHint">“오늘”의 기준이 되는 시간대입니다</span>
          </div>
          <div className="field">
            <label htmlFor="autoReturn">체크인 후 대기 시간 (초)</label>
            <input
              id="autoReturn"
              type="number"
              min={2}
              max={30}
              value={draft.autoReturnSeconds}
              onChange={(event) =>
                setDraft({ ...draft, autoReturnSeconds: Number(event.target.value) })
              }
            />
            <span className="fieldHint">이 시간이 지나면 처음 화면으로 돌아갑니다</span>
          </div>
        </div>

        <h3 className="sectionTitle" style={{ marginTop: 24 }}>
          학년 목록
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {gradeDraft.map((grade, index) => (
            <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                value={grade}
                onChange={(event) => {
                  const next = [...gradeDraft]
                  next[index] = event.target.value
                  setGradeDraft(next)
                }}
                style={{
                  width: 82,
                  minHeight: 40,
                  padding: '8px 10px',
                  background: 'var(--field)',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  fontSize: 15,
                }}
              />
              <button
                type="button"
                className="iconBtn"
                onClick={() => setGradeDraft(gradeDraft.filter((_, i) => i !== index))}
                aria-label={`Remove ${grade}`}
              >
                <TrashIcon size={15} />
              </button>
            </span>
          ))}
          <button type="button" className="btn" onClick={() => setGradeDraft([...gradeDraft, ''])}>
            <PlusIcon size={15} /> 학년 추가
          </button>
        </div>
      </Panel>

      <Panel
        title="관리자 코드"
        footer={
          <>
            <button type="button" className="btn btnDanger" onClick={() => void logout()}>
              관리자 세션 종료
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              onClick={() => void changeCode()}
              disabled={saving || newCode === ''}
            >
              코드 변경
            </button>
          </>
        }
      >
        <p className="fieldHint" style={{ marginBottom: 14 }}>
          오른쪽 아래 톱니바퀴를 눌렀을 때 입력하는 코드입니다. 숫자 키패드로 입력하므로 숫자만
          쓰는 것을 권장합니다. 관리자 세션은 30분 후 자동으로 만료됩니다.
        </p>
        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="newCode">새 코드</label>
            <input
              id="newCode"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={newCode}
              onChange={(event) => setNewCode(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="confirmCode">새 코드 확인</label>
            <input
              id="confirmCode"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirmCode}
              onChange={(event) => setConfirmCode(event.target.value)}
            />
          </div>
        </div>
      </Panel>
    </>
  )
}
