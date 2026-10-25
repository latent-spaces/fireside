// Images you paste, drop or pick for a message. Each is read in the page and
// sent with the message as base64; a large one is scaled down first, so a few
// screenshots still fit in one request and under what the agent accepts.

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const KEEP = 1.5 * 1024 * 1024;   // smaller than this goes as it is
const EDGE = 2000;                 // the long side a larger one is scaled to
export const BUDGET = 7 * 1024 * 1024;   // base64 per message, under the server's limit

export const imageFiles = (list) => [...list || []].filter((f) => f.type?.startsWith('image/'));

const dataURL = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** A file as { data, mimeType, url }, or throws saying why it can't be sent. */
export async function readImage(file) {
  if (file.size <= KEEP && TYPES.includes(file.type)) {
    const url = await dataURL(file);
    return { data: url.slice(url.indexOf(',') + 1), mimeType: file.type, url };
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name || 'That image'} could not be read`); });
  const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // A screenshot stays sharp as PNG when that is small enough; a photo goes as JPEG.
  let url = canvas.toDataURL('image/png');
  if (url.length > KEEP * 1.37) url = canvas.toDataURL('image/jpeg', 0.88);
  return { data: url.slice(url.indexOf(',') + 1), mimeType: url.slice(5, url.indexOf(';')), url };
}
