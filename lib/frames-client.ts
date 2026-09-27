// Grabs a few small JPEG frames from a clip in the browser, so the title writer can see what the
// clip shows. Returns base64 strings (no "data:" prefix). Formats the browser can't play give [].

export async function captureFrames(url: string, fractions = [0.3, 0.7], width = 384): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await once(video, "loadeddata", 15000);
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return [];
    const scale = Math.min(1, width / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const frames: string[] = [];
    for (const f of fractions) {
      video.currentTime = Math.max(0, Math.min(video.duration - 0.1, video.duration * f));
      await once(video, "seeked", 10000);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.72).split(",")[1] ?? "");
    }
    return frames.filter(Boolean);
  } catch {
    return [];
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

function once(el: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} timed out`));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("video error"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", fail, { once: true });
  });
}
