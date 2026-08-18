# CLAUDE.md

이 저장소에서 작업할 때 먼저 읽는 파일입니다. 여기 적힌 제약은 전부 실제 코드에서
확인한 것이고, 근거 파일·줄 번호를 함께 적었습니다. 코드를 고치다 이 문서와 실제가
어긋나면 **이 문서도 같이 고치세요.**

---

## 1. 프로젝트 개요

로컬 전용 Express 서버 **한 개**(기본 포트 5300, `127.0.0.1` 바인딩)가 5개 크리에이터
도구를 iframe으로 서빙하는 단일 앱입니다. 외부에 배포되지 않고 사용자 PC에서만 돕니다.

용도: 시니어 대상 유튜브 플레이리스트 채널 2개(**한국 아침 플레이리스트**, **일본 쇼와
카페**)의 제작 파이프라인. 채널당 주 12곡 기준.

| 도구 | 정적 파일 | 라우터 |
|---|---|---|
| 유튜브 추출기·번역기·**자동 등록** | `tools/yt/` | `routes/yt.js` |
| 음악 타임라인 생성기 | `tools/timeline/` | `routes/timeline.js` |
| 스토리 숏츠 | `tools/shorts/` | `routes/shorts.js` |
| 스토리보드 | `tools/storyboard/` (빌드 산출물) | `routes/story.js` |
| 썸네일·커버 스튜디오 | `tools/thumbnail/` | `routes/thumbnail.js` |

현재 버전: **CS-v2.3**

---

## 2. 실행과 검증

```bash
npm start        # node server.js
npm run dev      # node --watch server.js
npm run check    # node --check server.js  ← server.js 하나만 문법 검사한다
```

`engines.node >= 20` (개발 확인은 v22 기준).

**주의: `npm run check`는 `server.js` 한 파일의 문법만 봅니다.** `routes/`, `lib/`,
`tools/`는 전혀 검사하지 않습니다. 자동 테스트는 아직 없습니다(로드맵 #10). 그래서
변경 후에는 **반드시 서버를 실제로 띄우고 해당 엔드포인트를 호출해서** 확인하세요.

첫 실행은 `start-creator-studio.bat`이 `npm install`과 스토리보드 빌드까지 자동으로
합니다(`start-creator-studio.bat:61-78`).

---

## 3. 아키텍처 제약 — 어기지 마세요

### 3.1 `tools/*/`는 빌드 스텝이 없는 정적 파일

- `tools/timeline/index.html`은 **HTML + CSS + JS가 한 파일에 들어있는 단일 파일**입니다
  (약 1,200줄, `<script>` 안 IIFE). 여기에 import·번들러·모듈 시스템을 도입하지 마세요.
  서버 없이 파일로 직접 열어도 타임라인 생성이 동작해야 한다는 것이 이 구조의 이유입니다.
- `tools/yt/app.js`만 `type="module"`입니다(`tools/yt/index.html`).
- `tools/shorts/`, `tools/thumbnail/`도 정적입니다.

### 3.2 `tools/storyboard/`는 직접 수정 금지

`storyboard-app/`(React + vite)의 **빌드 산출물**입니다. `vite.config.ts:10`의
`base: '/tools/storyboard/'` 설정으로 이 경로에 빌드됩니다. `.gitignore`에도 들어 있습니다.
고쳐야 하면 `storyboard-app/` 소스를 고치고 다시 빌드하세요.

### 3.3 `stripLeadingNumber()`는 의도적으로 두 벌 있습니다

- `routes/timeline.js:65`
- `tools/timeline/index.html:385`

정적 페이지와 서버가 모듈을 공유할 수 없어서 복제한 것입니다. **한쪽을 고치면 반드시
다른 쪽도 같이 고치세요.** 정규식 리터럴이 서로 완전히 같아야 합니다:

```js
/^\s*[\[(]?\d{1,3}[\])]?[\s._-]+/
```

(따옴표 스타일만 서버는 `'`, 클라이언트는 `"`로 다릅니다. 정규식 자체는 동일합니다.)
`normalizeForMatch()`도 같은 이유로 두 벌입니다(`routes/timeline.js:72`,
`tools/timeline/index.html:396`). 이 둘이 어긋나면 폴더의 실제 파일명과 화면의 곡 제목이
매칭되지 않아 rename이 조용히 아무 일도 안 하게 됩니다.

### 3.4 셸은 iframe을 `display` 토글로만 전환합니다

`public/shell.js:17` — 5개 iframe이 셸 로드 시 전부 한 번 로드되고, 탭 전환은 `display`만
바꿉니다. 그래서 탭을 옮겨도 입력 상태가 살아 있습니다. iframe을 매번 다시 로드하는
방식으로 바꾸지 마세요(사용자가 작업 중이던 내용이 날아갑니다).

도구 사이에 데이터를 주고받아야 하면 iframe → 셸 → iframe의 `postMessage` 중계를 쓰고,
`origin`을 반드시 검증하세요.

### 3.5 Gemini 키는 `lib/keyStore.js`를 통해서만

`lib/keyStore.js`가 키를 읽어 전 도구에 공급합니다. **키 값을 API 응답이나 로그에 절대
노출하지 마세요.** 상태 확인은 `currentKey()`/`hasPaidKey()`의 불리언 결과만 씁니다.

**CS-v1.8부터 무료/유료 두 슬롯입니다** (Gemini 과금·한도가 API 키 = Google Cloud
프로젝트 단위이기 때문— 프로젝트당 요청 한도표는 안 적습니다, 요금표처럼 바뀌니 필요하면
그때 확인하세요):

- 무료: `.gemini_key` 파일 / `GEMINI_API_KEY` 환경변수. 기존과 동일.
- 유료(선택): `.gemini_key_paid` 파일 / `GEMINI_API_KEY_PAID` 환경변수. `currentKey('paid')`가
  없으면 무료 키로 **자동 폴백**하므로, 유료 키를 넣지 않으면 지금처럼 전부 무료 키로
  동작합니다.
- **유료 슬롯을 쓰는 곳은 `routes/yt.js`의 `/translate`·`/regenerate` 딱 둘뿐**입니다. 나머지
  전부(추출, 타임라인, 숏츠 텍스트/이미지/영상, 스토리보드, 썸네일, 소셜 스튜디오)는 무료
  슬롯입니다. 새 유료 호출을 추가하고 싶으면 먼저 제안하세요 — 단가 자릿수가 다른 걸(특히
  이미지·영상 생성) 유료 슬롯에 붙이지 않습니다.
- `lib/gemini.js`의 요청 큐(`minIntervalMs`/재시도)도 슬롯별로 **독립**입니다. 두 키는 서로
  다른 프로젝트의 서로 다른 분당 한도이므로 같은 큐를 타면 안 됩니다.
- 어떤 요청이 어느 슬롯을 쓰는지는 `withRetry(fn, { tier })`/`requireGeminiClient(tier)`의
  `tier` 인자로 결정됩니다. 인자를 생략하면 항상 `'free'`— 새 호출부를 추가할 때 유료로
  보내려는 의도가 없다면 그냥 생략하면 됩니다.

> 알려진 불일치: `routes/shorts.js:165`는 `keyStore` 대신 `process.env`를 직접 읽습니다.
> 동작에는 문제가 없지만 shorts를 손볼 일이 있으면 `currentKey()`로 통일하세요.

**CS-v2.1부터 `/translate`에 `scope`(`'title'` | `'full'`, 기본값 `'title'`)가 있습니다.**
제목만 번역하면 50개 언어가 호출 1회로 끝나(설명 미전송 + 출력 스키마도 제목만 요청 —
실측 43,142 → 1,523 토큰, 96.5% 감소) 무료 한도로 충분한 경우가 많습니다. 설명까지
번역할 언어는 `tools/yt/app.js`의 "설명까지 번역할 언어" 영역에서 따로 고르고, 그
언어들만 `scope:'full'`로 별도 요청이 나갑니다. 캐시 키(`lib/ytTranslationCache.js`)에도
`scope`가 들어가 있어 `title`로 캐시된 항목이 `full` 조회에 잘못 히트하지 않습니다 —
새 caller를 추가할 때 `scope`를 빠뜨리면 캐시가 조용히 오염됩니다.

**CS-v2.2부터 모델을 화면에서 고를 수 있습니다.** `/translate`·`/regenerate`·`/extract`가
요청 본문의 `model`을 받고, 폴백 순서는 요청값 → `GEMINI_MODEL` 환경변수 →
`gemini-3.5-flash`입니다. 서버가 `resolveModel()`로 형식을 재검증합니다(영숫자·하이픈·
마침표, 64자 이내) — 형식이 틀리면 400, 폴백 대상이 아닙니다. `GET /api/yt/models`가
그 계정에서 실제로 쓸 수 있는 텍스트 모델 목록을 돌려주고(`ai.models.list()` 조회,
임베딩·이미지·TTS·비디오 계열 제외 — 필터는 이름과 description을 같이 봅니다,
"nano-banana-pro-preview"처럼 이름만으로는 안 걸러지는 이미지 모델이 실제로 있었습니다),
화면은 이 목록으로 드롭다운을 채우고 실패하면 자유 입력으로 폴백합니다. 모델이
404(사용 불가)를 반환하면 조용히 다른 모델로 갈아타지 않고 사용 가능한 목록과 함께
알립니다 — 이 원칙은 협상 대상이 아닙니다(4.2와 같은 이유: 사용자가 고른 것과 다른
모델로 돈이 나가면 안 됩니다). `skipThinkingConfigByModel`/`extractToolsModeByModel`은
모델별로 따로 기억합니다 — 계정 전역이 아니라 모델별 속성이라 프로세스 전역 플래그
하나로는 부정확합니다.

---

## 4. 외부에 쓰는 기능의 안전 규칙

이 앱은 사용자의 **실제 파일**과 **실제 유튜브 채널**에 씁니다. 아래 패턴은 협상 대상이
아닙니다.

### 4.1 미리보기 → 적용 2단계

새로 만드는 쓰기 기능도 전부 이 형태여야 합니다. **미리보기 없이 바로 실행되는 경로를
만들지 마세요.**

- 적용은 **미리본 계획 그대로만** 전송합니다. 적용 시점에 계획을 다시 계산하지 않습니다
  (`tools/timeline/index.html:361`의 `currentRenamePlan`, `tools/yt/app.js`의
  `publishState.plan`).
- 목록·순서·대상이 바뀌면 이전 미리보기를 무효화하고 다시 스캔하게 합니다.

### 4.2 파일명 변경 (`routes/timeline.js`)

`fs.rename`을 호출하는 곳은 `/apply-rename` 하나뿐이고, 클라이언트 미리보기를 신뢰하지
않고 서버가 전부 재검증합니다: 확장자 화이트리스트(`.wav`/`.mp3`), 원본 존재 확인,
멱등 스킵, 이름 충돌 감지, 시스템 폴더 차단, 자기 자신 폴더 차단(`assertSafeFolder()`).
실행 직전 폴더에 `_rename_backup.json`을 남겨 `undo-rename`으로 1단계 되돌립니다.
**이 검증을 "클라이언트가 이미 확인했으니"라는 이유로 건너뛰지 마세요.**

한 항목이 실패해도 나머지 배치는 계속 진행하고, 실패 사유를 항목별로 보고합니다.
새 배치 기능도 이 패턴을 따르세요.

### 4.3 `videos.update`는 part를 통째로 교체합니다

값이 있는 속성을 빼고 보내면 **그 값이 삭제됩니다.** 그래서 등록 경로는 항상
read-modify-write입니다 (`routes/yt.js`의 `/publish-localizations`):

```
videos.list(part=snippet,localizations)
  → 기존 title/description/categoryId/tags/localizations 보존
  → 새 localizations 병합
  → PUT videos(part=snippet,localizations)
```

**이 패턴을 절대 단순화하지 마세요.** 영상 제목과 설명이 통째로 날아갑니다.
`playlists.update`도 같습니다.

### 4.4 유튜브 OAuth

- 쓰기라서 API 키로는 안 됩니다. `youtube.force-ssl` 범위의 OAuth 2.0이 필요합니다.
- 클라이언트 ID/보안 비밀번호와 refresh token은 `.yt_oauth.json`(mode 600, gitignore)에만
  저장합니다.
- 동의 화면이 "테스트" 상태면 구글이 **7일마다 refresh token을 만료**시킵니다. 숨기지
  말고 UI에 경과일 배지와 `invalid_grant` 전용 안내로 표면화하세요(`lib/ytOAuth.js`).
- 쿼터: `videos.update` 1회 = **50유닛**, 기본 일일 10,000유닛. 언어를 몇 개 올리든
  영상 1편당 50유닛입니다.

### 4.5 언어 코드 해석

한국어 라벨(`포르투갈어 (브라질)`) → BCP-47(`pt-BR`) 변환은 `lib/ytLanguages.js`의
후보 배열에서 하고, 런타임에 `i18nLanguages.list`로 받아온 **실제 지원 목록과 대조**해
첫 지원 코드를 씁니다(`nl-BE` 미지원 → `nl`). 코드가 겹치면 뒤엣것을 건너뛰고 이유를
보고합니다. 이 해석 로직을 복사해서 두 벌로 만들지 말고 `planLocalizations()`를
재사용하세요.

**라벨 문자열은 `tools/yt/app.js`의 `LANGUAGES` 배열과 정확히 일치해야 합니다.** 오타는
조용히 언어 하나를 누락시킵니다. 새 라벨을 쓸 때는 코드를 읽어서 확인하세요. 추측 금지.

### 4.6 등록 전 길이 검증과 오류 로그 (CS-v2.3)

`/publish-localizations`는 `lib/ytPublishValidation.js`의 `validatePublishPayload()`로
videos.update에 실릴 최종 페이로드(title 100자·description 5000자·tags 합계 500자)를
**보내기 전에** 직접 센다. `localizations`는 항상 existing(기존 등록분) + planned(이번
등록분)를 합친 맵이므로, 이번에 건드리지 않는 예전 등록분이 지금 기준으로 초과여도 같이
걸린다. 문제가 하나라도 있으면 videos.update를 **아예 호출하지 않고** 422로 어떤 언어의
어떤 필드가 몇 자인지 응답한다 — dryRun 응답에도 같은 `problems[]`가 실려서 미리보기
단계에서 "적용" 버튼이 막힌다.

이 검증을 만든 계기: 실제 등록에서 "The request metadata is invalid."가 났는데,
`lib/ytOAuth.js`의 `youtubeApi()`가 그동안 `data.error.errors[]`(구글이 필드별로 주는
`{reason, location, locationType, message}`)를 버리고 `data.error.message` 한 줄만 썼다.
지금은 실패마다 `.yt_errors.log`(gitignore)에 `errors[]` 전문을 남기고, location이 있으면
사용자 메시지에도 같이 보여준다. **단, 확인해 보니 이 클래스의 오류(제목/설명 길이 초과)는
구글이 `location`을 필드별로 주지 않고 `"body"`(전체 요청) 하나로만 준다** — 그래서
`errors[]`를 살리는 것만으로는 어느 필드인지 알 수 없고, 4.6의 사전 검증이 실질적인
해결책이다. `errors[]` 서핑은 위치 정보를 주는 다른 종류의 오류(예: 권한/쿼터 계열)에는
여전히 유효하다.

---

## 5. 비밀 정보

절대 커밋하지 않습니다 (`.gitignore` 확인):

```
.gemini_key  .yt_oauth.json  .timeline-settings.json  .env  .env.local
node_modules/  output/  tools/storyboard/
```

문서나 코드 예시에 **실제 키·토큰·클라이언트 시크릿 값을 적지 마세요.** 새 상태 파일을
만들면 `.gitignore`에 먼저 추가하세요.

---

## 6. 작업 보고 규칙 — 가장 중요

이 프로젝트에서 이미 두 번, 테스트를 전부 통과한 상태로 심각한 버그가 배포됐습니다.
연번 기능은 화면 문자열만 바꾸고 실제 파일명은 그대로였는데 테스트가 화면 문자열만
봤기 때문에 통과했습니다.

그래서:

1. **테스트 통과 개수만 보고하지 마세요.** 그건 완료 보고가 아닙니다.
2. **실제 생성된 출력 샘플을 붙이세요.** 타임라인 텍스트 3줄, API 응답 JSON 전문,
   번역 결과, 조립된 설명란 등 사람이 눈으로 읽고 틀린 걸 알아챌 수 있는 것.
3. **실행해 보지 않고 "동작할 것입니다"라고 쓰지 마세요.** 실행할 수 없는 이유가
   있으면 그 이유를 명시하세요.
4. 외부 API 동작이나 스펙은 **기억에 의존하지 말고** 공식 문서를 확인하고 근거를
   제시하세요.
5. 지시받지 않은 리팩터링을 끼워 넣지 마세요. 필요하다고 판단되면 먼저 제안하세요.

---

## 7. 커밋·버전 관례

- 기능 변경 시 버전을 올립니다: `CS-v1.7`, `CS-v1.8` …
- 커밋 메시지: `feat: 영문 한 줄 요약 (CS-vX.Y)` + 본문에 **왜** 그렇게 했는지.
  `fix:`, `docs:`, `refactor:`도 같은 형식입니다.
- 코드 주석에 `TASK CS-vX.Y` 형태로 결정의 이유를 남기는 것이 이 저장소의 관행입니다.
  "무엇을 하는지"가 아니라 **"왜 이렇게 했는지, 왜 다른 방법을 안 썼는지"**를 씁니다.
  기존 예시: `routes/timeline.js` 상단 블록, `lib/ytOAuth.js` 상단 블록,
  `routes/yt.js`의 `videos.update` 설명 블록.
- 커밋 이력을 rebase/squash로 고쳐쓰지 마세요.
- `git push --force`는 사용자 확인 없이 실행하지 마세요.

---

## 8. 로드맵

`docs/ROADMAP.md`에 지시문 11개가 순서대로 있습니다. 한 지시문 = 한 작업 = 한 커밋이
원칙입니다. 여러 개를 한 번에 처리하지 마세요.
