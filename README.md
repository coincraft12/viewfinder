# Viewfinder

로컬 웹캠을 브라우저에서 보고, 모션이 감지되면 자동으로 녹화해서 Hetzner Storage Box에 업로드하는 개인용 웹앱.

## 구성

- `viewfinder.html` — 프론트엔드 전체 (단일 HTML 파일). 카메라 미리보기, 야간모드, 밝기 조절, 전체화면, 모션 감지·녹화, 업로드된 클립 목록/재생.
- `hetzner-upload-relay.js` — 로컬 Node 릴레이 서버(`localhost:8787`). Storage Box 계정 정보를 여기서만 들고 있고, 브라우저에는 절대 안 넘어감. `POST /upload`, `GET /clips`, `GET /file`, `POST /log` 라우트 제공.
- `viewfinder 시작.bat` — 더블클릭 한 번으로 relay 서버 실행 + `viewfinder.html` 열기. relay가 이미 떠 있으면 중복 실행 안 함.
- `.env` — 실제 Storage Box 계정 정보 (git에 커밋 안 됨, `.env.example` 참고해서 직접 생성).

## 실행 방법

1. `npm install` (최초 1회, `dotenv`만 의존)
2. `.env.example`을 `.env`로 복사하고 실제 계정 정보 채우기
3. `viewfinder 시작.bat` 더블클릭 (또는 `node hetzner-upload-relay.js` 실행 후 `viewfinder.html` 직접 열기)

## 참고

- 카메라 스트림 자체는 브라우저 탭 밖으로 절대 안 나감. 모션 녹화 클립만 로컬 relay를 거쳐 Storage Box로 업로드됨.
- 브라우저 콘솔 에러는 `reportClientError()`를 통해 relay의 `POST /log`로도 전송되어 `viewfinder-client.log`에 쌓임 (디버깅용, git에 커밋 안 됨).
