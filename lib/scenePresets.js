// Season/scene presets for the thumbnail/cover studio's background generator.
// Each preset's Korean label maps to a ready-to-use English prompt seed so
// users never have to write English photography prompts from scratch.

const LIGHTING_PHRASES = {
  morning: 'soft morning light',
  midday: 'bright midday sunlight',
  goldenHour: 'golden hour warm backlight',
  evening: 'soft evening light',
  night: 'cool blue hour night lighting',
  overcast: 'soft diffused overcast light',
  afternoon: 'warm afternoon light',
};

const RAW_PRESETS = [
  // 여름
  { id: 'summer-beach-morning', labelKo: '바닷가 아침', season: '여름', timeOfDay: 'morning',
    sceneCore: 'calm tropical beach at sunrise, gentle waves, soft golden sand, clear horizon line, no people',
    mood: 'fresh and hopeful', palette: 'warm golden and soft blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'summer-blue-sky-palm', labelKo: '푸른 하늘과 야자수', season: '여름', timeOfDay: 'midday',
    sceneCore: 'vivid blue summer sky with a few palm trees swaying, bright sunny day, minimal clouds, tropical resort feeling, no people',
    mood: 'vibrant and refreshing', palette: 'saturated blue and green',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#0000FF' },
  { id: 'summer-beach-sunset-walk', labelKo: '해질녘 해변 산책로', season: '여름', timeOfDay: 'goldenHour',
    sceneCore: 'wooden boardwalk along a beach at sunset, warm orange sky reflecting on wet sand, distant calm ocean, no people',
    mood: 'warm and nostalgic', palette: 'warm orange and pink',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },
  { id: 'summer-night-rooftop', labelKo: '여름밤 도시 옥상', season: '여름', timeOfDay: 'night',
    sceneCore: 'city rooftop terrace at night in summer, warm string lights, distant skyline glow, clear night sky, no people',
    mood: 'cozy urban', palette: 'deep blue and warm amber',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'summer-valley-shade', labelKo: '시원한 계곡과 나무그늘', season: '여름', timeOfDay: 'midday',
    sceneCore: 'cool mountain valley stream surrounded by lush green trees, dappled sunlight through leaves, refreshing shade, no people',
    mood: 'serene and refreshing', palette: 'green and cool blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },

  // 가을
  { id: 'autumn-cafe-window-sunset', labelKo: '노을 지는 창가 카페', season: '가을', timeOfDay: 'goldenHour',
    sceneCore: 'cozy cafe window seat with warm autumn sunset light streaming in, a steaming cup of coffee on the table, blurred fall foliage outside, no people',
    mood: 'warm and nostalgic', palette: 'warm amber and brown',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },
  { id: 'autumn-maple-alley', labelKo: '단풍 든 골목', season: '가을', timeOfDay: 'afternoon',
    sceneCore: 'quiet alley lined with vivid red and orange maple trees, fallen leaves on the pavement, soft afternoon light, no people',
    mood: 'nostalgic and calm', palette: 'red, orange and brown',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#D30000' },
  { id: 'autumn-cosmos-field', labelKo: '코스모스 들판', season: '가을', timeOfDay: 'afternoon',
    sceneCore: 'wide field of blooming cosmos flowers swaying gently, soft pastel colors, clear autumn sky, no people',
    mood: 'gentle and dreamy', palette: 'pastel pink and sky blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'autumn-rainy-terrace', labelKo: '비 그친 오후 테라스', season: '가을', timeOfDay: 'overcast',
    sceneCore: 'outdoor terrace right after rain, wet reflective surfaces, a few autumn leaves scattered, calm atmosphere, no people',
    mood: 'quiet and reflective', palette: 'muted grey and warm brown',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },

  // 겨울
  { id: 'winter-first-snow-window', labelKo: '첫눈 내리는 창가', season: '겨울', timeOfDay: 'overcast',
    sceneCore: 'window view of the first snow falling softly outside, warm cozy interior light contrast, frosted glass edges, no people',
    mood: 'cozy and hopeful', palette: 'white and warm amber',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'winter-fireplace-blanket', labelKo: '벽난로와 담요', season: '겨울', timeOfDay: 'evening',
    sceneCore: 'warm living room with a crackling fireplace, a soft blanket draped over a chair, gentle firelight glow, no people',
    mood: 'cozy and intimate', palette: 'warm orange and deep brown',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },
  { id: 'winter-snowy-cabin', labelKo: '눈 덮인 산장', season: '겨울', timeOfDay: 'morning',
    sceneCore: 'snow-covered mountain cabin surrounded by pine trees, crisp clear winter morning, soft blue shadows on snow, no people',
    mood: 'peaceful and crisp', palette: 'white and cool blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#0000FF' },
  { id: 'winter-christmas-market-night', labelKo: '크리스마스 마켓 야경', season: '겨울', timeOfDay: 'night',
    sceneCore: 'festive christmas market at night with warm string lights and glowing stalls, gentle snowfall, soft bokeh lights in the background, no people',
    mood: 'festive and warm', palette: 'warm gold and deep blue',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },

  // 봄
  { id: 'spring-cherry-blossom-morning', labelKo: '벚꽃길 아침', season: '봄', timeOfDay: 'morning',
    sceneCore: 'path lined with blooming cherry blossom trees in soft morning light, pale pink petals drifting, clear pastel sky, no people',
    mood: 'fresh and romantic', palette: 'soft pink and pastel blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'spring-sprout-window', labelKo: '새싹 돋는 창가', season: '봄', timeOfDay: 'morning',
    sceneCore: 'window sill with fresh green sprouts and small potted plants, soft morning sunlight, clean minimal interior, no people',
    mood: 'fresh and gentle', palette: 'green and soft white',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
  { id: 'spring-rain-alley', labelKo: '봄비 내리는 골목', season: '봄', timeOfDay: 'overcast',
    sceneCore: 'narrow alley in gentle spring rain, soft reflections on wet pavement, blooming flowers along the wall, calm atmosphere, no people',
    mood: 'calm and tender', palette: 'soft green and grey',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },

  // 상시
  { id: 'evergreen-vinyl-coffee', labelKo: '레코드판과 커피', season: '상시', timeOfDay: 'afternoon',
    sceneCore: 'close-up flat lay of vintage vinyl records and a warm cup of coffee on a wooden table, soft warm indoor light, cozy atmosphere, no people',
    mood: 'nostalgic and cozy', palette: 'warm brown and cream',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },
  { id: 'evergreen-old-radio-room', labelKo: '오래된 라디오가 있는 방', season: '상시', timeOfDay: 'evening',
    sceneCore: 'vintage room with an old retro radio on a wooden shelf, warm lamp light, soft shadows, nostalgic interior, no people',
    mood: 'nostalgic and quiet', palette: 'warm sepia tones',
    recommendedTextColor: '#FFFF00', recommendedShadowColor: '#000000' },
  { id: 'evergreen-city-night-cafe', labelKo: '도시 야경 카페', season: '상시', timeOfDay: 'night',
    sceneCore: 'cafe window overlooking a glowing city skyline at night, warm interior light contrasting cool blue night tones, no people',
    mood: 'modern and cozy', palette: 'warm amber and cool blue',
    recommendedTextColor: '#FFFFFF', recommendedShadowColor: '#000000' },
];

function buildPromptSeed(preset) {
  const lighting = LIGHTING_PHRASES[preset.timeOfDay] || '';
  return [preset.sceneCore, lighting, `${preset.mood} mood`, `${preset.palette} color palette`]
    .filter(Boolean)
    .join(', ');
}

export const SCENE_PRESETS = RAW_PRESETS.map((preset) => ({ ...preset, promptSeed: buildPromptSeed(preset) }));

export const SEASONS = ['여름', '가을', '겨울', '봄', '상시'];

export function scenePresetById(id) {
  return SCENE_PRESETS.find((p) => p.id === id);
}
