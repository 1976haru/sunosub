# social-studio 패키지 규약 (S0)

이 문서는 `tools/social-studio/`의 폴더 구조와 데이터 계약을 설명합니다. S0(입력 어댑터·
한국어 사전 레이어)의 결과물이며, S1(텍스트 팩 생성기)이 이 문서의 `normalized.json`
스키마를 입력으로 삼습니다.

Suno Weaver Studio가 출력하는 곡세트 JSON을 사람이 읽고 눈으로 검증할 수 있는 한국어
소셜 텍스트로 바꾸는 것이 social-studio의 목적입니다. 번역 API를 쓰지 않고, 로컬 사전
파일로만 이 문제를 풉니다. 이 결정의 배경은 이 저장소 루트의 `CLAUDE.md`가 아니라
S0 작업 지시문(TASK-S0) 자체에 있습니다 — social-studio는 별도 로드맵을 따릅니다.

---

## 1. 폴더 구조

```
tools/social-studio/
  schema/
    setpack.schema.json          # 입력 계약 (참고용 JSON Schema, 검증기 의존성 없음)
    normalized.schema.json       # 출력 계약
  parse/
    setPackLoader.js             # 입력 로드 + 검증 + 정규화 (메인 진입점)
    emotionArcParser.js          # emotionArc 문법 파서
    lexicon.js                   # 사전 조회 + 미지어 수집
  data/
    channels.json                # channelId → 출력 언어 매핑
  data/lexicon/
    stopwords.en.json            # listenerSituation 스캔에서 제외할 영어 불용어
    ko/
      nouns.json                 # 명사·사물·장소·행동·수식어 사전 (한국 채널용)
      emotions.json              # emotionArc의 감정구 사전
      timewords.json             # 시간·계절 사전
      transitions.json           # emotionArc 전이동사 사전
    ja/
      nouns.json / emotions.json / timewords.json / transitions.json
      # S0 시점에는 entries:{} 빈 골격만 존재. 일본어 세트 샘플을 받은 뒤 채운다.
  out/
    {setName}/normalized.json    # 정규화 결과 (실행마다 생성, git에 커밋하지 않음)
    {setName}/unknown-terms.json # 미지어 리포트
  test/
    fixtures/sample-setpack.json
    setPackLoader.test.js
    emotionArcParser.test.js
    lexicon.test.js
  .gitignore                     # out/ 제외
```

`tools/social-studio/out/`는 실행 결과물이므로 `tools/social-studio/.gitignore`에서
제외합니다. 저장소 루트 `.gitignore`는 이 작업에서 건드리지 않습니다.

---

## 2. 실행 방법

```bash
node --test --test-concurrency=1 tools/social-studio/test/*.test.js
```

**`--test-concurrency=1`이 필수입니다.** 완료조건 검증용 테스트 일부는 spec이 명시한 대로
실제 공유 픽스처 파일(`data/lexicon/ko/nouns.json`, `templates/good-morning-memory-radio/`)을
백업 → 비움 → 실행 → 복원하는 방식으로 동작한다(S0 완료조건 5번, S1 완료조건 3번 — 둘 다
"실제 파일을 비우고 실행하면"이라고 명시했으므로 격리된 사본이 아니라 진짜 파일을 다룬다).
기본 동시성(`node --test`가 여러 테스트 파일을 병렬로 돌리는 것)에서는 이 백업/복원 구간과
같은 파일을 읽는 다른 테스트 파일이 겹칠 수 있어 드물게 실패한다 — 실제로 3회 연속 실행 중
2회 실패로 재현된 문제다. `--test-concurrency=1`로 직렬 실행하면 100% 통과한다.

파이프라인을 직접 실행하려면:

```js
import { runSetPackPipeline } from './tools/social-studio/parse/setPackLoader.js';
const { normalized, report, outDir } = runSetPackPipeline('경로/세트.json');
```

`npm run check`는 `server.js` 문법만 검사하므로 이 도구를 검증하지 않습니다
(`CLAUDE.md` 2장 참조). `tools/social-studio/`는 서버 라우트 없이 `node:test`로
직접 검증합니다.

---

## 3. 입력 스키마 요약 (`setpack.schema.json`)

최상위: `meta`, `songs`.

`meta` 필수: `setName`, `channelId`, `channelLabel`, `songCount`,
`lyricLanguage`(`english`|`korean`|`japanese`). 선택: `conceptLabel`, `generatedAt`.

`songs[]` 필수: `trackNo`, `title`, `titleLocalized`, `listenerSituation`, `emotionArc`,
`hookPhrase`, `lyrics`. 선택: `seasonMoment`, `stylePrompt`, `excludePrompt`, `youtube`
(`{title, description, tags[]}`).

검증 규칙 (전부 `parse/setPackLoader.js`의 `validateSetPack()`이 손으로 구현, 스키마
검증기 라이브러리를 쓰지 않음 — S0는 기존 파일을 라우팅 1줄 외에는 건드리지 않으므로
`package.json`에 새 의존성을 추가하지 않았다):

- BOM(`﻿`)을 제거한 뒤 파싱한다.
- 필수 필드 누락 시 `SetPackValidationError`를 던진다. 기본값으로 채우지 않는다.
- `trackNo` 중복 시 오류.
- `meta.songCount`와 `songs.length`가 다르면 경고만 남기고 `songs.length`를 신뢰한다.
- `songs.length`가 500을 넘으면 오류 (명시적 반복 상한).

---

## 4. 출력 언어 결정 (`data/channels.json`)

`meta.lyricLanguage`는 가사 언어이지 출력 언어가 아니다. 출력 언어는 `meta.channelId`를
`data/channels.json`의 `mappings` 배열과 대조해 결정한다:

```json
{ "match": "good-morning-memory-radio", "type": "exact", "language": "ko" }
{ "match": "kr-", "type": "prefix", "language": "ko" }
{ "match": "jp-", "type": "prefix", "language": "ja" }
```

매핑에 없는 `channelId`는 기본 언어로 넘어가지 않고 오류를 던진다
(`resolveChannelLanguage()`).

---

## 5. emotionArc 문법과 파서

```
{시작감정구} {전이동사} (into|toward) {도착감정구}
```

`parse/emotionArcParser.js`의 `parseEmotionArc(raw, transitionsLexicon, emotionsLexicon)`은
전이동사 목록을 하드코딩하지 않고 `data/lexicon/{lang}/transitions.json`에서 읽는다.
문법에 맞지 않으면 `{ parsed: false, from: null, transition: null, to: null, joiner: null }`을
반환하고, 호출자(`setPackLoader.js`)가 `unmatchedEmotionArcs`에 원문을 기록한다.

감정구가 문법상 올바르게 분리됐지만 사전에 없으면 `from.ko`/`to.ko`가 `null`이 되고
`unknownTerms`에 `field: "emotionArc"`로 기록된다. 조용히 영어를 그대로 쓰지 않는다.

---

## 6. 사전 조회 (`parse/lexicon.js`)

- `normalizePhrase()`: 소문자화 + 하이픈을 공백으로 치환 + 공백 정리.
  `sticky-hot` = `sticky hot`.
- `scanTextMulti(text, sources, stopwords)`: `listenerSituation` 같은 자유 텍스트에서
  구(phrase)를 긴 것부터 먼저 매칭한다(`first light`가 `first`+`light`로 쪼개지지 않음).
  `sources`는 우선순위가 있는 사전 목록이다 — social-studio는 `timewords.json`을
  `nouns.json`보다 먼저 확인해, "evening" 같은 시간어가 명사 사전이 아니라 시간 사전에서
  해석됐다는 사실을 결과에 남긴다(`matchedTerms[].source`).
- 반복문은 `MAX_TOKENS_PER_SCAN`(2000)으로 상한을 둔다.
- 사전에 없는 단어는 절대 추측하지 않고 `unknownTerms`로 반환한다.

### coverage.nouns의 정의

`coverage.nouns`는 **`nouns.json`이 실제로 해결한 비율만** 잰다. `timewords.json`이
매칭한 단어는 분자·분모 양쪽에서 제외한다 — 그래야 `nouns.json`을 빈 사전으로 바꿔도
`timewords.json`이 남아 있다는 이유로 커버리지가 거짓으로 높게 나오지 않는다. 이 설계는
S0 완료 조건 5번("`nouns.json`을 비우면 `coverage.nouns`가 0에 가깝게 나와야 한다")을
지키기 위한 것이다. `computeSourceCoverage()`를 참조.

---

## 7. 세트 레벨 파생값

`normalized.json`의 `set` 블록:

| 필드 | 설명 |
|---|---|
| `trackCount` | `songs.length` |
| `titlesKo` | 각 곡 `titleLocalized` 배열 |
| `dominantEmotions` | 파싱된 `to` 감정(ko) 중 빈도 상위 3개 |
| `sceneNouns` | 전곡 `listenerSituation`에서 매칭된 한국어 용어 빈도 상위 12개 |
| `seasonHint` | 아래 참조. 승격되지 않으면 `null` |
| `warnings` | 검증·정규화 중 발생한 비치명적 경고 |
| `assets.shorts` | **예약 필드. S0는 채우지 않는다.** 향후 S4(이미지/쇼츠)가 사용 |

### seasonMoment 승격 규칙

전곡의 `seasonMoment`가 동일하면 `set.seasonHint`로 승격하고 각 곡에서는 `null`로
비운다. `warnings`에 `"seasonMoment가 전곡 동일하여 세트 레벨로 승격함"`을 남긴다.
곡마다 값이 다르면 승격하지 않고 각 곡의 `seasonMoment`를 그대로 둔다.

---

## 8. 미지어 리포트 (`out/{setName}/unknown-terms.json`)

```json
{
  "setName": "...",
  "coverage": { "nouns": 0.99, "emotions": 1.0 },
  "unknownTerms": [
    { "term": "trellis", "field": "listenerSituation", "trackNo": 12, "context": "..." }
  ],
  "unmatchedEmotionArcs": []
}
```

`coverage.nouns`가 0.90 미만이면 `set.warnings`에 경고를 남긴다(중단하지 않음).

---

## 9. 향후 단계와의 경계

- S1(텍스트 팩 생성기)이 `normalized.json`을 읽어 유튜브 제목·설명·해시태그와 플랫폼별
  글을 만든다. 확신이 서지 않는 필드는 버리지 않고 `raw` 원문을 함께 보존한다
  (`emotionArc.raw`, `listenerSituation.raw`, `stylePrompt`, `excludePrompt`, `youtube` 등).
- 곡별 `youtube` 블록은 S0에서 가공하지 않고 원문 그대로 보존한다. 세트 18곡용 유튜브
  제목·설명은 S1에서 새로 만든다.
- `set.assets.shorts[]`는 스키마에 자리만 정의되어 있고 S0는 값을 채우지 않는다. S4에서
  구현한다.
- S2(화면)는 이 문서의 범위 밖이다. S3(중복·규칙 검사)은 11장, S5(하테나 발행)는 13장 참조.

---

## 11. socialLint — 중복·규칙 검사 (S3)

`lint/socialLint.js`가 `out/{setName}/textpack.json`(또는 편집본)을 읽어 규칙 7개(R1~R7)를
검사하고 `out/{setName}/lint-report.json`을 쓴다. 규칙별 임계값은 전부
`data/lintThresholds.json`에서 읽으며, 코드에 숫자를 하드코딩하지 않는다.

### 규칙과 데이터 출처

| 규칙 | 파일 | severity | 비교 대상 |
|---|---|---|---|
| R1 채널 간 유사도 | `lint/rules/crossChannel.js` | error | 같은 주차 다른 채널의 **실제 `textpack.json`을 직접 읽어** 비교 (지문이 아니라 원문 대 원문) |
| R2 템플릿 재사용 | `lint/rules/templateReuse.js` | error→warn(소진 시) | `store/lintHistory.json`의 `templateIds` |
| R3 해시태그 중복 | `lint/rules/hashtagOverlap.js` | warn | `store/lintHistory.json`의 `hashtags` |
| R4 플랫폼 규격 | `lint/rules/platformRules.js` | error | `data/platformLimits.json` (S1 소유, 값을 다시 적지 않음) |
| R5 금지 표현 | `lint/rules/bannedPhrases.js` | warn | `data/bannedPhrases.json` |
| R6 발행 간격 | `lint/rules/postingCadence.js` | warn | `store/lintHistory.json` + `resolvePostingDate()` |
| R7 캡션 내 반복 | `lint/rules/wordRepetition.js` | warn | 없음(항목 자체 스캔) |

**R1이 `lintHistory.json`을 거치지 않는 이유**: "같은 주차"는 정의상 아직 지나지 않은
시간이므로 다른 채널의 실제 `out/{setName}/textpack.json`이 디스크에 그대로 있다. 지문으로
낮춰 비교할 이유가 없어 원문 대 원문(정확한 Jaccard)으로 비교한다. R2·R3는 여러 주에 걸친
비교라 `lintHistory.json`에 남긴 지문/ID만 쓴다 — 원문 자체는 저장하지 않는다
(`lint/similarity.js`의 `contentFingerprint()`, FNV-1a 8자리 해시).

### R2의 알려진 한계 — S1이 아직 `templateId`를 기록하지 않는다

`textpack.json`은 현재 각 항목의 `text`만 담고 있고, 생성에 실제 쓰인 `templateId`는
버려진다(`generate/*.js`가 내부적으로는 `{id, text}`를 만들지만 최종 출력에는 `text`만
남긴다). S3 지시문 자체가 이 상황을 예상하고 명시적 대응을 요구했다: **"S1이 사용한
templateId를 기록하고 있어야 한다. 없으면 S1 미완료로 보고한다."**

그래서 `templateReuse.js`는 `textpack.templateIds`가 없으면 즉시 `notes`에 "S1
미완료"라고 남기고 통과 처리한다 — 실패도, 조용한 무시도 아니다. 규칙 로직 자체는
합성(fixture) `templateIds`로 완전히 검증되어 있다(테스트 참조). "기존 파일 수정은
라우팅·호출 등록 1줄만 허용"이라는 이번 지시문의 범위 제한 때문에 S1의 생성 로직을
바꾸지 않았다 — `templateId` 기록은 S1을 다시 여는 별도 작업으로 남겨둔다.

### R7 — 왜 한글 음절에만 적용하는가

초판은 `[가-힣A-Za-z]+`로 토큰을 잡았는데, 실제 샘플 세트로 돌려보니 `naver.bodyHtml`의
`<li>` 태그가 "li"라는 단어가 36번 반복된 것으로 잡히고, `{titleEn}` 슬롯에 그대로 남는
영어 원곡 제목("Never", "Neon", "Neighborhood")이 "Ne로 시작하는 단어 반복"으로 잘못
묶였다. 영어 2글자는 한글 2음절만큼 정보량이 없어서 생기는 문제였다. 토큰 정규식을
`[가-힣]+`로 좁혀 해결했다 — spec 자체가 "명사"·"음절" 기준을 한국어 전제로 설명하고
있어 이 범위 축소가 규칙의 의도에 더 맞는다.

### 재생성 연동 (`runLintWithRegeneration`)

`lint/socialLint.js`는 생성기를 직접 import하지 않는다. `runLintWithRegeneration(setName,
regenerateFn, options)`가 재검사 루프를 갖고 있지만, 실제로 텍스트를 다시 만드는 함수는
호출자가 주입한다. `generate/textPack.js`의 `runTextPackPipeline()`에는 이번 작업에서
허용된 "호출 등록 1줄"로 `options.onAfterGenerate` 훅만 추가했다 — S1은 S3를 모르고, S3도
S1의 생성 로직을 모른다.

---

## 13. 하테나 AtomPub 예약 발행 (S5)

`publish/hatena.js`가 `out/{setName}/textpack.json`의 `hatena` 항목을 읽어 하테나 블로그에
**예약** 발행한다. social-studio 전체에서 유일하게 외부 네트워크를 쓰는 코드이며, 그만큼
안전장치가 다른 어떤 지시문보다 많다: 드라이런이 기본값, `.env` 없이는 실발행 불가,
일본 채널(`jp-*`)이 아니면 거부, 같은 `setName` 재발행 거부, 시각 검사(과거·범위 밖 거부),
API 키는 로그·리포트 어디에도 남기지 않는다(`publish/wsse.js`의 `maskSecret()`).

### 실행

```bash
node tools/social-studio/publish/hatena.js <setName>            # 드라이런(기본값, 네트워크 0건)
node tools/social-studio/publish/hatena.js <setName> --publish  # 실발행(.env 필요)
```

### 알려진 한계 — `textpack.hatena`가 아직 실제로 채워지지 않는다

S1의 `generate/blogPost.js`의 `generateHatena()`는 현재 시점에 **항상 스텁 경로**를 탄다 —
`data/lexicon/ja/*.json`이 S0에서 빈 골격으로만 존재하고(`docs/social-package-spec.md` 6장),
`templates/*/hatena.json`도 아직 없기 때문에, 실제 일본 채널 세트를 돌려도
`textpack.hatena.title`/`body`는 항상 `null`이다. `publish/hatena.js`는 이 상태를 명시적으로
잡아 오류를 던지도록 만들어져 있고(`textpack.json에 하테나 항목(title/body)이 없습니다`),
S5 자체의 로직(WSSE·XML·사전 검사 5종)은 합성 fixture로 완전히 검증했다. 실제 일본어
세트로 끝까지 돌리려면 ja 사전과 하테나 템플릿을 먼저 채워야 한다.

### 완료조건 10번 — 검증되지 않음

실제 예약 발행이 하테나 관리 화면에 "예약"으로 표시되는지는 실제 하테나 계정과 API 키가
있어야 확인할 수 있다. 이 작업을 수행한 시점에는 그런 계정이 없어 **드라이런까지만
검증되었다** — XML 생성, WSSE 헤더 생성, 사전 검사 5종은 전부 자동화 테스트와 실제 실행
결과로 확인했지만, 실제 하테나 서버가 그 요청을 받아 정말로 예약 상태로 처리하는지는
별도로 확인해야 한다.

---

## 14. 샘플 데이터에 대한 메모

이 저장소에는 TASK-S0 지시문이 근거로 든 실제 샘플 파일
(`20260804_굿모닝추억라디오_70년대감성.json`, 58,085 bytes)이 존재하지 않았다.
`test/fixtures/sample-setpack.json`은 그 지시문의 구조·문법 요구사항(18곡, `emotionArc`
문법 100% 일치, `seasonMoment` 전곡 동일 등)을 만족하도록 새로 작성한 것이며, 지시문에
적힌 실측값(예: 고유 단어 160개)은 재현하지 않았다 — 정확한 값은 실행 결과를 직접
확인하라(완료 보고 참조).

TASK-S7은 반대로 실제 파일(`D:\suno\suno-current\lyrics\`의 v1/v2 세트)에 직접 접근해
검증했다 — 코드에는 포함하지 않는다(가사가 실제 저작물이라 리포지토리에 커밋하지 않음).
`test/fixtures/sample-setpack-v2.json`은 기존 `sample-setpack.json`을 v2 스키마 모양으로
변형한 합성 픽스처다(`titleLocalized` 제거, `seasonMoment` 곡별 고유값, `youtube.tags`
8개, `qualityScore`/`warnings`/`lyricThemeText` 등 v2 필드 추가) — 자동화 테스트는 이
픽스처로 돌고, 실제 파일 검증 결과는 TASK-S7 완료 보고에 별도로 남겼다.

## 14a. TASK-S7 — v2 스키마 지원

2026-08-07 전후로 Suno Weaver Studio의 출력 형식이 바뀌어 `titleLocalized` 필드가
사라졌다(원인 미확인 — 회귀인지 의도적 제거인지는 Suno Weaver Studio 쪽에서 별도로
확인해야 한다. `git log -S "titleLocalized"` 참조). 이 저장소는 그 원인을 고치지 않고,
없어도 파이프라인이 죽지 않도록 흡수한다:

- `REQUIRED_SONG_FIELDS`에서 `titleLocalized`를 뺐다. 없으면 `title`(영어 원제)로
  폴백하고 `titleLocalizedFallback: true`를 정규화 결과에 남긴다.
- 출력 언어가 `ko`/`ja`일 때만(영어 채널은 폴백이 정상이므로 경고 대상이 아니다)
  `set.warnings`에 폴백 개수를 명시한 경고를 남긴다. 세트의 절반을 넘게 폴백하면
  `[중요]` 접두를 붙인다.
- `seasonMoment` 승격 조건(전곡 완전 동일)은 손대지 않았다 — v1은 계속 승격하고,
  v2(곡마다 고유값)는 승격하지 않는다. 그대로 동작했다.
- v2 전용 필드(`lyricThemeText`, `distinctChoice`, `genreText`, `pov`, `qualityScore`,
  `warnings`)를 정규화 결과에 실어 보낸다. `lyricThemeText`는 `listenerSituation`과
  동일하게 명사·시간어 스캔 대상이다(같은 `coverage.nouns` 풀에 합산). 나머지는
  원문 그대로 pass-through — 이번 작업 범위에서 문장 생성 로직(S1)에 새로 연결하지
  않았다(`genreText`/`distinctChoice`를 실제 해시태그·쇼츠 문구에 쓰는 것은 후속 작업).
  `song.warnings`(상류 경고)는 `[상류] (트랙 N) ...` 형태로 `set.warnings`에 합쳐진다.
- `generate/youtubeShort.js`의 쇼츠 상위 3곡 선정은 `qualityScore`가 하나라도 있으면
  그 값 내림차순(동점은 안정 정렬로 trackNo 순서 유지)으로, 없으면 기존
  trackNo 순서로 동작한다(`pickTopSongs()`).

### 사전 보강

`data/lexicon/ko/nouns.json`(82→167개), `data/lexicon/ko/timewords.json`(13→24개),
`data/lexicon/stopwords.en.json`(18→83개)를 실제 v1/v2 샘플의 미지어(merge 시 119개)
기준으로 채웠다. 동사형·복수형(`rolling`/`roll`, `windows`/`window`,
`sliding`/`slide`)은 엔트리를 따로 만들지 않고 `parse/lexicon.js`의
`morphologicalVariants()`가 표제어 하나로 흡수한다(복수형 `-s`, `-ing`/`-ed` 어미,
자음 중복 undo, 묵음 e 복원) — 사전에 실제로 없는 변형은 여전히 unknownTerms로
남는다(추측 번역 없음).

**부수적으로 발견해 고친 결함**: `data/lexicon/ko/timewords.json`의 `after`/`while`
엔트리가 `category: "time"`이었다. `generate/youtubeSet.js`의 `deriveTimeKo()`는 이
카테고리를 "아침/저녁/밤" 같은 시간대 슬롯 값으로 그대로 쓰는데, `after`/`while`의
번역("~ 이후", "~하는 동안")은 문장 조각이라 슬롯에 단독으로 들어가면 안 된다. v1
샘플에서는 우연히 다른 시간대 단어가 더 자주 나와 드러나지 않았지만, v2 샘플은 실제로
유튜브 제목 후보에 "70년대 올드팝 명곡 ~ 이후 플레이리스트"가 나왔다(완료 보고 참조).
`category: "relative"`로 재분류해 고쳤다 — 사전 항목 자체는 그대로 유지되므로
coverage.nouns나 다른 매칭에는 영향이 없다.

## 15. TASK-S8 — 텍스트 팩 출력 품질 보정

TASK-S7까지는 "생성이 성공하는가"를 봤다. TASK-S8은 실제 생성된 문장을 처음부터 끝까지
읽고 발견한 8가지 문제(사전이 문장에 반영 안 됨, 세트 내 플랫폼 간 반복, 해시태그 풀
공유, 인스타 캡션/첫댓글 동일, 글자수 미달, 조사 중복, 가사 인용이 영어, 금지 표현
미검출)를 고쳤다.

### 작업 A — sceneNouns 희소성 가중

`parse/setPackLoader.js`의 `set.sceneNouns`가 단순 빈도순이라 18곡 전부에 나오는
`table`/`window`/`road` 같은 흔한 단어가 상위를 차지했다. `data/sceneNounWeights.json`에
가중치를 두고 `scoreSceneTerms()`/`rankSceneTerms()`로 재구현했다: `score = 등장곡수
구간별 가중치 × (1/등장곡수)`. 최소 rare-word 개수 보장(`minRareInTop`)과 카테고리
다양성 보정(`diversityCategories`)은 둘 다 **swap 후 재정렬하지 않는다** — 처음 구현에서
낮은 점수의 다양성 후보를 정렬로 다시 밀어내는 버그가 있었다(테스트로 발견, 수정함).

**더 중요한 발견**: `set.sceneNouns`를 고쳐도 실제 문장은 그대로였다. 문장에 실제로
쓰이는 슬롯(`{sceneNoun1}` 등)은 `generate/youtubeSet.js`의 `deriveSceneNouns()`가 **별도로**
단순 빈도 계산을 하고 있었다 — S0의 `sceneNouns` 계산과 완전히 분리되어 있었다. 이걸
고치지 않으면 지난 작업(TASK-S7)과 똑같이 "숫자는 올랐지만 문장은 그대로"가 반복된다.
`deriveSceneNouns()`가 `rankSceneTerms()`를 재사용하도록 고쳤다(`generate/youtubeSet.js`가
`parse/setPackLoader.js`를 import — S1이 S0의 계산 로직을 재사용하는 것은 문제없다).

### 작업 B — R8 intraSetRepetition + 재생성

`lint/rules/intraSetRepetition.js`(R8)는 같은 세트의 naver.bodyHtml/facebook.body/
x.main/x.thread 네 항목에서 같은 sceneNoun이 2회 초과 등장하면 잡는다. severity는 warn이지만
`regenerate: true`를 달아 `lint/socialLint.js`의 regenerate 배열 계산(원래 error 전용)에
포함되도록 확장했다(다른 규칙은 전부 이 필드가 없으므로 하위 호환).

검사 후보 단어는 `normalized.set.sceneNouns`(top-12) 전체에서 두 가지를 뺀다:
- 현재 `{timeKo}` 슬롯 값 — 모든 플랫폼이 의도적으로 공유하는 값이라 "반복"이 아니다.
- 채널 라벨(`channelLabel`)의 부분 문자열 — "굿모닝 추억라디오"에 포함된 "라디오"가
  대표적이다. `radio` 사전 항목의 ko가 우연히 채널명의 일부와 같아서, 채널명이 언급될
  때마다(의도된 브랜드 노출) 오탐이 뜬다. 실제 v2 세트를 돌려서 찾은 문제다.

재생성은 `generate/textPack.js`의 `buildRegenerateFn(normalized, options)`이 맡는다.
`runLintWithRegeneration`이 이 함수를 **같은 인스턴스**로 반복 호출한다는 점이 중요하다
— 클로저에 누적되는 `excludeSceneNouns` 집합을 매 호출 시작에 "지금 이 exclude 상태로
뽑힐 sceneNoun1-3"을 먼저 추가한 뒤 생성한다. 처음 구현은 매 호출마다 exclude 집합을
새로 계산해서 매번 똑같은 대체 단어로 수렴하는 버그가 있었다(예: "커피"를 빼도 항상
"포치 그네"로만 감. 그 "포치 그네"가 또 반복되면 다음 시도에서도 여전히 "포치 그네"만
빠지지 않는 문제) — 실제 v2 세트로 재생성 루프를 끝까지 돌려서 발견했다.

### 작업 C — 해시태그 풀 분리

`templates/_shared/hashtags.json` 하나(해시태그 45개, 태그 30개)를 모든 플랫폼이 공유해서,
유튜브 상위 15개와 쇼츠 5개가 자주 겹쳤다. `templates/{channelId}/hashtags/
{youtube,youtube-tags,instagram,naver,shorts}.json` 다섯 개로 나눴다. 각 풀은 필요
개수의 2배 이상(유튜브 37/40, 인스타 60, 네이버 20, 쇼츠 12)이고, 플랫폼 간 실측
중복률은 전부 0(교집합 없음) — R9가 검사하는 0.30 상한에 크게 못 미친다. 유튜브 태그
풀(`youtube-tags.json`)은 검색어 스타일(`부모님선물`, `효도플레이리스트` 등)로 따로 썼다.

### 작업 E — 최소 길이 재시도

`generate/slotFiller.js`의 `selectTemplateWithMinMaxLength()`는 기존
`selectTemplateWithinLimit()`과 별개다 — max만 검사하던 기존 함수를 바꾸면 기존 호출자
동작이 달라지므로, 최소/최대를 함께 보는 새 함수를 추가했다. 재시도 상한은 지시문 예시
값(5)이 아니라 12를 썼다 — 실제 두 샘플 세트에서 5회 안에 충분히 긴 템플릿이 로테이션
순서상 걸리지 않는 경우가 있어서(포치용 인스타 캡션 템플릿 9개 중 6번째 위치),
5로는 완료조건 8번(캡션 250자 이상)이 실제로 통과하지 않았다. 인스타/X/페이스북
템플릿 풀에 더 긴 버전을 추가할 때도 처음 쓴 문장은 실측 200자 안팎으로 목표(250자)에
못 미쳤다 — 초안 문장 길이를 감으로 어림하지 말고 매번 실행해서 실제 글자수를
확인해야 했다.

### 작업 F — 조사 중복

"늦여름의 시작의 노래" 버그는 지시문 설명("슬롯 값이 조사로 끝나는 경우")과 실제
메커니즘이 달랐다 — `seasonKo`("늦여름의 시작")는 "시작"으로 끝나지 "의"로 끝나지
않는다. 실제 원인은 `sh-t-005` 템플릿이 `{seasonKo}의 노래`처럼 이미 완결된 구
뒤에 조사를 하드코딩한 것이었다. 이건 템플릿을 고쳐서(`{seasonKo}에 어울리는 노래`)
해결했다.

일반적인 "인접 중복"(의의/이이/를를 등)은 별도로 `collapseDuplicateParticles()`가
`fillSlots()` 안에서 항상 실행된다 — 예: `해변 산책로`(place, "로"로 끝남) 뒤에
`(으로/로)` 마커가 받침 없음 판정으로 "로"를 골라 "산책로로"가 되는 경우. 실제
`yt-t-012` 템플�릿에 이 조합이 있다.

### 작업 G — 가사 인용 언어 가드

`meta.lyricLanguage`(가사 언어)와 `normalized.set.outputLanguage`(출력 언어)가
다르면 `x.lyricQuote`를 생략하고 경고를 남긴다. 한국어 채널 + 영어 가사(v1/v2 샘플
둘 다 이 경우)에서 실제로 생략되고 "가사가 영어이므로 인용을 생략했습니다"가
warnings에 남는 것을 확인했다.

### 작업 H — 금지 표현

`data/bannedPhrases.json`이 비어있던 게 아니라(20개 있었다), 지시문이 준 구체적 표현
("구독과 알림", "알림 설정" 등)이 목록에 없었을 뿐이다. R5 자체(`lint/rules/
bannedPhrases.js`)는 이미 `youtube.pinnedComment`를 포함해 전체 textpack을 스캔하고
있었다 — 검사 로직은 멀쩡했고 데이터만 비어 있었다.
