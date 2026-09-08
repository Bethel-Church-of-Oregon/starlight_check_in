'use client'

import { useCallback, useEffect, useState } from 'react'
import Avatar, { displayName } from '@/components/Avatar'
import { SearchIcon, XIcon } from '@/components/icons'
import { useApp } from '@/components/app-context'
import type { Student } from '@/lib/types'
import { Notice, Panel } from './shared'

/** Roster management: look up a student, fix a typo, retire a leaver. */
export default function RosterPanel() {
  const { grades } = useApp()
  const [query, setQuery] = useState('')
  const [grade, setGrade] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [students, setStudents] = useState<Student[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Student | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (grade) params.set('grade', grade)
      if (includeInactive) params.set('includeInactive', '1')
      const response = await fetch(`/api/students?${params}`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'failed')
      setStudents(data.students ?? [])
    } catch {
      setError('명단을 불러올 수 없습니다.')
    } finally {
      setBusy(false)
    }
  }, [query, grade, includeInactive])

  useEffect(() => {
    const id = setTimeout(() => void load(), 200)
    return () => clearTimeout(id)
  }, [load])

  const remove = async (student: Student, hard: boolean) => {
    const name = displayName(student.korean_name, student.english_name)
    const prompt = hard
      ? `${name} 을 완전히 삭제합니다. 출석 기록도 함께 사라집니다. 계속할까요?`
      : `${name} 을 명단에서 비활성화할까요? 출석 기록은 그대로 남습니다.`
    if (!confirm(prompt)) return
    await fetch(`/api/students/${student.id}${hard ? '?hard=1' : ''}`, { method: 'DELETE' })
    void load()
  }

  return (
    <>
      <Panel
        title={`학생 명단 (${students.length})`}
        actions={
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            비활성 포함
          </label>
        }
      >
        {error && <Notice kind="error">{error}</Notice>}

        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="이름 · 전화 · 바코드"
                style={{ paddingRight: 38 }}
              />
              <span style={{ position: 'absolute', right: 12, color: 'var(--text-faint)' }}>
                {busy ? <span className="spinner" /> : <SearchIcon size={18} />}
              </span>
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <select value={grade} onChange={(event) => setGrade(event.target.value)}>
              <option value="">전체 학년</option>
              {grades.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="tableScroll">
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th>학년</th>
                <th>보호자</th>
                <th>전화</th>
                <th>메모</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id} style={{ opacity: student.active ? 1 : 0.5 }}>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar korean={student.korean_name} english={student.english_name} size="sm" />
                      <span>
                        <span style={{ fontWeight: 600 }}>
                          {displayName(student.korean_name, student.english_name)}
                        </span>
                        {student.korean_name && student.english_name && (
                          <span className="fieldHint" style={{ display: 'block' }}>
                            {student.english_name}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td>{student.grade}</td>
                  <td>{student.guardian_name ?? '—'}</td>
                  <td>{student.guardian_phone ?? '—'}</td>
                  <td>
                    {student.allergies && <span className="chip chipWarn">알레르기</span>}
                    {!student.active && <span className="chip">비활성</span>}
                  </td>
                  <td>
                    <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn" onClick={() => setEditing(student)}>
                        수정
                      </button>
                      <button
                        type="button"
                        className="btn btnDanger"
                        onClick={() => void remove(student, !student.active)}
                      >
                        {student.active ? '비활성' : '완전삭제'}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {students.length === 0 && !busy && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 26 }}>
                    조건에 맞는 학생이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {editing && (
        <EditStudentDialog
          student={editing}
          grades={grades}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}

function EditStudentDialog({
  student,
  grades,
  onClose,
  onSaved,
}: {
  student: Student
  grades: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    koreanName: student.korean_name ?? '',
    englishName: student.english_name ?? '',
    grade: student.grade,
    gender: student.gender ?? '',
    birthdate: student.birthdate?.slice(0, 10) ?? '',
    school: student.school ?? '',
    guardianName: student.guardian_name ?? '',
    guardianPhone: student.guardian_phone ?? '',
    guardianPhoneAlt: student.guardian_phone_alt ?? '',
    allergies: student.allergies ?? '',
    medicalNotes: student.medical_notes ?? '',
    notes: student.notes ?? '',
    code: student.code ?? '',
    active: student.active,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/students/${student.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '수정에 실패했습니다.')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '수정에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-label="Edit student">
      <div className="modal" style={{ width: 'min(660px, 100%)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column' }}>
        <div className="cardHeader">
          <span>{displayName(student.korean_name, student.english_name)} 정보 수정</span>
          <button type="button" className="iconBtn" onClick={onClose} aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="cardBody" style={{ overflowY: 'auto' }}>
          {error && <Notice kind="error">{error}</Notice>}

          <div className="fieldGrid">
            <div className="field">
              <label>한글 이름</label>
              <input value={form.koreanName} onChange={(e) => set('koreanName', e.target.value)} />
            </div>
            <div className="field">
              <label>영어 이름</label>
              <input value={form.englishName} onChange={(e) => set('englishName', e.target.value)} />
            </div>
            <div className="field">
              <label>학년</label>
              <select value={form.grade} onChange={(e) => set('grade', e.target.value)}>
                {[form.grade, ...grades.filter((g) => g !== form.grade)].map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>성별</label>
              <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
                <option value="">--</option>
                <option value="male">남 / Male</option>
                <option value="female">여 / Female</option>
              </select>
            </div>
            <div className="field">
              <label>생년월일</label>
              <input type="date" value={form.birthdate} onChange={(e) => set('birthdate', e.target.value)} />
            </div>
            <div className="field">
              <label>학교</label>
              <input value={form.school} onChange={(e) => set('school', e.target.value)} />
            </div>
            <div className="field">
              <label>보호자 이름</label>
              <input value={form.guardianName} onChange={(e) => set('guardianName', e.target.value)} />
            </div>
            <div className="field">
              <label>보호자 전화</label>
              <input value={form.guardianPhone} onChange={(e) => set('guardianPhone', e.target.value)} />
            </div>
            <div className="field">
              <label>추가 연락처</label>
              <input value={form.guardianPhoneAlt} onChange={(e) => set('guardianPhoneAlt', e.target.value)} />
            </div>
            <div className="field">
              <label>알레르기</label>
              <input value={form.allergies} onChange={(e) => set('allergies', e.target.value)} />
            </div>
            <div className="field">
              <label>바코드 / ID</label>
              <input value={form.code} onChange={(e) => set('code', e.target.value)} />
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label>의료 메모</label>
            <textarea value={form.medicalNotes} onChange={(e) => set('medicalNotes', e.target.value)} />
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>기타 메모</label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 15 }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            명단에서 활성 상태로 유지
          </label>
        </div>

        <div className="cardFooter">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn btnPrimary" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spinner" /> : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
