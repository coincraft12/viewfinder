## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 로컬 웹앱 + 원격 실시간 보기(WebRTC) 추가 완료 |
| 업로드 대상 | Hetzner Storage Box (WebDAV, u499532), `hetzner-upload-relay.js`가 릴레이 |
| 원격 보기 시그널링 | custody-staging(204.168.242.99)에 pm2로 상시 구동 (`/opt/viewfinder-signal`), `https://staging.coincraft.io/viewfinder-signal`(WS) + `/viewfinder/`(뷰어 페이지) + `/viewfinder-clips`, `/viewfinder-file`(저장된 클립 열람 API) |

## 마지막 작업 (2026-09-21)
- **원격 보기 연결 끊김 버그 수정** — Cloudflare가 idle WebSocket을 자동으로 끊어버려서(무통신 ~100초) 아무도 안 보고 있을 때 브로드캐스터가 DISCONNECTED로 표시되던 문제. signal-server에 30초 간격 ping/pong 추가 + 혹시 끊겨도 브로드캐스터/뷰어 양쪽 다 자동 재연결하도록 수정
- **원격 클립 열람 기능 추가** — 뷰어 페이지(`/viewfinder/`)에 저장된 클립 목록/재생 UI 추가. `signal-server`가 Storage Box(WebDAV)를 직접 읽어서 제공(`/viewfinder-clips`, `/viewfinder-file`) — PC가 꺼져 있어도 클립 열람 가능
- z_Temp 임시 작업분을 `F:\Workplace\viewfinder` 정식 레포로 이관, git 초기화 후 GitHub(`coincraft12/viewfinder`) push
- 모션 녹화 프레임 유실 버그(비동기 stop/start 경쟁 상태), 재생시간 0초 버그, 저조도(노출시간 하드웨어 제어), 해상도(640x480→1920x1080) 등 다수 버그 수정
- **원격 실시간 보기 기능 추가** — `signal-server/`(WebRTC 시그널링 릴레이, WS)를 custody-staging에 배포하고 기존 `staging.coincraft.io` Nginx vhost에 경로 추가(`/viewfinder-signal`, `/viewfinder/`), 신규 도메인/인증서 불필요
- `viewfinder.html`에 "Remote viewing" 토글 추가 — 켜면 토큰이 담긴 뷰어 링크 생성, 다른 기기(폰 등)에서 그 링크로 접속하면 P2P로 실시간 영상 수신. 영상 데이터는 시그널링 서버를 거치지 않음(SDP/ICE만 중계)
- 인증은 URL 토큰 방식(추측 불가능한 랜덤 문자열)뿐 — 링크를 아는 사람은 누구나 볼 수 있음, 개인용 수준의 최소 보안임을 UI에 명시

## 다음 작업
- [ ] Threshold/모션 감지 정확도 추가 튜닝 (사용자 실사용 피드백 대기)
- [ ] 저조도 화질(노이즈) 추가 개선 필요 시 검토
- [ ] (알려진 제약) 원격 뷰어는 야간모드/밝기 CSS 필터가 안 적용된 원본 화면을 봄 — 필요하면 recordCanvas(필터 적용된) 스트림을 보내도록 전환 검토
- [ ] 실사용 중 STUN만으로 연결 실패하는 네트워크 있으면 TURN 서버 추가 검토
