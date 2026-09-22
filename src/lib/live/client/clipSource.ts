// Whole clip in memory before it plays: a streamed <video> rebuffers whenever the CDN read falls behind playback, which froze clips mid-play.
export const fetchClipSource = async (
  url: string,
  timeoutMs: number,
): Promise<string> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return url;
    }
    return URL.createObjectURL(await response.blob());
  } catch {
    // Streaming the URL directly still plays; it only loses the stall protection.
    return url;
  }
};

export const releaseClipSource = (src: string): void => {
  if (src.startsWith("blob:")) {
    URL.revokeObjectURL(src);
  }
};
