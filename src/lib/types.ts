export interface Student {
  id: string
  korean_name: string | null
  english_name: string | null
  grade: string
  gender: string | null
  birthdate: string | null
  school: string | null
  guardian_name: string | null
  guardian_phone: string | null
  guardian_phone_alt: string | null
  allergies: string | null
  medical_notes: string | null
  notes: string | null
  code: string | null
  active: boolean
  created_at?: string
  updated_at?: string
}

export interface CheckIn {
  id: string
  student_id: string
  session_date: string
  security_code: string
  grade: string | null
  checked_in_at: string
  checked_in_by: string | null
}

export interface GeneralSettings {
  churchName: string
  locationName: string
  timezone: string
  autoReturnSeconds: number
}

export interface PrinterSettings {
  /**
   * The Raspberry Pi print bridge on the church LAN, e.g.
   * "https://192.168.1.60:9443". The printer's own IP lives in the bridge's
   * config, not here — a browser must never be able to point the bridge at an
   * arbitrary host.
   */
  bridgeUrl: string
  /**
   * Sent as X-Bridge-Key. It is visible to anyone who can load the app, so it
   * only keeps other devices on the LAN from printing; it is not a secret.
   */
  bridgeKey: string
  mediaWidthMm: number
  labelLengthMm: number
  copies: number
  autocut: boolean
  cutAtEnd: boolean
  rotate180: boolean
  feedDots: number
  threshold: number
  enabled: boolean
}

export interface LabelSettings {
  showKorean: boolean
  showEnglish: boolean
  showGrade: boolean
  showCode: boolean
  showDateTime: boolean
  nameScale: number
}

export interface AppSettings {
  general: GeneralSettings
  printer: PrinterSettings
  label: LabelSettings
  grades: string[]
}

/** What the check-in screen needs in order to draw and queue a label. */
export interface LabelPayload {
  koreanName: string | null
  englishName: string | null
  grade: string | null
  securityCode: string
  checkedInAt: string
}
