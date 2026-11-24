// Browser only: photos are downscaled here so the box never holds a full-size phone photo (V8 Decision 5).
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const ATTEMPTS = [{ side: PHOTO_MAX_SIDE, quality: 0.85 }, { side: PHOTO_MAX_SIDE, quality: 0.7 }, { side: 1200, quality: 0.7 }];

export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const stem = (name: string) => name.replace(/\.[^.]*$/, "");
export const jpegName = (name: string) => `${stem(name).slice(0, 190) || "photo"}.jpg`;
export const photoTitle = (name: string) => stem(name).replace(/[_-]+/g, " ").trim().slice(0, 200) || "Photo";

export function blobBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("The file could not be read."));
        reader.readAsDataURL(blob);
    });
}

/** A JPEG of at most 1600 px a side and 2 MB, turned upright from the photo's orientation tag. */
export async function preparePhoto(file: Blob, name: string): Promise<{ name: string; base64: string; size: number }> {
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { throw new Error("This photo could not be opened in this browser. Choose a JPEG, PNG or WebP photo."); }
    try {
        for (const attempt of ATTEMPTS) {
            const size = scaledSize(bitmap.width, bitmap.height, attempt.side);
            const canvas = document.createElement("canvas");
            canvas.width = size.width; canvas.height = size.height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("This browser cannot resize photos.");
            // JPEG has no transparency; without a fill, clear parts of a PNG turn black.
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, size.width, size.height);
            context.drawImage(bitmap, 0, 0, size.width, size.height);
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", attempt.quality));
            canvas.width = 0; canvas.height = 0;
            if (blob && blob.size <= PHOTO_MAX_BYTES) return { name: jpegName(name), base64: await blobBase64(blob), size: blob.size };
        }
    } finally { bitmap.close(); }
    throw new Error("This photo is still over 2 MB after resizing. Choose a smaller photo.");
}
