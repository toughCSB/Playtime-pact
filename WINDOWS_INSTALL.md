# Playtime Pact Windows 설치 안내

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

빌드 결과는 `dist/`에 생성됩니다. 새 GitHub 저장소 URL과 검증된 Release 해시는 내부 RC가 완료된 뒤 이 문서에 추가합니다.

## 정식 서명 빌드

```powershell
npm run package:win
```

이 명령은 PFX/CSC 인증서 또는 Azure Trusted Signing 설정이 없으면 실패하도록 구성되어 있습니다. 생성 후 `scripts/verify-win-signature.mjs`가 설치본과 `Playtime Pact.exe`의 Authenticode 서명을 검증합니다. 인증서나 비밀번호는 저장소에 저장하지 않습니다.
