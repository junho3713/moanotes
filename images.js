const maxSourceBytes = 30 * 1024 * 1024;
export const maxPhotoBytes = 500 * 1024;
export const maxThumbnailBytes = 9 * 1024;
const imagePrefix = /^data:(image\/(?:webp|jpeg));base64,/u;

export function photoParts(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 + 32) return null;
  const prefix = imagePrefix.exec(value);
  if (!prefix) return null;
  const base64 = value.slice(prefix[0].length);
  if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return null;
  const size = base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : Number(base64.endsWith("=")));
  return size > 0 && size <= maxBytes ? { mime: prefix[1], base64, size } : null;
}

function openSource(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, dispose: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("사진을 열 수 없어요. JPG, PNG 또는 WebP 파일을 선택해 주세요."));
    };
    image.src = url;
  });
}

function encode(canvas, mime, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function fitImage(image, edge, maxPixels, maxBytes, qualities) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("이 브라우저에서 사진을 처리할 수 없어요.");
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  let scale = Math.min(1, edge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  let mime = "image/webp";
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        let blob = await encode(canvas, mime, quality);
        if (mime === "image/webp" && blob?.type !== mime) {
          mime = "image/jpeg";
          blob = await encode(canvas, mime, quality);
        }
        if (blob?.type === mime && blob.size > 0 && blob.size <= maxBytes) return blob;
      }
      scale *= 0.8;
    }
    throw new Error("사진을 저장할 크기로 줄이기 어려워요. 더 작은 사진을 골라 주세요.");
  } finally {
    canvas.width = canvas.height = 1;
  }
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("사진을 읽을 수 없어요."));
    reader.readAsDataURL(blob);
  });
}

export async function preparePhoto(file) {
  if ((file.type && !file.type.startsWith("image/")) || file.type === "image/svg+xml"
    || /\.svgz?$/iu.test(file.name)) {
    throw new Error("JPG, PNG 또는 WebP 같은 사진 파일을 선택해 주세요.");
  }
  if (file.size > maxSourceBytes) throw new Error("30MB 이하 사진을 선택해 주세요.");
  const source = await openSource(file);
  try {
    const full = await fitImage(source.image, 3200, 6000000, maxPhotoBytes, [0.88, 0.76]);
    const thumbnail = await fitImage(source.image, 320, 102400, maxThumbnailBytes, [0.77, 0.64]);
    return { data: await toDataUrl(full), thumbnail: await toDataUrl(thumbnail), size: full.size };
  } finally {
    source.dispose();
  }
}
