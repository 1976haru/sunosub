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
- S2(화면), S5(발행)는 이 문서의 범위 밖이다. S3(중복·규칙 검사)은 11장 참조.

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

## 12. 샘플 데이터에 대한 메모

이 저장소에는 TASK-S0 지시문이 근거로 든 실제 샘플 파일
(`20260804_굿모닝추억라디오_70년대감성.json`, 58,085 bytes)이 존재하지 않았다.
`test/fixtures/sample-setpack.json`은 그 지시문의 구조·문법 요구사항(18곡, `emotionArc`
문법 100% 일치, `seasonMoment` 전곡 동일 등)을 만족하도록 새로 작성한 것이며, 지시문에
적힌 실측값(예: 고유 단어 160개)은 재현하지 않았다 — 정확한 값은 실행 결과를 직접
확인하라(완료 보고 참조).
