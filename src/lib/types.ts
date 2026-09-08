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

export interface Service {
  id: string
  name: string
  start_time: string | null
  sort_order: number
  active: boolean
}

export interface CheckIn {
  id: string
  student_id: string
  service_id: string | null
  service_name: string | null
  session_date: string
  security_code: string
  grade: string | null
  checked_in_at: string
  checked_in_by: string | null
  checked_out_at: string | null
  checked_out_by: string | null
}

export interface GeneralSettings {
  churchName: string
  locationName: string
  timezone: string
  autoReturnSeconds: number
}

export interface PrinterSettings {
  host: string
  port: number
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
  showService: boolean
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
  serviceName: string | null
  checkedInAt: string
}
