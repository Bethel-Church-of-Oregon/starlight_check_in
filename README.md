# Bethel Starlight Check-in System

교회 초등부 체크인 PWA. Planning Center Check-Ins를 대체하며, 아이들과 봉사자
입장에서는 화면과 동작이 거의 같도록 만들었습니다.

- **프론트엔드/백엔드**: Next.js 15 (App Router), Vercel 배포
- **데이터베이스**: Neon PostgreSQL
- **프린터**: Brother QL-820NWBc (이더넷/Wi-Fi, raw 9100 포트)
- **프린트 브릿지**: 같은 네트워크의 라즈베리파이 — [bridge/README.md](bridge/README.md)
- **아이패드**: 홈 화면에 추가하면 PWA로 전체화면 실행

---

## 1. 화면 구성

| 화면 | 경로 | 내용 |
|---|---|---|
| 기본 | `/` | 큰 검색창 하나. 한글/영어 이름·전화번호·바코드를 입력하면 아래에 실시간 목록. 결과가 없으면 **Add person** 버튼 |
| 체크인 | `/checkin/[id]` | 학생 카드 + 체크박스. 체크하면 오른쪽 아래 파란 **Check in 1 person** 활성화 → 랜덤 축하 메시지 화면 → 이름표 자동 인쇄 → 기본 화면 복귀 |
| 새 학생 등록 | `/new` | 한글 이름 / 영어 이름 / 학년(필수). 추가 정보는 접혀 있음. 등록 완료 메시지 후 기본 화면 복귀 |
| 세팅 | `/settings` | 오른쪽 아래 톱니바퀴 → 코드 입력 → 진입. 오늘 현황 / 학생 명단 / 프린터 / 통계 / 일반 |

오른쪽 위 **Start over** 와 오른쪽 아래 **톱니바퀴**는 모든 화면에 항상 표시됩니다.
톱니바퀴 왼쪽의 프린터 아이콘에는 상태 점이 붙습니다 — 초록(정상), 빨강(브릿지나
프린터에 연결 안 됨), 주황(용지 없음·커버 열림 등), 회색(인쇄 꺼짐 또는 브릿지 미설정).

Planning Center의 **household(가족) 개념은 쓰지 않습니다.** 모든 것이 학생 한 명
단위(person)입니다.

---

## 2. 인쇄 구조

```
아이패드 (Safari)
  │  1. Check in 버튼 → 서버에 체크인 기록 (Neon)
  │  2. 이름표를 Canvas에 300dpi로 그림 (한글 폰트는 브라우저가 가장 잘 처리)
  │  3. 1비트 래스터 → PackBits 압축 → Brother 인쇄 명령까지 조립
  │
  │  HTTPS, 같은 와이파이 안에서
  ▼
라즈베리파이 프린트 브릿지 (Node, 의존성 0개)
  │  4. 프린터 상태 확인 (용지 없음·커버 열림이면 바로 알려줌)
  │  5. 받은 바이트를 그대로 9100 포트에 write
  ▼
Brother QL-820NWBc
```

- **클라우드를 거치지 않습니다.** 인쇄 데이터는 교회 네트워크 밖으로 나가지 않고,
  체크인 버튼부터 이름표가 나오기까지 보통 1~2초입니다.
- **결과를 바로 압니다.** 용지가 떨어졌으면 확인 화면에 그 이유가 뜨고 **다시 인쇄**
  버튼이 나옵니다. 이름표가 실제로 나온 뒤에야 처음 화면으로 돌아갑니다.
- **브릿지는 바이트를 넘기기만 합니다.** 라벨 모양이나 인쇄 설정을 바꿔도 파이는
  건드릴 필요가 없습니다. `brother.ts` 는 브라우저에서도 도는 순수 코드라
  명령 조립은 아이패드가 합니다.
- **DB는 누가 체크인할 때만 깨어납니다.** 폴링하는 곳이 없어서, 일주일 내내 켜져
  있는 키오스크도 DB를 깨우지 않습니다. 프린터 상태 확인도 LAN 안의 브릿지에만
  묻습니다. Neon 무료 플랜은 쿼리가 5분 없으면 절전하고 월 100 CU-시간만
  주는데, 이 구조에서는 체크인하는 시간만 쓰입니다.

**브릿지가 HTTPS여야 하는 이유:** 아이패드는 앱을 HTTPS로 받아오고, Safari는
HTTPS 페이지가 `http://192.168.x.x` 로 요청하는 것을 막습니다(mixed content).
그래서 파이는 아이패드가 신뢰하는 인증서가 있어야 합니다. 교회 도메인으로
Let's Encrypt 인증서를 받거나, 도메인이 없으면 자체 인증서를 아이패드에 한 번
설치합니다. 절차는 [bridge/README.md](bridge/README.md) 4번에 있습니다.

---

## 3. 설치

### 3-1. Neon 데이터베이스

1. [neon.tech](https://neon.tech) 에서 프로젝트를 만듭니다. Region은
   **AWS US West 2 (Oregon)** 이 가장 가깝습니다.
2. 프로젝트 대시보드 → **Connect** → **Connection pooling** 켜기 → 문자열 복사.
   호스트에 `-pooler` 가 들어 있으면 맞습니다.

```bash
cp .env.example .env.local
# DATABASE_URL 을 붙여넣고, ADMIN_SESSION_SECRET 을 생성해서 채웁니다
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
git check-ignore .env.local     # ".env.local" 이 출력되면 git에 안 올라갑니다
```

```bash
npm install
npm run db:migrate      # 스키마 + 기본 설정 (여러 번 실행해도 안전)
npm run db:seed         # 위 + 데모 학생 7명 (원하면)
```

마이그레이션이 관리자 코드를 **`1234`** 로 설정합니다. 세팅 화면에서 바로 바꾸세요.

### 3-2. 배포 — Vercel / Cloudflare

아래는 Vercel 기준입니다. **Cloudflare Workers 무료도 충분히 가능하고, 교회
입장에서는 오히려 더 안전합니다** — 자세한 비교는 [9장](#9-호스팅-선택-vercel-vs-cloudflare)에.

#### Vercel

```bash
npx vercel link
npx vercel env add DATABASE_URL production
npx vercel env add ADMIN_SESSION_SECRET production
npx vercel --prod
```

`vercel env` 는 Preview / Development 환경에도 각각 넣어두면 편합니다.

### 3-3. 프린터 (QL-820NWBc)

QL-820NWBc 는 QL-820NWB 의 후속 리비전입니다. Brother는 두 모델을 한 제품
(QL-820NWB/820NWBc)으로 묶어 지원하며 래스터 커맨드 레퍼런스도 같은 문서를
쓰므로, 이 앱은 둘 중 어느 쪽이든 그대로 동작합니다.

1. 프린터 본체에서 **[메뉴] → [WLAN] 또는 [유선 LAN] → [IP 주소]** 를 확인합니다.
   고정 IP나 DHCP 예약을 걸어두는 것을 강력히 권합니다 — IP가 바뀌면 인쇄가 멈춥니다.
2. 62 mm 연속 용지(DK-2205)를 넣습니다.
3. 이 IP를 라즈베리파이 브릿지의 `config.json` 에 넣습니다 (다음 절).

> 62 mm 이외 폭(54/50/38/29 mm)도 선택할 수 있습니다.
> QL-800/810W 도 같은 래스터 프로토콜이라 동작하지만, QL-800은 USB 전용이라
> USB-이더넷 프린트 서버가 별도로 필요합니다.

### 3-4. 라즈베리파이 프린트 브릿지

[bridge/README.md](bridge/README.md) 를 따라 설치합니다. 요약하면:

1. 파이에 고정 IP를 주고 Node 20 설치
2. `bridge/` 폴더를 파이에 복사
3. HTTPS 인증서 — 교회 도메인 + Let's Encrypt, 또는 `make-cert.sh` + 아이패드에 CA 설치
4. `config.json` 에 프린터 IP와 브릿지 키
5. systemd 서비스로 등록
6. 앱 세팅 → 프린터 탭에 **브릿지 주소**와 **브릿지 키** 입력 → 테스트 인쇄

### 3-5. 아이패드

1. Safari로 배포된 주소를 엽니다 (**HTTPS 필수** — PWA 설치 조건입니다).
   아이패드가 **브릿지와 같은 와이파이**에 있어야 인쇄됩니다.
2. 공유 버튼 → **홈 화면에 추가**.
3. 홈 화면 아이콘으로 실행하면 주소창 없는 전체화면으로 열립니다.
4. 권장 설정: **설정 → 디스플레이 및 밝기 → 자동 잠금 → 안 함**,
   **설정 → 손쉬운 사용 → 유도 접근** 을 켜면 아이들이 앱을 벗어나지 못합니다.

앱은 Safari 16.4 이상에서 Screen Wake Lock을 요청하므로 화면이 잘 꺼지지 않지만,
자동 잠금 해제가 더 확실합니다.

---

## 4. 라벨

62 mm 연속 용지에 기본 90 mm 길이로 인쇄됩니다.

```
┌──────────────────────────────────────────────┐
│  한서준                          ┌─────────┐ │
│                                  │ PICKUP  │ │
│  Seojun Han                      │  H7KM   │ │
│                                  └─────────┘ │
│  4th · 1부 예배                              │
│  Sep 8, 9:32 AM                              │
└──────────────────────────────────────────────┘
```

- 이름은 칸에 맞게 자동으로 크기가 줄어듭니다. 긴 이름도 잘리지 않습니다.
- 한글 이름이 없는 학생은 영어 이름이 큰 글씨로 올라갑니다.
- **픽업 보안코드**는 4자리이며, 헷갈리는 문자(`0/O`, `1/I/L`, `2/Z`, `5/S`, `8/B`)를
  뺀 알파벳을 씁니다. 하원 시 봉사자가 소리 내어 읽어도 부모와 어긋나지 않습니다.
- 같은 학생을 같은 회차에 다시 체크인하면 **기존 기록을 재사용하고 같은 코드로
  다시 인쇄**합니다. 부모가 든 태그와 코드가 항상 일치합니다.
- 세팅 → 프린터에서 항목 표시 여부, 이름 크기, 라벨 길이, 장수를 조절할 수 있습니다.
  **장수를 2로 두면 같은 라벨이 두 장 나와 보호자 픽업용 태그로 쓸 수 있습니다.**
- 라벨이 거꾸로 나오면 **180° 회전** 을 켜세요.

---

## 5. 세팅 화면

톱니바퀴 → 코드 입력. 관리자 세션은 30분 후 자동 만료됩니다.

- **오늘** — 오늘 체크인 명단, 현재 있는 인원, 학년별 인원, 체크아웃 처리, 체크인 삭제.
  날짜를 바꿔 지난 주도 볼 수 있습니다.
- **학생 명단** — 이름/전화/바코드 검색, 학년 필터, 정보 수정, 비활성화 및 완전 삭제.
  비활성화(기본)는 출석 기록을 남기고 검색에서만 감춥니다.
- **프린터** — 브릿지 주소/키, 브릿지·프린터 실시간 상태(들어 있는 용지 폭 포함,
  설정과 다르면 경고), 용지 폭, 라벨 길이, 장수, 임계값, 커팅, 180° 회전,
  라벨 내용 토글, **실시간 미리보기**, **테스트 인쇄**.
- **통계** — 기간별 세션 인원 막대그래프, 학년별/회차별 집계, 학생별 출석 횟수와
  마지막 출석일(미참석 학생 포함).
- **일반** — 화면 제목, 장소 이름, 시간대, 체크인 후 대기 시간, 학년 목록,
  예배 회차, 관리자 코드 변경.

---

## 6. 개발

```bash
npm run dev          # http://localhost:4900
npm run build
npm test             # 래스터 + 라벨 비트 패킹 (22개)
```

로컬 포트는 **4900** 으로 고정해 두었습니다 (`package.json` 의 `dev` / `start`).
3000 · 5000 · 5001 · 8000 은 다른 프로젝트와 부딪히므로 쓰지 않습니다. 개발용
Neon 프록시는 **54320**, 테스트용 가짜 프린터는 **19100 · 19110**, 테스트용 브릿지는
**19443 · 19444** 를 씁니다. 실제 브릿지는 파이에서 **9443** 입니다.

### 로컬 Postgres로 개발하기

앱은 Neon의 **HTTP** 드라이버를 쓰므로 평문 Postgres와 직접 통신할 수 없습니다.
`scripts/neon-http-proxy.mjs` 가 그 프로토콜을 일반 libpq 쿼리로 번역해 줍니다.

```bash
# 1) 일회용 Postgres
docker run -d --name starlight-pg \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=starlight \
  -p 55432:5432 postgres:16-alpine

# 2) 스키마
DATABASE_URL="postgresql://postgres:dev@localhost:55432/starlight?sslmode=disable" \
  npm run db:seed

# 3) HTTP 프록시 (별도 터미널)
PROXY_DATABASE_URL="postgresql://postgres:dev@localhost:55432/starlight" npm run db:proxy

# 4) 앱 (별도 터미널)
DATABASE_URL="postgresql://postgres:dev@ep-local-pooler.aws.neon.tech/starlight?sslmode=require" \
NEON_FETCH_ENDPOINT="http://localhost:54320/sql" \
ADMIN_SESSION_SECRET="dev-admin-secret-for-local-testing" \
  npm run dev
```

`NEON_FETCH_ENDPOINT` 는 `NODE_ENV=production` 에서 무시됩니다.

**브릿지까지 로컬에서:** 인증서 없이 실행하면 HTTP로 뜹니다. `http://localhost:4900`
에서 연 앱은 HTTP 브릿지를 호출할 수 있으므로, 세팅에 `http://<이 PC IP>:9443` 을
넣으면 실제 프린터로 개발할 수 있습니다.

```bash
PRINTER_HOST=192.168.1.50 BRIDGE_KEY=dev npm run bridge
```

### 테스트

| 명령 | 내용 |
|---|---|
| `npm test` | Brother 래스터 커맨드 조립, PackBits, 라벨 비트 패킹 (22) |
| `node tests/bridge.test.mjs` | 실제 브릿지 프로세스 + 가짜 프린터. HTTPS·CORS·동시 인쇄·용지 없음 (18) |
| `npm run test:sql` | 라우트가 실제로 쓰는 SQL을 진짜 Postgres에 실행 (20) |
| `node tests/e2e.test.mjs` | 앱 API → 아이패드와 같은 코드로 작업 조립 → 브릿지 → 가짜 프린터 (29) |

```bash
# 브릿지 (DB·앱 없이 단독)
npm test && node tests/bridge.test.mjs

# SQL
DATABASE_URL="postgresql://postgres:dev@localhost:55432/starlight?sslmode=disable" \
  npm run test:sql

# e2e (위 4단계가 떠 있는 상태에서)
npm test && node tests/e2e.test.mjs
```

브릿지 테스트는 `make-cert.sh` 로 실제 인증서를 발급해 HTTPS 모드도 검증하고,
CA를 신뢰하지 않는 클라이언트는 거절되는지(TLS가 실제로 걸려 있는지)까지 봅니다.
두 요청을 동시에 보내 프린터에 두 작업이 섞이지 않고 한 장씩 도착하는지도 확인합니다.

---

## 7. 프로젝트 구조

```
src/
  app/
    page.tsx                  기본 검색 화면
    checkin/[id]/page.tsx     체크인 + 확인 화면 + 자동 인쇄
    new/page.tsx              새 학생 등록
    settings/page.tsx         세팅 (서버측 세션 게이트)
    manifest.ts               PWA 매니페스트
    api/
      students/search         실시간 검색 (오늘 체크인 여부 포함)
      students, students/[id] 등록 / 조회 / 수정 / 삭제
      checkins, checkins/[id] 체크인, 체크아웃, 삭제
      checkins/today          오늘 현황
      stats                   출석 통계
      services                예배 회차
      settings                설정 (공개 GET / 관리자 PATCH)
      admin/auth              관리자 코드 → 세션 쿠키
  components/
    AppShell.tsx              항상 보이는 헤더·푸터, 프린터 상태
    AdminCodeDialog.tsx       톱니바퀴 코드 키패드
    app-context.tsx           설정 컨텍스트 (DB 장애 시 기본값)
    settings/                 세팅 화면 패널들 + 차트
  lib/
    label.ts                  Canvas 라벨 렌더링 → 래스터 (브라우저)
    brother.ts                Brother QL 커맨드 스트림 조립 (브라우저에서 실행)
    raster.ts                 PackBits, 비트 패킹, 용지 기하
    print-client.ts           작업 조립 → 브릿지로 전송, 브릿지 상태 조회
    use-visible-polling.ts    화면이 꺼지면 멈추는 폴링 훅
    codes.ts                  픽업 보안코드
    messages.ts               랜덤 축하 메시지
    admin.ts                  코드 해시(scrypt) + 서명 세션 쿠키
db/schema.sql                 전체 스키마 (멱등)
bridge/
  bridge.mjs                  라즈베리파이 프린트 브릿지 (HTTPS → TCP 9100)
  make-cert.sh                도메인 없을 때 쓰는 자체 인증서 발급
  starlight-bridge.service    systemd 서비스
  README.md                   파이 설치 안내
scripts/
  migrate.mjs                 스키마 적용 + 기본값
  gen-icons.mjs               PWA 아이콘 생성 (PNG 인코더 직접 구현)
  neon-http-proxy.mjs         로컬 개발용 Neon HTTP 프록시
tests/                        래스터 / 라벨 / 브릿지 / SQL / e2e
```

---

## 8. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 프린터 아이콘이 **빨강** | 브릿지나 프린터에 연결이 안 됩니다. 아이콘에 손가락을 대면 이유가 뜹니다. 파이 전원, `journalctl -u starlight-bridge -f`, 아이패드가 같은 와이파이인지 확인 |
| `프린트 브릿지에 연결할 수 없습니다` | 파이가 꺼졌거나, 다른 네트워크이거나, **아이패드가 인증서를 신뢰하지 않는** 경우입니다. 아이패드 Safari로 브릿지 주소를 직접 열어 경고가 뜨는지 보세요 ([bridge/README.md](bridge/README.md) 4번) |
| 아이콘이 **주황** / `용지가 없습니다` | 롤을 다시 넣고 확인 화면의 **다시 인쇄** 를 누르세요. 같은 이름표가 다시 나갑니다 |
| `브릿지 키가 맞지 않습니다` | 앱 세팅의 브릿지 키와 파이 `config.json` 의 `key` 가 다릅니다 |
| 세팅에 `들어있는 용지` 가 설정과 다르다는 경고 | 프린터에 다른 폭의 롤이 들어 있습니다. 테이프 폭 설정을 맞추세요 |
| 라벨이 거꾸로 | 세팅 → 프린터 → **180° 회전** |
| 글자가 흐리거나 끊김 | **흑백 임계값** 을 올리세요 (기본 160) |
| 라벨이 너무 길거나 짧음 | **라벨 길이(mm)** 조절 |
| 한글이 □□□ 로 나옴 | 아이패드/브라우저에 한글 폰트가 없는 경우입니다. 라벨은 아이패드가 그리므로 실제 기기에서 확인하세요 |
| 세팅에 못 들어감 | 기본 코드는 `1234` 입니다. 잊었다면 `app_settings` 의 `admin_code` 행을 지우면 `1234` 로 되돌아갑니다 |
| 화면이 보라색만 뜨고 비어 있음 | `DATABASE_URL` 확인. DB가 죽어도 검색창은 떠야 하며, 그때는 상단에 경고 배너가 나옵니다 |
| 같은 아이가 두 번 체크인됨 | 정상입니다 — 기존 기록을 재사용해 같은 코드로 재인쇄만 합니다. 검색 결과에도 `오늘 체크인됨` 이 표시됩니다. 이름표를 잃어버렸을 때 다시 뽑는 방법이기도 합니다 |

---

## 9. 호스팅 선택: Vercel vs Cloudflare

아직 결정하지 않았습니다. 현재 코드는 **양쪽 모두에서 돌아가며**, README의 배포
절차만 Vercel 기준으로 써 두었습니다.

| | Cloudflare Workers 무료 | Vercel Hobby 무료 |
|---|---|---|
| 요청 한도 | 100,000 / day | 1,000,000 / month (≈33,000/day) |
| CPU | 10 ms / 요청 | 4 CPU-hrs / month |
| **상업·단체 사용** | **제한 없음** | **"non-commercial, personal use only"** |
| 이 앱의 예상 사용량 | 주일 약 3,500 → **한도의 4%** | 월 약 15,000 → **한도의 2% 미만** |

인쇄가 LAN 안에서 브릿지로 바로 가고 폴링하는 곳이 없어서, 서버 요청은 실제
체크인·검색·등록할 때만 생깁니다. 수치상으로는 둘 다 넉넉합니다. 갈리는 지점은 약관입니다 — Vercel은
[fair use 가이드라인](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)
에서 Hobby 플랜을 비상업·개인 용도로 제한한다고 명시하고 있어, 교회 사역 도구는
회색지대입니다. 비영리라도 단체 운영이면 안전하지 않습니다. Cloudflare 무료
플랜에는 그런 제한이 없습니다.

**Cloudflare로 옮길 때 필요한 작업** (전부 하루 안에 끝나는 분량):

1. `@opennextjs/cloudflare` 어댑터 + `wrangler.jsonc` 추가
   (`nodejs_compat` 플래그 필요, ISR 캐시는 이 앱이 전부 `force-dynamic` 이라 불필요)
2. **`src/lib/admin.ts` 의 해싱 교체** — `scryptSync` 가 39 ms 로,
   무료 플랜의 10 ms CPU 한도를 넘습니다. 관리자 코드는 키오스크에서 입력하는
   짧은 숫자 PIN이라 scrypt가 사실상 아무 것도 못 막습니다(1만 가지 조합).
   환경변수를 키로 쓰는 HMAC-SHA-256(0.014 ms)이 이 위협 모델에는 더 맞고,
   DB가 새더라도 pepper 없이는 대입이 안 되므로 오히려 낫습니다.
3. Neon은 그대로 둡니다 — `@neondatabase/serverless` 는 HTTP 드라이버라
   Workers에서 그대로 동작합니다. Hyperdrive 같은 것도 필요 없습니다.

나머지는 손댈 게 없습니다. `src/` 에서 쓰는 Node 전용 API는 `node:crypto` 뿐이고
(`createHmac` · `randomBytes` · `timingSafeEqual`), 전부 `nodejs_compat` 에서
지원됩니다. `fs` · `net` · `child_process` 는 배포되지 않는 스크립트와 라즈베리파이
브릿지에만 있습니다.

---

## 10. 알려진 제약

- **Node 18 + Next.js 15.5.25** 로 고정되어 있습니다. Next 16은 Node 20 이상을
  요구하므로, 개발 머신을 Node 20으로 올린 뒤 함께 올리는 것을 권합니다.
  `npm audit` 이 Next가 번들한 postcss 관련 경고를 하나 남기는데, 빌드 시
  신뢰할 수 없는 소스맵을 처리할 때만 해당되어 이 앱의 런타임과는 무관합니다.
- 인쇄 성공 판정은 **프린터가 데이터를 받았고 사전 상태 점검에서 오류가 없었다**
  는 뜻입니다. 전송 중간에 용지가 끊기는 경우까지는 알 수 없습니다.
- 인쇄 대기열이 없습니다. 브릿지가 꺼져 있으면 그 자리에서 실패로 표시되고,
  파이를 켠 뒤 **다시 인쇄**(또는 같은 아이를 다시 체크인)로 뽑습니다. 체크인
  기록 자체는 인쇄와 상관없이 저장됩니다.
- 아이패드와 브릿지가 **같은 네트워크**에 있어야 합니다. 게스트 와이파이처럼
  기기끼리 통신을 막는(client isolation) 네트워크에서는 인쇄되지 않습니다.
- 오프라인 캐시는 앱 셸까지만입니다. `/api/` 응답은 절대 캐시하지 않습니다 —
  오래된 명단이나 오래된 체크인 응답은 에러보다 위험합니다.
- 세팅 화면은 아이패드에서도 열리지만 노트북 화면에 더 맞춰져 있습니다.
