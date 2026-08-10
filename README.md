# 🎮 Playtime Pact — 나와의 서약

> **자녀의 Minecraft·Roblox 게임 시간을 하나의 약속으로 관리하는 Electron 데스크탑 타이머 앱**

[![Version](https://img.shields.io/badge/version-0.60.6-blue)](#) [![Platform](https://img.shields.io/badge/platform-Windows%2011-lightgrey)](#) [![License](https://img.shields.io/badge/license-MIT-green)](#)

---

## ⚠️ Windows 설치 전 꼭 읽어주세요

현재 GitHub Release의 Windows 설치 파일은 **코드 서명(Code Signing) 인증서가 적용되지 않은 unsigned 설치본**입니다. Windows Defender SmartScreen 또는 Smart App Control이 "인식되지 않는 앱"으로 판단해 설치/실행을 막을 수 있습니다.

이 경우 아래 방법으로 설치할 수 있습니다.

1. 설치 파일 실행 후 `Windows에서 PC를 보호했습니다` 화면이 나오면 `추가 정보`를 클릭합니다.
2. `실행` 버튼을 클릭하면 설치가 계속 진행됩니다.
3. 다운로드 파일 자체가 차단된 경우 파일 우클릭 → `속성` → `차단 해제` 체크 후 다시 실행합니다.

자세한 안내는 [WINDOWS_INSTALL.md](./WINDOWS_INSTALL.md)를 확인하세요.

> 공개 CA 코드 서명 인증서 또는 Microsoft Store 배포를 사용하면 이런 경고를 줄일 수 있지만, 현재 릴리즈는 개인/소규모 프로젝트 기준의 무료 배포 방식으로 제공됩니다.

---

## 앱 이름: Playtime Pact

> *"나 자신과의 서약, 내 미래를 위해"*

**Pact**는 단순한 약속(promise)이 아닙니다. 당사자 간의 구속력 있는 엄숙한 합의 — 쉽게 깰 수 없는 서약에 가까운 단어입니다.

이 앱의 이름은 "게임 시간을 지키겠다"는 가벼운 다짐이 아니라, **자기 자신에게 하는 진지한 서약**을 담고 있습니다.

부모가 강제로 끄는 것이 아니라, 타이머가 울리기 전에 스스로 마무리하는 선택 — 그 엄숙한 서약들이 쌓여 미래의 자신을 만든다는 의미입니다.

---

## 왜 만들었나

MS Family Safety 같은 기존 자녀 보호 앱은 오류가 잦고, 자녀와의 구두 협상은 매일 반복됩니다.  
이 앱은 그 문제를 **시스템으로 해결**합니다.

- ✅ 로컬 정책과 상태를 사용하는 커스텀 타이머
- ✅ 자녀가 일반 창 닫기로 끌 수 없는 구조 (X/Alt+F4는 트레이 숨김)
- ✅ Minecraft·Roblox 실행 감지 후 타이머 자동 시작
- ✅ 시간이 끝나면 실제로 감지된 지원 게임 PID만 종료하고 결과를 재확인
- ✅ 게임을 닫아도 남은 시간을 보존하고, 재실행하면 이어서 진행
- ✅ 부모 PIN으로 타이머 조정·중지·설정·앱 완전 종료 보호
- ✅ 같은 사용자 세션의 중복 창을 차단하고 표준 자녀 계정의 자동 재실행 우회 완화
- ✅ 언인스톨러 PIN 검증 지원 (관리자/SYSTEM 사용자는 OS 권한으로 우회 가능)

---

## 스크린샷

### 메인 화면 · 설정 화면 · 관리자 화면

| 대기 화면 | 설정 화면 | 관리자 Timer |
|:-:|:-:|:-:|
| <img src="screenshots/main-screen.png" width="280"> | <img src="screenshots/settings-screen.png" width="280"> | <img src="screenshots/admin-screen.png" width="280"> |

> 산뜻한 복셀 어드벤처 테마 · 원본 블록 캐릭터 · 한눈에 보이는 남은 시간 · 한 번 탭으로 전환하는 부모 Timer/Safety 도구

### 🕹️ 타이머 오버레이 — 시간대별 색상

| 초록 (5분 초과) | 노랑 (5분 이하) |
|:-:|:-:|
| <img src="screenshots/timer-green.png" width="430"> | <img src="screenshots/timer-yellow.png" width="430"> |

| 주황 (3분 이하) | 빨강 (1분 이하) |
|:-:|:-:|
| <img src="screenshots/timer-orange.png" width="430"> | <img src="screenshots/timer-red.png" width="430"> |

> 우측 상단 코너에 반투명 오버레이로 표시 · DSEG7 전자시계 폰트

### ⚠️ 경고 팝업 + 카운트다운

| 경고 메시지 (5분 전) | 최종 카운트다운 (10초) |
|:-:|:-:|
| <img src="screenshots/timer-warning.png" width="430"> | <img src="screenshots/timer-countdown.png" width="430"> |

> 경고 시 타이머가 화면 중앙으로 이동해 메시지 표시 후 코너로 복귀 · 10초부터는 중앙 유지

---
## 기존 기능과 새 화면

| 구분 | 유지되는 동작 | 새 화면/창 동작 |
|---|---|---|
| 지원 게임 | Minecraft·Roblox 감지, 공유 쿼터, 자동 시작·차단·종료·재개 | Play 화면에서 현재 게임과 남은 시간을 한눈에 표시 |
| 부모 규칙 | 평일·주말 시간/횟수, 야간을 포함한 허용 시간, PIN 보호 저장 | Settings 한 번 탭 후 같은 PIN으로 편집 |
| 부모 실시간 제어 | 트레이 3클릭, 시간 추가·차감·중지, 재시작/PIN 관리 | Admin의 Timer·Safety를 한 번 탭해 전환 |
| 전체 화면 | 메인·설정·관리자 고정 창 | 화면 작업 영역에 맞춰 축소되는 중앙 스마트폰형 화면 |
| 게임 중 표시 | 코너 타이머, 경고, 카운트다운, 종료·실패 안내 | 스마트폰 셸 없이 작은 오버레이 유지 |
| 캐릭터 | 외부 게임 이미지 | Playtime Pact 원본 복셀 Pathfinder·Timekeeper |

## 쉬운 사용법

- **자녀:** 트레이 또는 메인 창을 열고 Play에서 현재 상태와 남은 시간을 확인합니다. 허용된 시간에 Minecraft 또는 Roblox를 실행하면 타이머가 자동 시작됩니다. 게임을 마칠 때는 작은 카운트다운과 종료 안내를 확인합니다.
- **부모 규칙:** Settings를 한 번 누르고 PIN 네 자리를 입력합니다. 야간 시간대를 포함한 규칙을 수정한 뒤 `게임 규칙 저장`을 한 번 누릅니다. 게임 시작으로 설정 화면이 가려져도 다시 Settings를 열고 PIN을 인증하면 저장하지 않은 입력 내용을 이어서 편집할 수 있습니다.
- **부모 실시간 제어:** 트레이 아이콘을 빠르게 3번 누르고 PIN을 입력합니다. Timer에서 시간을 추가·차감·중지하고 Safety에서 재시작 및 PIN 설정을 관리합니다.
- **창 동작:** 메인·설정·관리자 전체 화면은 스마트폰 물체처럼 보입니다. 게임 중 타이머·경고·종료 화면은 작은 오버레이입니다. 둥근 모서리 바깥의 투명 영역은 시각적으로만 투명하며, 실제 Windows 창은 작은 직사각형 입력 영역을 유지합니다.

---

## 주요 기능

### 🕹️ FPS 오버레이 스타일 타이머
게임 화면을 방해하지 않도록 우측 상단에 반투명으로 표시됩니다.  
DSEG7 전자시계 폰트 + 잔여 시간에 따른 색상 변화:

| 남은 시간 | 색상 |
|-----------|------|
| 5분 초과 | 🟢 초록 |
| 5분 이하 | 🟡 노랑 |
| 3분 이하 | 🟠 주황 |
| 1분 이하 | 🔴 빨강 |

### ⚠️ 단계별 경고 팝업
경고 시점이 되면 타이머가 우측 상단 → 화면 중앙으로 이동해 4초간 메시지를 표시한 뒤 원위치로 복귀합니다.

| 시점 | 동작 |
|------|------|
| 5분 전 | 중앙 이동 → `⚠️ 5분 남았어!` → 복귀 |
| 3분 전 | 중앙 이동 → `⚠️ 3분 남았어!` → 복귀 |
| 1분 전 | 중앙 이동 → `⚠️ 1분 남았어!` → 복귀 |
| 30초 전 | 중앙 이동 → `⏰ 30초 남았어!` → 복귀 |
| 10초 ~ 0초 | 중앙에서 카운트다운 유지 |
| 0초 | `지원 게임 종료 중...` → 감지된 Minecraft·Roblox 프로세스 트리 종료 및 결과 확인 |

### 🎮 Minecraft·Roblox 자동 감지 + 타이머 자동 시작
아이가 타이머 앱을 직접 실행하지 않아도, 지원 게임을 켜는 순간 자동으로 타이머가 시작됩니다.

- 3초마다 Windows 프로세스 정보를 확인해 Roblox, Minecraft Bedrock·Launcher, 주요 클라이언트와 Minecraft로 식별된 Java 프로세스를 감지
- 허용 시간대 내에서 감지되면 자동 시작 + 화면에 배너 표시
- 허용 시간 외 또는 쿼터 소진 상태에서 실행하면 감지된 지원 게임 PID만 종료
- 모든 지원 게임을 닫으면 현재 세션 잔여 시간을 저장하고 타이머를 일시정지합니다. 재실행하면 남은 시간부터 이어집니다.

### 🔒 종료 방지 + 트레이 상시 유지
일반 창 닫기와 부모의 앱 완전 종료를 분리합니다.

- X버튼 / Alt+F4 → 앱 종료 대신 트레이로 숨김
- 작업 표시줄 아이콘 없음 (`skipTaskbar: true`)
- 트레이 우클릭 메뉴에 종료 옵션 없음
- 트레이 단일 클릭 → 메인 창 표시
- 부모 PIN 인증 후 설정의 `앱과 워치독 종료`에서만 정상 종료

### 🛑 작업 관리자 종료 우회 완화
설치 시 HKLM Run과 Windows Scheduled Task를 함께 등록합니다.

- HKLM Run — 부모/자녀 계정 로그온 시 각자 세션에서 자동 실행
- `schtasks /rl HIGHEST` — 관리자 세션에서 높은 권한 자동 실행 보조
- 사용자 모드 Electron 앱이므로 관리자 권한 사용자는 작업 관리자에서 종료할 수 있습니다. 표준 자녀 계정에서는 자동 재실행/설정 보호를 강화하지만, OS 수준의 완전한 종료 방지는 별도 Windows Service가 필요합니다.
- 앱 제거 시 Scheduled Task 자동 삭제

### 🔐 앱 삭제 방지 (언인스톨러 PIN 잠금)
제어판 → 앱 추가/제거에서 삭제를 시도하면 부모 PIN을 먼저 요구합니다.

- 언인스톨러 시작 직전(`un.onInit`)에 PIN 입력 다이얼로그 표시
- 틀린 PIN 또는 취소 시 파일 삭제 없이 완전 차단
- 언인스톨러는 `%ProgramData%\PlaytimePact\Admin\admin-secret.json`의 보호된 PIN 해시로 검증합니다.
- 초기 언인스톨 PIN: `0000`

### 🔄 재부팅 후 타이머 복원
부모/자녀 Windows 계정이 같은 `%ProgramData%\PlaytimePact\Data` 상태를 공유해 재시작 후 남은 시간을 복원합니다.

- 타이머 시작 시 `%ProgramData%\PlaytimePact\Data\timer-state.json`에 상태 저장을 시도
- 재시작 후 당일 유효한 타이머 상태가 있고 지원 게임이 실행 중이면 남은 시간부터 자동 재개
- watchdog이 앱을 되살렸더라도 지원 게임이 꺼져 있으면 타이머를 흐르게 하지 않고 남은 시간을 일시정지 상태로 보존
- 자정 이후(날짜 변경) 또는 관리자 설정에서 비활성화 시 무효화
- `Data\`는 표준 계정에서도 세션/잔여시간 기록을 남길 수 있도록 쓰기 가능해야 합니다. 이 파일까지 변조 방지하려면 Windows Service/SYSTEM 보조가 필요합니다.

### 🛡️ 관리자 PIN 패널 (트레이 3클릭)
부모만 접근할 수 있는 비밀 관리자 패널입니다.

**접근 방법**: 트레이 아이콘을 1.5초 이내에 **3번 클릭**

**기능**:
| 기능 | 설명 |
|------|------|
| 타이머 시간 조정 | 실행 중인 타이머에 +5분 단위 추가/차감, 직접 입력으로 원하는 분 조정 |
| 타이머 중지 | 관리자 권한으로 즉시 중지 |
| 재부팅 복원 토글 | 쓰기 권한이 있는 환경에서 재시작 후 타이머 유지 여부 ON/OFF |
| 비밀번호 변경 | 현재 비밀번호 확인 후 새 비밀번호로 변경 |

- 초기 비밀번호: `0000`
- 5회 오입력 시 30초 잠금
- 숫자 패드 클릭 + 물리 키보드(0–9 / Backspace / Enter) 모두 지원
- 실행 중 타이머는 `+5/+10/+15/+30/+60분`, `-5/-10/-15/-30/-60분`, 직접 입력(예: `25`, `-10`)으로 조정 가능

### ⚙️ 설정 화면
- 평일 / 주말 허용 시간: **`XX분 × X회`** 형식으로 세션당 시간과 하루 횟수를 별도 설정
- 우측에 합계 분 실시간 표시 (예: 60분 × 2회 = 합계 120분)
- 게임 시작 가능 시각 / 종료 시각 설정
- 설정 저장 (`%ProgramData%\PlaytimePact\settings.json`)
- PIN 인증은 앱 UI에서 설정 변경을 제한합니다. 현재 표준계정 저장 요구 때문에 `%ProgramData%\PlaytimePact` 데이터 영역은 제한적인 쓰기 권한이 필요하므로, 직접 파일 변조까지 완전히 막으려면 Windows Service/SYSTEM 보조 프로세스가 필요합니다.

### 📅 데일리 세션 쿼터 관리
하루 허용 세션이 소진되면 Minecraft·Roblox 재실행이 차단됩니다.

- 타이머 만료 또는 허용 시간 종료 시 세션 1회 카운트 증가
- 모든 지원 게임을 닫으면 잔여 시간 저장 → 재실행 시 이어서 재개
- 허용 횟수를 모두 사용한 뒤 지원 게임을 실행하면 감지된 PID를 종료하고 결과를 확인
- 자정이 지나면 당일 기록 리셋, 새 날 자동 적용
- 메인 화면에 `X/X회 완료` 세션 진행 현황 표시

---

### ✅ v0.60.6 보안/호환성 점검 요약
Electron 런타임과 빌드 체인을 최신 보안 패치 계열로 올리고, 표준 사용자/관리자 계정 설치 흐름을 다시 검증한 릴리즈입니다.

- Electron `42.3.0`, electron-builder `26.8.1`, electron-vite `5.0.0`, Vite `7.3.5` 계열로 업그레이드했습니다.
- 런타임 `uuid` 의존성을 제거하고 Node 내장 `crypto.randomUUID()`로 세션 ID를 생성합니다.
- `npm audit` 기준 취약점 0건 상태로 정리했습니다.
- daily-usage 복구 정보를 저장하다 실패해도 UI 조회가 깨지지 않도록 방어했습니다.
- 메인 화면 버전 표시는 `package.json` 버전에서 빌드 시 자동 주입되도록 바꿨습니다.
- `npm run package:win`으로 Electron Builder 26 기반 NSIS 설치본 생성을 검증했습니다.

### ✅ v0.60.5 핫픽스 요약
부팅 자동 실행과 당일 세션 소진 복구 문제를 정리한 핫픽스입니다.

- 패키징된 앱이 플래그 없이 실행되어도 기본적으로 메인 화면을 띄우지 않고 시스템 트레이에만 남도록 시작 정책을 보강했습니다.
- watchdog/자동실행 플래그가 누락된 기존 설치 환경에서도 부팅 직후 메인 화면이 뜨는 경로를 줄였습니다.
- `daily-usage.json`이 없거나 오래된 상태여도 `sessions.json` 완료 기록을 함께 사용해 당일 완료 횟수를 복구합니다.
- 평일 60분 × 2회처럼 하루 세션을 모두 사용한 뒤 재부팅해도 3회차 실행이 가능해질 수 있는 경로를 차단했습니다.
- GitHub Actions Windows 빌드 워크플로우를 제거하고, 릴리즈 설치 파일은 로컬 검증 후 GitHub Release에 직접 첨부합니다.

### ✅ v0.60.0 안정화 요약
최초 코드리뷰에서 지적했던 핵심 런타임 우회 경로와 이후 실기기 테스트에서 발견된 시작/트레이 문제를 정리한 안정화 릴리즈입니다.

- 기본 PIN `0000`의 기본 해시를 전체 SHA-256 값으로 고정하고 회귀 테스트를 추가했습니다.
- 앱 시작 시 Roblox가 이미 실행 중이어도 허용 시간/세션 쿼터/부모 승인 정책을 반드시 검사합니다.
- 타이머 실행 중에도 허용 시간 종료를 계속 검사해 종료 시각이 지나면 Roblox를 강제 종료합니다.
- Roblox 프로세스가 사라지면 타이머를 즉시 일시정지하고 남은 시간을 보존합니다.
- Roblox가 실행 중이 아닌 패키지 앱에서는 타이머 시작을 차단합니다.
- 부모 PIN 승인으로 차단된 Roblox 실행은 승인 성공 후 원래 실행 커맨드로 다시 시작합니다.
- 트레이 아이콘 로딩 실패 시 앱이 죽지 않도록 다중 icon 후보와 내장 fallback을 적용했습니다.
- `--start-hidden` 자동실행과 수동 실행을 구분해, 수동 실행 시에는 메인 창이 정상 표시되도록 수정했습니다.
- Windows installer GitHub Actions에서 테스트/typecheck/build와 실제 NSIS 설치본 artifact 생성을 검증합니다.

### 🧭 추가 개선 필요 사항
아래 항목은 현재 실사용을 막는 긴급 버그는 아니며, 아이가 고급 우회까지 시도하는 단계나 장기 유지보수 단계에서 처리할 후속 과제입니다.

1. **Data JSON 직접 변조 방지**
   - 현재 `%ProgramData%\PlaytimePact\Data`는 부모/자녀 계정이 같은 타이머 상태를 공유하기 위해 표준 사용자 쓰기가 필요합니다.
   - `daily-usage.json`, `timer-state.json`, `sessions.json`의 값 검증은 하지만, 파일 삭제/직접 편집까지 완전히 막지는 않습니다.
   - 강한 방지가 필요해지면 Windows Service/SYSTEM 보조 프로세스가 실제 감시자 역할을 맡는 구조로 확장합니다.

2. **PIN 보안 하드닝**
   - 현재는 4자리 PIN + PBKDF2-SHA256(1,500,000회) 검증자를 사용합니다.
   - 추후 6자리 이상 PIN, 기본 PIN 강제 변경, 앱 재시작 후에도 유지되는 실패 횟수 제한을 적용할 수 있습니다.

3. **시작/감시 로그 강화**
   - watchdog, 자동실행, 지원 게임 차단/재실행 이벤트를 `%ProgramData%\PlaytimePact\Logs`에 남기면 다음 실기기 장애 분석 시간이 줄어듭니다.

4. **main process 구조 분리**
   - 현재 `main.ts`는 안정화 과정에서 책임이 많아졌습니다.
   - 기능 추가 전에 `managedGameRuntime.ts`, `timerEngine.ts`, `policyEngine.ts`, `tray.ts`, `watchdog.ts`로 점진 분리하면 테스트성과 유지보수성이 좋아집니다.

---

## 기술 스펙

| 항목 | 내용 |
|------|------|
| **런타임** | Electron 42.3.0 |
| **UI 프레임워크** | React 18 + TypeScript |
| **빌드 도구** | electron-vite |
| **스타일링** | Tailwind CSS |
| **폰트** | DSEG7 Classic (타이머), 로컬 시스템 한글 폰트 스택 (화면) |
| **패키지 매니저** | npm |
| **배포 타겟** | Windows 11 (NSIS 인스톨러) |
| **데이터 저장** | 공용 로컬 JSON 파일 (`%ProgramData%\PlaytimePact\`, 런타임 상태는 `Data\`) |
| **프로세스 제어** | Node.js `child_process` (taskkill, schtasks) |
| **보안** | PBKDF2-SHA256 PIN 검증, main-process 관리자 세션, NSIS 언인스톨러 PIN 잠금, HIGHEST Scheduled Task 보조 |

---

## 데이터 저장 위치

모든 데이터는 `%ProgramData%\PlaytimePact\` 에 저장됩니다. 부모 관리자 계정과 자녀 표준 계정이 같은 설정과 상태를 공유합니다. PIN 검증자는 별도 `Admin\` 폴더에 저장하지만, 표준계정에서도 PIN 인증 후 설정/상태를 저장해야 하므로 현재 구조만으로 파일 직접 변조를 완전히 차단할 수는 없습니다. 설정과 런타임 상태까지 표준 사용자 직접 변조를 막으려면 Windows Service/SYSTEM 보조 프로세스가 필요합니다. 기존 `%ProgramData%\MyPact\` 데이터는 공용 저장소가 비어 있을 때 마이그레이션 대상이 됩니다.

```
%ProgramData%\PlaytimePact\
├── settings.json       # 허용 시간, 시간대, 재부팅 복원 옵션
├── settings.json.bak   # 설정 저장 실패 대비 자동 백업
├── Admin\
│   └── admin-secret.json  # 관리자 PIN 검증자 (관리자/SYSTEM 쓰기, 표준 사용자 읽기)
└── Data\
    ├── sessions.json       # 게임 세션 기록 (부모/자녀 계정 공유 쓰기)
    ├── timer-state.json    # 재부팅 복원용 타이머 상태 (부모/자녀 계정 공유 쓰기)
    └── daily-usage.json    # 당일 세션 쿼터와 잔여 시간 (부모/자녀 계정 공유 쓰기)
```

관리자 PIN 원문은 레지스트리에 저장하지 않습니다. 언인스톨러도 보호된 `admin-secret.json`의 해시와 입력 PIN의 SHA-256 해시를 비교합니다.

---

## 프로젝트 구조

```
playtime-pact/
├── CHANGELOG.md              # 버전별 변경 이력
├── README.md                 # 이 파일
├── PROJECT_STATUS.md         # 현재 상태와 완성 계획
├── android-parent/           # Android 부모 승인 앱
├── build/
│   └── installer.nsh         # NSIS 커스텀 매크로 (Scheduled Task, PIN 잠금)
├── proofs/remote-approval/   # 원격 승인 회귀 테스트 자산
├── remote-backend/           # 원격 승인 Worker/D1 백엔드
├── screenshots/              # README 스크린샷
├── resources/
│   ├── icon.ico              # Windows 앱 아이콘
│   ├── icon-256.png          # macOS 앱 아이콘
│   └── tray-icon.png         # 트레이 아이콘
└── src/
    ├── main/
    │   ├── main.ts           # 메인 프로세스 (트레이, 타이머, 창 관리)
    │   ├── ipc.ts            # IPC 핸들러 (설정, 세션, 관리자)
    │   └── fileStore.ts      # 로컬 JSON 파일 I/O
    ├── preload/
    │   └── index.ts          # Preload 스크립트
    └── renderer/src/
        ├── App.tsx           # 라우팅 (일반 / 관리자 창)
        ├── index.css         # 글로벌 스타일
        ├── env.d.ts          # window.api 타입 선언
        └── pages/
            ├── Timer.tsx      # 메인 타이머 + 오버레이
            ├── Settings.tsx   # 설정 화면
            └── AdminPanel.tsx # 관리자 PIN 패널
```

---

## 설치 및 실행

### 요구사항
- Node.js 18+

### 개발 모드 실행

```bash
npm ci
npm run dev
```

### Windows 배포 빌드

> **빌드 전 반드시 확인 후 진행**  
> 기존 설치본 또는 이전 `dist\win-unpacked` 앱이 실행 중이면 `app.asar` 잠금으로 패키징 삭제 단계가 실패할 수 있습니다. 먼저 실행 중인 `Playtime Pact` 및 구버전 `My Pact` 프로세스를 종료하거나 제거하세요.

GitHub Release에 올리는 unsigned 설치본을 만들 때는 아래 명령을 사용합니다.

```bash
npm run package:win:unsigned
```

코드 서명 인증서가 준비된 정식 signed 설치본은 아래 명령으로 생성합니다. 인증서 설정이 없으면 실패합니다.

```bash
npm run package:win
```

빌드 결과물: `dist/` (`.exe` NSIS 인스톨러)

새 GitHub 저장소의 Release는 내부 RC 검증이 끝난 뒤 생성합니다. unsigned 설치본에는 Windows SmartScreen 경고가 표시될 수 있으므로 [Windows 설치 안내](./WINDOWS_INSTALL.md)를 참고하세요.

Windows 11 SmartScreen/Smart App Control에서 차단될 가능성을 줄이려면 신뢰된 코드서명 인증서로 앱과 설치본을 서명해야 합니다. `npm run package:win`은 서명 설정이 없으면 실패하며, `scripts/verify-win-signature.mjs`가 설치본과 `Playtime Pact.exe`의 Authenticode 서명이 `Valid`인지 확인합니다.

지원하는 서명 방식:

```powershell
# PFX/CSC 인증서
$env:WIN_CSC_LINK = "C:\secure\certificate.pfx"
$env:WIN_CSC_KEY_PASSWORD = "..."
npm run package:win
```

```powershell
# Azure Trusted Signing
$env:AZURE_TRUSTED_SIGNING_ENDPOINT = "https://..."
$env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME = "..."
$env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME = "..."
$env:AZURE_TRUSTED_SIGNING_PUBLISHER_NAME = "..."
$env:AZURE_TENANT_ID = "..."
$env:AZURE_CLIENT_ID = "..."
$env:AZURE_CLIENT_SECRET = "..."
npm run package:win
```

---

## 버전 히스토리

| 버전 | 날짜 | 주요 변경 |
|------|------|-----------|
| **v0.60.6** | 2026-06-02 | Electron/Vite/electron-builder 보안 업그레이드, audit 0건, 런타임 uuid 제거, 버전 표시 자동화, daily-usage 조회 안정화 |
| **v0.60.5** | 2026-06-01 | 부팅 자동실행 숨김 시작 보강, 재부팅 후 당일 세션 완료 횟수 복구, GitHub Actions 워크플로우 제거 |
| **v0.60.0** | 2026-05-31 | Roblox 감지/타이머 동기화, 부모 승인 후 재실행, 트레이/자동실행/수동 실행 안정화, 최초 리뷰 후속 과제 정리 |
| **v0.50.1** | 2026-05-31 | 관리자 비밀번호 변경 실패 수정, 보호된 PIN 파일 갱신 시 UAC 승격 경로 보강 |
| **v0.50.0** | 2026-05-31 | ProgramData 저장소/관리자 세션 하드닝, watchdog 자동 재실행, Roblox 오탐 방지, 최소화 버튼 수정, 관리자 시간 추가/차감/직접입력, watchdog 재시작 시 Roblox 미실행 타이머 자동진행 방지 |
| **v0.4.0** | 2026-05-29 | 세션 횟수 설정(XX분×X회), 데일리 쿼터 관리, 경고 팝업 위치 수정, 표준계정 버그 수정 |
| **v0.3.1** | 2026-05-28 | 작업관리자 종료방지, 앱 삭제방지(PIN 잠금), HD 해상도 레이아웃 수정, 프로젝트 구조 통합 |
| **v0.3.0** | 2026-05-27 | 관리자 PIN 패널, Roblox 자동 감지, 재부팅 복원, UI 테마 전면 교체 |
| **v0.2.0** | 2025 | 강제 종료, 트레이 아이콘, NSIS 패키징, 깜빡임 수정 |
| **v0.1.0** | 2025 | 최초 구현 (타이머, 경고, 설정, 세션 기록) |

전체 변경 이력: [CHANGELOG.md](./CHANGELOG.md)

---

## 로드맵

- [x] Electron 데스크톱 타이머와 Windows 설치 구조
- [x] Android 부모 앱과 원격 승인 백엔드
- [ ] 원격 승인 P0 두 건 수정과 경쟁 조건 회귀 테스트
- [ ] 실제 Android 기기 E2E와 내부 RC 검증
- [ ] FCM·코드 서명·staging·모니터링을 포함한 운영 배포

현재 기준과 완료 조건은 [PROJECT_STATUS.md](./PROJECT_STATUS.md)를 확인하세요.

---

## 라이선스

MIT
