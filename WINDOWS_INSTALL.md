# Playtime Pact Windows 설치 안내

## 0.60.8 설치

저장소: https://github.com/toughCSB/Playtime-pact

Windows x64 PC에서 `Playtime Pact Setup 0.60.8.exe` 파일 하나를 실행합니다. 게임을 먼저 종료하고, 보호 서비스 설치를 위한 Windows 관리자 승인을 진행하세요. 신규 설치의 부모 PIN은 `0000`이므로 관리자 화면의 `부모 PIN 변경`에서 즉시 변경하세요. 모바일을 사용하지 않으면 모바일 승인 옵션은 끈 상태로 사용합니다.

2026-09-09에 만든 미서명 설치 후보의 SHA256은 `B05B428CC72511C72869C2C92A594FCBCE71CBCEBAE46F96067B7F316203AEDA`입니다. 재빌드한 파일은 해시가 달라질 수 있습니다. 소스 푸시와 Release 파일 업로드는 별개이며, 이 해시는 해당 후보 파일에만 적용됩니다. 다른 PC의 신규 설치는 아직 미검증입니다.

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
