# 라즈베리파이 프린트 브릿지

아이패드에서 **Check in** 을 누르면, 아이패드가 이름표를 그리고 Brother 인쇄
명령까지 만들어 이 브릿지로 바로 보냅니다. 브릿지는 받은 바이트를 프린터의
9100 포트로 넘기고, 프린터 상태(용지 없음, 커버 열림 등)를 아이패드에 돌려줍니다.

```
아이패드 ──HTTPS (같은 와이파이)──▶ 라즈베리파이 ──TCP 9100──▶ QL-820NWBc
```

의존성 없는 Node 스크립트 하나(`bridge.mjs`)입니다.

---

## 빠른 설치 (권장)

1. **SD카드에 OS 굽기** — PC에서 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)로
   **Raspberry Pi OS Lite (64-bit)** 를 굽습니다. 설정 화면에서 호스트 이름
   (예: `starlight-pi`), 사용자 이름/비밀번호, **SSH 켜기**를 정하면 모니터가 필요
   없습니다. 파이에 SD카드, 랜선(프린터와 같은 공유기), 전원을 꽂습니다.
2. **접속** — PC의 PowerShell에서 `ssh 사용자이름@starlight-pi.local`
   (안 되면 공유기의 연결된 기기 목록에서 IP를 찾아 `ssh 사용자이름@192.168.x.x`).
3. **한 줄 설치** — 파이에서 붙여 넣기:

   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/Bethel-Church-of-Oregon/starlight_check_in/main/bridge/install.sh)
   ```

   프린터 IP 등 몇 가지를 묻고, Node 설치 → 브릿지 설치 → 인증서 발급 →
   자동 실행 등록 → 프린터 점검까지 끝냅니다. 마지막에 **브릿지 주소**와
   **브릿지 키**가 나옵니다.
4. **앱에 입력** — 앱 세팅 → 프린터 탭에 그 두 값을 넣고 저장합니다.
5. **아이패드에 인증서 설치** — 아이패드 Safari에서 `https://<파이IP>:9443/ca.crt` 를
   열어 설치하고 신뢰를 켭니다. 설치 스크립트가 마지막에 화면 단계를 그대로
   안내합니다. 아이패드마다 한 번만 하면 됩니다.
6. 파이 IP를 공유기에서 **고정(DHCP 예약)** 합니다.

같은 명령을 다시 실행하면 설정·키·인증서는 그대로 두고 브릿지만 최신으로
업데이트합니다. 프린터 IP가 바뀌었을 때도 다시 실행해서 새 IP만 입력하면 됩니다
(키는 바뀌지 않으므로 앱은 손댈 필요 없음).

아래는 스크립트가 하는 일을 손으로 하는 방법입니다. 교회 도메인으로 Let's
Encrypt 인증서를 쓰려면(4-A) 스크립트에서 2번을 고른 뒤 4-A를 따라 하세요.

---

# 수동 설치


## 1. 준비물

- 라즈베리파이 3B+ 이상 (Zero 2 W도 충분)
- 운영체제: **Raspberry Pi OS Lite (64-bit)** 권장. 파이 공식 OS(데비안 기반)로
  가볍고 파이 하드웨어 지원이 가장 좋습니다. **Ubuntu Server (64-bit)** 도 그대로
  동작합니다 — 아래 명령(`apt`, `systemctl`, `certbot`)은 둘 다 같습니다. 어느 쪽이든
  **64-bit** 로 설치하세요. 최신 Node는 32-bit ARM을 지원하지 않습니다.
- 프린터와 **같은 네트워크**. 가능하면 유선 연결
- **고정 IP** — 공유기에서 파이의 DHCP 예약을 걸어 주세요. 아이패드가 이 주소로
  접속하고, 인증서에도 이 주소가 들어갑니다. 프린터도 마찬가지로 예약해 두세요.

Raspberry Pi Imager로 OS를 구울 때 설정 화면에서 **SSH 켜기**와 사용자
이름/비밀번호(필요하면 와이파이)를 정해 두면 모니터 없이 설치할 수 있습니다.
Raspberry Pi OS와 Ubuntu Server 모두 이 설정을 지원합니다.

## 2. Node 설치

Node 24 LTS를 씁니다(Node 20은 2026년 3월에 지원 종료). 브릿지는 의존성이 없어서
Node 18 이상이면 돌지만, 오래 켜 둘 장비라 지원 기간이 긴 버전이 좋습니다.

```bash
ssh <사용자>@192.168.1.60
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v24.x
```

## 3. 브릿지 복사

개발 PC(이 저장소가 있는 곳)에서:

```bash
scp -r bridge <사용자>@192.168.1.60:~/starlight-bridge
```

## 4. HTTPS 인증서 — 둘 중 하나

아이패드는 앱을 HTTPS로 받아오고, Safari는 HTTPS 페이지가 평문 `http://`
LAN 주소를 호출하는 것을 막습니다. 그래서 브릿지는 **아이패드가 신뢰하는
인증서**가 꼭 있어야 합니다.

### A. 교회 도메인이 있을 때 (권장 — 아이패드에 아무것도 설치하지 않음)

예: `print.bethelchurch.org` 를 파이의 LAN IP로 향하게 하고 Let's Encrypt
인증서를 받습니다. DNS 방식으로 인증하므로 파이를 인터넷에 열 필요가 없습니다.

1. DNS에 A 레코드 추가: `print` → `192.168.1.60` (사설 IP여도 됩니다)
2. 도메인 DNS가 Cloudflare라면 (다른 업체도 certbot 플러그인이 있습니다):

```bash
sudo apt install -y certbot python3-certbot-dns-cloudflare

# Cloudflare 대시보드 → My Profile → API Tokens → "Edit zone DNS" 템플릿
echo "dns_cloudflare_api_token = <토큰>" | sudo tee /root/cloudflare.ini
sudo chmod 600 /root/cloudflare.ini

U=<사용자>; D=print.bethelchurch.org
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/cloudflare.ini -d $D \
  --deploy-hook "install -o $U -g $U -m 600 /etc/letsencrypt/live/$D/fullchain.pem /home/$U/starlight-bridge/certs/bridge.crt && install -o $U -g $U -m 600 /etc/letsencrypt/live/$D/privkey.pem /home/$U/starlight-bridge/certs/bridge.key"
```

`mkdir -p ~/starlight-bridge/certs` 를 먼저 해 두세요. 인증서는 certbot이
자동 갱신하고, deploy-hook이 브릿지 폴더로 복사하며, 브릿지는 한 시간마다
파일을 확인해 **재시작 없이** 새 인증서를 씁니다.

앱에 넣을 브릿지 주소: `https://print.bethelchurch.org:9443`

> 이 이름이 교회 와이파이에서 열리지 않으면 공유기의 **DNS rebinding 보호**가
> 공개 도메인이 사설 IP를 가리키는 것을 막고 있는 경우입니다. 공유기 설정에서
> 해당 도메인을 예외로 추가하세요.

### B. 도메인이 없을 때 — 자체 인증서 + 아이패드에 한 번 설치

```bash
cd ~/starlight-bridge
./make-cert.sh 192.168.1.60
```

`certs/ca.crt` 를 **각 아이패드에 한 번** 설치합니다. 브릿지가 이 파일을 직접
내려주므로 PC에서 옮길 필요가 없습니다 (윈도우 PC는 AirDrop이 안 됩니다).

1. 브릿지를 실행한 상태에서 아이패드 Safari로 `https://192.168.1.60:9443/ca.crt` 열기.
   "연결이 비공개로 설정되어 있지 않습니다" → **세부사항 보기** → **이 웹 사이트 방문**
2. "구성 프로파일을 다운로드하려고 합니다" → **허용**
3. **설정 → 일반 → VPN 및 기기 관리** → 다운로드된 프로파일 → 설치
4. **설정 → 일반 → 정보 → 인증서 신뢰 설정** → "Bethel Starlight Print Bridge CA" **켜기**

4번을 빠뜨리면 설치만 되고 신뢰는 안 된 상태라 인쇄가 실패합니다. 브릿지가
내려주는 건 공개용 CA **인증서**뿐이고, 개인키(`ca.key`, `bridge.key`)는 절대
내보내지 않습니다.

앱에 넣을 브릿지 주소: `https://192.168.1.60:9443`

서버 인증서는 825일(약 2년 3개월) 동안 유효합니다(iOS가 허용하는 최대치).
만료 전에 `./make-cert.sh 192.168.1.60` 을 다시 실행하면 됩니다 — CA를 그대로
쓰므로 **아이패드에 다시 설치할 필요가 없고**, 브릿지도 자동으로 새 인증서를
불러옵니다. 만료일은 `openssl x509 -in certs/bridge.crt -noout -enddate`.

## 5. 설정

```bash
cd ~/starlight-bridge
cp config.example.json config.json
nano config.json
```

| 항목 | 값 |
|---|---|
| `printerHost` | 프린터 IP (프린터 본체 **메뉴 → WLAN/유선 LAN → IP 주소**) |
| `key` | 아무 긴 문자열. 앱 세팅의 **브릿지 키** 에 똑같이 넣습니다 |
| `allowedOrigins` | 앱 주소. 예: `["https://starlight.vercel.app"]`. 비워두면 모두 허용 |
| `certFile` / `keyFile` | 기본값(`certs/bridge.crt`, `certs/bridge.key`) 그대로 |

키 생성: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

`key` 는 앱을 여는 누구에게나 보이는 값이라 비밀번호가 아닙니다. 교회 와이파이의
다른 기기가 마음대로 인쇄하지 못하게 막는 정도의 역할입니다. 프린터 IP를 앱이
아니라 브릿지에 두는 이유도 같습니다 — 브라우저가 브릿지에게 엉뚱한 주소로
연결하라고 시킬 수 없어야 합니다.

## 6. 확인

```bash
node bridge.mjs --status
#   용지: 62 mm continuous
#   상태: 정상

node bridge.mjs          # 실행해 두고
```

**아이패드 Safari** 로 `https://<브릿지 주소>:9443` 을 엽니다.
`{"ok":true,"service":"starlight-print-bridge",...}` 가 보이면 인증서까지 끝난
것입니다. 경고 화면이 뜨면 4번(인증서)을 다시 확인하세요.

## 7. 항상 실행되게

```bash
sed -i "s/USERNAME/$USER/g" starlight-bridge.service
sudo cp starlight-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now starlight-bridge
journalctl -u starlight-bridge -f
```

## 8. 앱에 연결

앱 세팅 → **프린터** 탭에서 **브릿지 주소**와 **브릿지 키**를 넣고 저장한 뒤
**테스트 인쇄**. 화면 위쪽 상태 칸에 브릿지 연결, 프린터 상태, 들어 있는 용지
폭이 나옵니다.

---

## 브릿지 API

| 요청 | 설명 |
|---|---|
| `GET /` | 헬스 체크. 키 불필요 — Safari로 인증서 확인할 때 씀 |
| `GET /ca.crt` | 로컬 CA 인증서(공개용). 키 불필요 — 아이패드 설치용. Let's Encrypt면 404 |
| `GET /status` | 프린터 상태 (`X-Bridge-Key` 필요) |
| `POST /print` | 본문 = Brother 래스터 작업 바이트 (`X-Bridge-Key` 필요) |

`POST /print` 응답: `200` 인쇄됨 · `409` 사람이 손봐야 함(용지, 커버) ·
`502` 프린터에 연결 못 함 · `400` Brother 작업이 아님 · `401` 키 틀림.

프린터는 한 번에 한 연결만 받으므로, 아이패드 여러 대가 동시에 인쇄해도 브릿지가
한 장씩 차례로 보냅니다.
