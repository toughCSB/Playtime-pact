# Playtime Pact Windows 설치 안내

## 1.0.1 버전

저장소: https://github.com/toughCSB/Playtime-pact

Windows x64 PC에서 `Playtime Pact Setup 1.0.1.exe` 파일 하나를 실행합니다. 게임을 먼저 종료하고, 보호 서비스 설치를 위한 Windows 관리자 승인을 진행하세요. 신규 설치의 부모 PIN은 `0000`이므로 관리자 화면의 `부모 PIN 변경`에서 즉시 변경하세요. 모바일 없이 시작을 승인하려면 ‘게임 시작 전 부모님 승인 받기’를 켜고 메인 화면에서 부모 PIN으로 승인하세요.

이 버전도 Authenticode 미서명 설치본입니다. 파일 해시는 릴리스의 `SHA256SUMS.txt`와 대조하세요. 다른 PC의 신규 설치와 기존 설치 업데이트는 부모 입회하에 확인해야 합니다.

## 보호 서비스 IPC 확인 실패

이 오류는 Windows의 게시자/서명 경고와 별개입니다. 설치기는 서비스 첫 시작 후 준비 완료 확인을 최대 5번 재시도합니다. 실패하면 설치 완료로 처리하지 않고 서비스를 등록된 상태로 남겨 복구할 수 있게 합니다.

실패 정보는 `C:\ProgramData\PlaytimePact\install-health.log`에 기록됩니다. 이 로그와 설치 폴더의 `PlaytimePactPrivilegedBroker.wrapper.log`, `.err.log`를 확인하세요. 부모 PIN 또는 비밀 키 파일은 공유하지 마세요. Windows를 재시작하고 설치 파일을 다시 실행하세요.

기존 버전 업데이트 중 부모 PIN 입력창이 나타나면 기존 PIN을 직접 입력합니다. 취소하거나 틀리면 업데이트가 중단됩니다. 기존 규칙과 사용량을 초기화하지 않습니다.

## 표준 계정에서 Lunar/Minecraft Java가 차단되는 경우

별도의 AppLocker 정책으로 표준 계정의 프로그램 설치를 제한하면 Lunar Client 런처는 열려도 실제 게임용 `java.exe`/`javaw.exe`가 먼저 차단될 수 있습니다. 관리자 Windows PowerShell에서 다음 도구를 실행하면 해당 계정에 이미 설치된 Lunar/Minecraft 런타임만 병합 허용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\allow-existing-game-runtimes.ps1 -TargetUser joonw -Apply
```

서명된 런타임은 게시자·제품·파일명·주 버전으로, 서명되지 않은 런타임은 정확한 파일 해시로 제한합니다. 기존 AppLocker 정책을 교체하거나 Store·App Installer·MSI 제한을 끄지 않습니다. 런타임의 제품 또는 주 버전이 바뀐 뒤 다시 차단되면 부모 관리자로 도구를 다시 실행해야 합니다.

## SmartScreen 경고

코드 서명 인증서가 적용되지 않은 내부 테스트 설치본은 Windows Defender SmartScreen 또는 Smart App Control에서 인식되지 않는 앱으로 표시될 수 있습니다. 배포 파일의 출처와 해시를 확인한 경우에만 실행하세요.

경고 화면에 `추가 정보`가 보이면 앱 이름과 게시자를 확인한 뒤 `실행`을 선택할 수 있습니다. 조직 정책이나 Smart App Control이 실행을 차단하면 unsigned 설치본을 우회하지 말고, 서명된 빌드를 사용하거나 소스에서 직접 빌드하세요.

## 소스에서 빌드

```powershell
npm ci
npm test
npm run typecheck
npm run package:win:unsigned
```

빌드 결과는 `dist/`에 생성됩니다. [Releases](https://github.com/toughCSB/Playtime-pact/releases)에 게시된 파일은 버전과 해당 릴리스의 검증 정보를 확인하세요.

## 정식 서명 빌드

```powershell
npm run package:win
```

이 명령은 PFX/CSC 인증서 또는 Azure Trusted Signing 설정이 없으면 실패하도록 구성되어 있습니다. 생성 후 `scripts/verify-win-signature.mjs`가 설치본과 `Playtime Pact.exe`의 Authenticode 서명을 검증합니다. 인증서나 비밀번호는 저장소에 저장하지 않습니다.
