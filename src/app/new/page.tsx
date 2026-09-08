'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useApp } from '@/components/app-context'
import Avatar, { displayName } from '@/components/Avatar'
import { AlertIcon, ArrowLeftIcon, CheckIcon, ChevronDownIcon } from '@/components/icons'

const HANGUL = /[ㄱ-ㆎ가-힣]/

interface FormState {
  koreanName: string
  englishName: string
  grade: string
  gender: string
  birthdate: string
  school: string
  guardianName: string
  guardianPhone: string
  guardianPhoneAlt: string
  allergies: string
  medicalNotes: string
  notes: string
  code: string
}

const EMPTY: FormState = {
  koreanName: '',
  englishName: '',
  grade: '',
  gender: '',
  birthdate: '',
  school: '',
  guardianName: '',
  guardianPhone: '',
  guardianPhoneAlt: '',
  allergies: '',
  medicalNotes: '',
  notes: '',
  code: '',
}

/**
 * New student registration. Planning Center models a household; we model a
 * single person, so this is one flat form with the extras folded away.
 *
 * The Suspense wrapper is required because the form reads `?name=` to carry
 * over whatever was typed into the search box.
 */
export default function NewStudentScreen() {
  return (
    <Suspense
      fallback={
        <div className="stack">
          <div className="card">
            <div className="emptyState">불러오는 중…</div>
          </div>
        </div>
      }
    >
      <NewStudentForm />
    </Suspense>
  )
}

function NewStudentForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { grades } = useApp()

  const [form, setForm] = useState<FormState>(EMPTY)
  const [showMore, setShowMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ id: string; korean: string | null; english: string | null } | null>(
    null
  )

  // Carry over whatever the volunteer typed into the search box.
  useEffect(() => {
    const prefill = searchParams.get('name')?.trim()
    if (!prefill) return
    setForm((f) =>
      HANGUL.test(prefill) ? { ...f, koreanName: prefill } : { ...f, englishName: prefill }
    )
  }, [searchParams])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const canSave = useMemo(
    () =>
      (form.koreanName.trim() !== '' || form.englishName.trim() !== '') &&
      form.grade.trim() !== '' &&
      !saving,
    [form.koreanName, form.englishName, form.grade, saving]
  )

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '등록에 실패했습니다.')
      setSaved({
        id: data.student.id,
        korean: data.student.korean_name,
        english: data.student.english_name,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '등록에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  // --- success -----------------------------------------------------------
  useEffect(() => {
    if (!saved) return
    const id = setTimeout(() => router.push('/'), 3500)
    return () => clearTimeout(id)
  }, [saved, router])

  if (saved) {
    return (
      <div className="confirm">
        <p className="confirmBig">등록 완료!</p>
        <p className="confirmSmall">새 친구가 명단에 추가되었어요</p>

        <div className="confirmNames">
          <div className="confirmCard">
            <Avatar korean={saved.korean} english={saved.english} size="lg" />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {displayName(saved.korean, saved.english)}
              </div>
              <div style={{ fontSize: 16, opacity: 0.9 }}>{form.grade}</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 26, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            className="btn btnLarge"
            onClick={() => router.push(`/checkin/${saved.id}`)}
          >
            바로 체크인
          </button>
          <button type="button" className="btn btnLarge" onClick={() => router.push('/')}>
            처음 화면으로
          </button>
        </div>

        <div className="progressTrack" aria-hidden="true">
          <div className="progressBar" style={{ animationDuration: '3.5s' }} />
        </div>
      </div>
    )
  }

  // --- form --------------------------------------------------------------
  return (
    <div className="stack">
      <div className="card">
        <div className="cardHeader">
          <span>새 학생 등록</span>
        </div>

        <div className="cardBody">
          {error && (
            <div className="banner bannerError" style={{ marginBottom: 16 }} role="alert">
              <AlertIcon size={18} />
              <span>{error}</span>
            </div>
          )}

          <h2 className="sectionTitle">기본 정보</h2>

          <div className="fieldGrid">
            <div className="field">
              <label htmlFor="koreanName">한글 이름</label>
              <input
                id="koreanName"
                value={form.koreanName}
                onChange={(event) => set('koreanName', event.target.value)}
                autoComplete="off"
                placeholder="김민준"
              />
            </div>

            <div className="field">
              <label htmlFor="englishName">영어 이름</label>
              <input
                id="englishName"
                value={form.englishName}
                onChange={(event) => set('englishName', event.target.value)}
                autoComplete="off"
                placeholder="Minjun Kim"
              />
            </div>

            <div className="field">
              <label htmlFor="grade">
                학년<span className="required">*</span>
              </label>
              <select
                id="grade"
                value={form.grade}
                onChange={(event) => set('grade', event.target.value)}
              >
                <option value="">--</option>
                {grades.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="gender">성별</label>
              <select
                id="gender"
                value={form.gender}
                onChange={(event) => set('gender', event.target.value)}
              >
                <option value="">--</option>
                <option value="male">남 / Male</option>
                <option value="female">여 / Female</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="birthdate">생년월일</label>
              <input
                id="birthdate"
                type="date"
                value={form.birthdate}
                onChange={(event) => set('birthdate', event.target.value)}
              />
            </div>
          </div>

          <p className="fieldHint" style={{ marginTop: 10 }}>
            한글 이름과 영어 이름 중 최소 하나는 입력해 주세요. 영어 이름만 있는 학생도 등록할 수
            있습니다.
          </p>

          <button
            type="button"
            className="disclosure"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
          >
            <ChevronDownIcon
              size={16}
              style={{ transform: showMore ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
            {showMore ? '추가 정보 접기' : '추가 정보 입력 (보호자, 알레르기 등)'}
          </button>

          {showMore && (
            <>
              <h2 className="sectionTitle">보호자 정보</h2>
              <div className="fieldGrid">
                <div className="field">
                  <label htmlFor="guardianName">보호자 이름</label>
                  <input
                    id="guardianName"
                    value={form.guardianName}
                    onChange={(event) => set('guardianName', event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="guardianPhone">보호자 전화</label>
                  <input
                    id="guardianPhone"
                    type="tel"
                    inputMode="tel"
                    value={form.guardianPhone}
                    onChange={(event) => set('guardianPhone', event.target.value)}
                    placeholder="360-555-1234"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="guardianPhoneAlt">추가 연락처</label>
                  <input
                    id="guardianPhoneAlt"
                    type="tel"
                    inputMode="tel"
                    value={form.guardianPhoneAlt}
                    onChange={(event) => set('guardianPhoneAlt', event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="school">학교</label>
                  <input
                    id="school"
                    value={form.school}
                    onChange={(event) => set('school', event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>

              <h2 className="sectionTitle" style={{ marginTop: 22 }}>
                건강 / 기타
              </h2>
              <div className="fieldGrid">
                <div className="field">
                  <label htmlFor="allergies">알레르기</label>
                  <input
                    id="allergies"
                    value={form.allergies}
                    onChange={(event) => set('allergies', event.target.value)}
                    placeholder="땅콩, 유제품"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="code">바코드 / ID</label>
                  <input
                    id="code"
                    value={form.code}
                    onChange={(event) => set('code', event.target.value)}
                    placeholder="스캐너로 스캔하거나 직접 입력"
                    autoComplete="off"
                  />
                </div>
              </div>

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="medicalNotes">의료 메모</label>
                <textarea
                  id="medicalNotes"
                  value={form.medicalNotes}
                  onChange={(event) => set('medicalNotes', event.target.value)}
                />
              </div>

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="notes">기타 메모</label>
                <textarea
                  id="notes"
                  value={form.notes}
                  onChange={(event) => set('notes', event.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <div className="cardFooter">
          <button type="button" className="btn" onClick={() => router.back()}>
            <ArrowLeftIcon size={16} />
            Go back
          </button>
          <button
            type="button"
            className="btn btnPrimary btnLarge"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {saving ? (
              <>
                <span className="spinner" /> 저장 중…
              </>
            ) : (
              <>
                <CheckIcon size={16} /> 등록 완료
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
