# TelegramVideoSaver

Telegram "나에게 보내기" (Saved Messages)에 모아둔 동영상/링크를 한 번에 다운로드하고,
다운로드가 끝나면 해당 메시지를 자동으로 삭제해주는 Windows 앱입니다.

- YouTube / Instagram 등 [yt-dlp](https://github.com/yt-dlp/yt-dlp)가 지원하는 모든 사이트의 링크 다운로드
- Saved Messages를 스캔해서 링크 목록을 보여주고, 원하는 항목만 선택해서 다운로드
- 다운로드 성공 시 해당 메시지를 Saved Messages에서 자동 삭제
- 한 번 로그인하면 세션이 저장되어 다음부터는 자동 로그인
- Premiere Pro 호환 변환(선택) 등 [VideoDownloader](https://github.com/33bnm3-sudo/VideoDownloader)의 다운로드 기능 그대로 포함

## 설치 및 실행

1. 이 저장소를 다운로드/클론합니다.
2. `1_install.bat`을 실행합니다 (필요한 도구: Node.js, Rust, C++ Build Tools를 자동 설치).
3. 설치가 끝나면 `2_run.bat`을 실행합니다.
4. 처음 실행 시 yt-dlp / ffmpeg 자동 설치 화면이 나옵니다.

## Telegram 로그인 (최초 1회)

Saved Messages에 접근하려면 본인 Telegram 계정으로 로그인해야 합니다. 이를 위해
Telegram의 API 자격 증명(`api_id`, `api_hash`)이 필요합니다.

1. https://my.telegram.org/apps 접속 후 본인 Telegram 계정으로 로그인합니다.
2. "Create new application" 양식을 작성합니다 (App title, Short name은 자유롭게 입력).
3. 생성되면 `App api_id`와 `App api_hash` 값을 확인할 수 있습니다.
4. 앱 실행 후 로그인 화면에서 이 두 값을 입력합니다.
5. 전화번호 입력 → Telegram으로 전송된 인증 코드 입력 → (2단계 인증을 사용 중이라면 비밀번호 입력)
6. 로그인이 완료되면 세션이 로컬에 저장되어, 이후 앱을 재시작해도 다시 로그인할 필요가 없습니다.

> api_id/api_hash와 로그인 세션은 사용자 PC의 앱 데이터 폴더에만 저장되며, 어디로도
> 전송되지 않습니다.

## 사용법

1. "스캔" 버튼을 눌러 Saved Messages에서 링크를 찾습니다.
2. 다운로드할 항목을 체크합니다 (기본적으로 전체 선택).
3. "선택 항목 다운로드"를 누르면 큐에 추가되어 다운로드가 시작됩니다.
4. 다운로드가 완료된 항목은 Saved Messages에서 자동으로 삭제됩니다.

계정을 변경하거나 로그아웃하려면 하단의 "Telegram 로그아웃" 버튼을 사용하세요.
