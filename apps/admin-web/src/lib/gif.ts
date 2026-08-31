import gifshot from 'gifshot';

/**
 * Generate a short looping animated GIF preview from a video file, entirely in the
 * browser (canvas frame sampling — no server-side transcoding). Used as the sample
 * video's thumbnail so pickers can show real motion instead of a single static frame.
 */
export function makeGifFromVideo(
  file: File,
  { width = 320, numFrames = 15 }: { width?: number; numFrames?: number } = {},
): Promise<Blob> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    video.onloadedmetadata = () => {
      const ratio =
        video.videoHeight && video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
      const gifHeight = Math.round(width * ratio);
      gifshot.createGIF(
        {
          video: [url],
          gifWidth: width,
          gifHeight,
          numFrames,
          frameDuration: 2,
          sampleInterval: Math.max(1, Math.round(100 / numFrames)),
          numWorkers: 2,
        },
        (result) => {
          URL.revokeObjectURL(url);
          if (result.error || !result.image) {
            reject(new Error(result.errorMsg || 'Failed to generate GIF preview'));
            return;
          }
          fetch(result.image)
            .then((res) => res.blob())
            .then(resolve)
            .catch(reject);
        },
      );
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read video file'));
    };
  });
}
