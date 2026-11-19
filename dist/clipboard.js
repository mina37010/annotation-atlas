export async function imagePNG(url) {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を変換できません。');
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('画像を変換できません。')), 'image/png'));
  } finally { bitmap.close(); }
}

export function copyImage(url) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('このブラウザでは画像をコピーできません。');
  // Start the clipboard write during the click, retaining Safari's user activation.
  const png = imagePNG(url);
  png.catch(() => {});
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function copyURL(url) {
  if (!navigator.clipboard?.writeText) throw new Error('このブラウザではURLをコピーできません。');
  return navigator.clipboard.writeText(url);
}
