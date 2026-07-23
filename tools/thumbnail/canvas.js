export const FONT_OPTIONS = [
  { id: 'blackHanSans', family: 'Black Han Sans', weight: '400' },
  { id: 'doHyeon', family: 'Do Hyeon', weight: '400' },
  { id: 'jua', family: 'Jua', weight: '400' },
  { id: 'gowunDodum', family: 'Gowun Dodum', weight: '400' },
  { id: 'yeonSung', family: 'Yeon Sung', weight: '400' },
  { id: 'nanumPenScript', family: 'Nanum Pen Script', weight: '400' },
];

export const TEXT_COLORS = ['#FFFFFF', '#FFFF00', '#00FFFF', '#FF69B4', '#7CFC00', '#FFA500'];
export const SHADOW_COLORS = ['#000000', '#FFFFFF', '#D30000', '#0000FF'];

export const BASE_STYLE_PRESETS = [
  { id: 'preset1', label: 'Black Han Sans · 흰색 · 검은그림자', fontId: 'blackHanSans', textColor: '#FFFFFF', shadowColor: '#000000', shadowWidth: 2, strokeOn: true },
  { id: 'preset2', label: 'Do Hyeon · 노랑 · 검은그림자', fontId: 'doHyeon', textColor: '#FFFF00', shadowColor: '#000000', shadowWidth: 2, strokeOn: true },
  { id: 'preset3', label: 'Jua · 흰색 · 빨강그림자', fontId: 'jua', textColor: '#FFFFFF', shadowColor: '#D30000', shadowWidth: 2, strokeOn: true },
  { id: 'preset4', label: 'Gowun Dodum · 노랑 · 파랑그림자', fontId: 'gowunDodum', textColor: '#FFFF00', shadowColor: '#0000FF', shadowWidth: 2, strokeOn: true },
];

export const TEXT_POSITIONS = [
  { id: 'top-center', label: '상단 중앙' },
  { id: 'center', label: '중앙' },
  { id: 'bottom-center', label: '하단 중앙' },
  { id: 'top-left', label: '좌상단' },
  { id: 'bottom-left', label: '좌하단' },
  { id: 'top-right', label: '우상단' },
  { id: 'bottom-right', label: '우하단' },
];

export function fontFamilyById(id) {
  return FONT_OPTIONS.find((f) => f.id === id) || FONT_OPTIONS[0];
}

export async function ensureFontsLoaded(fontIds = FONT_OPTIONS.map((f) => f.id)) {
  const jobs = fontIds.map((id) => {
    const font = fontFamilyById(id);
    return document.fonts.load(`48px "${font.family}"`).catch(() => {});
  });
  await Promise.all(jobs);
  await document.fonts.ready;
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    img.src = src;
  });
}

export function drawBackgroundCover(ctx, image, width, height, fillColor = '#111622') {
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, width, height);
  if (!image) return;
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const dx = (width - drawWidth) / 2;
  const dy = (height - drawHeight) / 2;
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
}

function wrapAlign(position) {
  if (position.includes('left')) return 'left';
  if (position.includes('right')) return 'right';
  return 'center';
}

function anchorPoint(position, width, height, padding) {
  const align = wrapAlign(position);
  const x = align === 'left' ? padding : align === 'right' ? width - padding : width / 2;
  let y;
  if (position.startsWith('top')) y = padding;
  else if (position.startsWith('bottom')) y = height - padding;
  else y = height / 2;
  return { x, y, align };
}

function drawStyledLine(ctx, text, x, y, style, fontSize) {
  const font = fontFamilyById(style.fontId);
  ctx.font = `${font.weight} ${fontSize}px "${font.family}", sans-serif`;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  if (style.shadowWidth > 0) {
    ctx.fillStyle = style.shadowColor;
    ctx.fillText(text, x + style.shadowWidth, y + style.shadowWidth);
  }
  if (style.strokeOn) {
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.09));
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = style.textColor;
  ctx.fillText(text, x, y);
}

// style: { fontId, textColor, shadowColor, shadowWidth, strokeOn, position }
export function drawTextBlock(ctx, text, canvasWidth, canvasHeight, style) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  if (!lines.length) return;
  const fontSize = Math.round(canvasHeight * (lines.length > 1 ? 0.11 : 0.13));
  const lineHeight = fontSize * 1.28;
  const padding = Math.round(canvasHeight * 0.07);
  const anchor = anchorPoint(style.position || 'bottom-center', canvasWidth, canvasHeight, padding);
  const lineStyle = { ...style, align: anchor.align };

  const totalHeight = lineHeight * lines.length;
  let startY;
  if (style.position?.startsWith('top')) startY = anchor.y + fontSize / 2;
  else if (style.position?.startsWith('bottom')) startY = anchor.y - totalHeight + lineHeight / 2;
  else startY = anchor.y - totalHeight / 2 + lineHeight / 2;

  lines.forEach((line, i) => {
    drawStyledLine(ctx, line, anchor.x, startY + i * lineHeight, lineStyle, fontSize);
  });
}

// badge: { icon, tag, position }
export function drawBrandBadge(ctx, badge, canvasWidth, canvasHeight) {
  if (!badge || (!badge.icon && !badge.tag)) return;
  const position = badge.position || 'bottom-right';
  const padding = Math.round(canvasHeight * 0.035);
  const fontSize = Math.round(canvasHeight * 0.045);
  const label = `${badge.icon || ''} ${badge.tag || ''}`.trim();
  ctx.font = `700 ${fontSize}px "Pretendard", "Malgun Gothic", sans-serif`;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + fontSize * 1.6;
  const boxHeight = fontSize * 1.9;
  const align = wrapAlign(position);
  const x = align === 'left' ? padding : align === 'right' ? canvasWidth - padding - boxWidth : (canvasWidth - boxWidth) / 2;
  const y = position.startsWith('top') ? padding : canvasHeight - padding - boxHeight;

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const radius = boxHeight / 2;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + boxWidth, y, x + boxWidth, y + boxHeight, radius);
  ctx.arcTo(x + boxWidth, y + boxHeight, x, y + boxHeight, radius);
  ctx.arcTo(x, y + boxHeight, x, y, radius);
  ctx.arcTo(x, y, x + boxWidth, y, radius);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + boxWidth / 2, y + boxHeight / 2 + 1);
}

export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('이미지 변환에 실패했습니다.'));
    }, type);
  });
}

export async function downloadCanvas(canvas, filename) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// opts: { width, height, backgroundImage, copyText, textStyle, badge, showBadge }
export async function composeImage(opts) {
  const { width, height, backgroundImage, copyText, textStyle, badge, showBadge = true } = opts;
  await ensureFontsLoaded([textStyle.fontId]);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawBackgroundCover(ctx, backgroundImage, width, height);
  if (copyText) drawTextBlock(ctx, copyText, width, height, textStyle);
  if (showBadge && badge) drawBrandBadge(ctx, badge, width, height);
  return canvas;
}
