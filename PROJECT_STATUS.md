# Playtime Pact — 현재 상태와 완성 계획

> 이 문서는 2026-08-10의 계획 기록입니다. 2026-09-09 Windows 0.60.8의 기능·검증 상태·남은 제한은 [README](README.md)와 [Windows 설치 안내](WINDOWS_INSTALL.md)를 우선합니다. 저장소는 `toughCSB/Playtime-pact`로 통합했으며, 아래의 원격 미연결 방침은 과거 기록입니다.

> 기준일: 2026-08-10

## 결론

현재 저장소는 Playtime Pact의 동작하는 제품 코드 기준선입니다. Electron 데스크톱 앱, Android 부모 앱, 원격 승인 백엔드와 자동 테스트가 함께 들어 있습니다. 다만 원격 승인 경로의 정확성 문제 2건과 최신 실제 기기 검증이 남아 있으므로 아직 최종 출시본은 아닙니다.

## 보존된 제품 범위

- `src/`: Electron 메인·preload·React UI와 공유 도메인 로직
- `tests/`: 데스크톱·원격 승인·D1 회귀 테스트
- `proofs/remote-approval/`: 원격 승인 테스트가 직접 사용하는 모델·벡터·SQL
- `remote-backend/`: Cloudflare Worker/D1 원격 승인 백엔드
- `android-parent/`: Android 부모 승인 앱
- `resources/`, `build/`, `scripts/`: 실행·설치·서명 리소스
- `ops/`: 원격 승인 운영과 보안 결정 문서

`proofs/remote-approval/`은 단순 과거 산출물이 아니라 테스트 의존성이므로 유지합니다. `MyPact`라는 로컬 저장 경로와 일부 이름은 기존 설치 데이터 호환을 위한 내부 식별자이며 제품명은 Playtime Pact입니다.

## 출시 전 P0

1. 서버 시간 권위 실패 시 로컬 시각으로 우회하지 않도록 fail-closed 처리
   - 서버 시간의 유효 기간은 30초입니다.
   - 동기화 실패, 잘못된 응답, 시간 역행 시 원격 승인을 즉시 차단해야 합니다.
   - 29,999ms는 유효하고 30,000ms부터 무효인 경계 테스트가 필요합니다.

2. 사전 승인 소비와 부모 초기화의 경쟁 조건 제거
   - 승인 세대 값을 고정값으로 사용하지 않고 현재 epoch를 전달해야 합니다.
   - 승인 소비 전후의 generation 검증과 사용량 정합성 보장이 필요합니다.
   - 초기화와 실행이 동시에 발생하는 결정적 회귀 테스트가 필요합니다.

## 기준선 검증

2026-08-10에 의존성과 빌드 캐시를 삭제한 뒤 새로 설치해 확인했습니다.

- `npm test`: 181개 통과(132 Vitest + 49 backend/D1)
- `npm run typecheck`: 통과
- `npm run build`: 통과
- `npm audit --omit=dev`: 운영 의존성 취약점 0건
- Android `testDebugUnitTest lintDebug assembleDebug`: 빌드 성공, lint 오류 0건·경고 11건
- 실제 Android 기기: 연결된 기기가 없어 최신 instrumentation/E2E는 미검증

전체 개발 의존성 감사에는 중간 3건·높음 2건이 남아 있습니다. 운영 의존성에는 해당하지 않지만 RC 전에 개발 도구 체인 업그레이드 가능성을 별도로 검토합니다.

## 완성 순서

1. 위 P0 두 건 수정과 회귀 테스트 추가
2. `npm test`, `npm run typecheck`, `npm run build` 전체 통과
3. 실제 Android 기기에서 요청·승인·거절·만료·오프라인·초기화 경쟁 흐름 검증
4. unsigned 내부 RC 설치본 생성과 설치 스모크 테스트
5. FCM, 코드 서명, staging, 모니터링을 갖춘 운영 배포 트랙 진행

## 새 환경 시작

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Android와 원격 백엔드 작업은 각각 `android-parent/`, `remote-backend/`에서 진행합니다. 새 GitHub 저장소를 만든 뒤에만 새 `origin`을 추가하며, 현재 로컬 저장소에는 원격 연결을 두지 않습니다.
