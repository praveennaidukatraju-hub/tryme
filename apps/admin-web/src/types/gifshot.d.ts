declare module 'gifshot' {
  interface CreateGifOptions {
    video?: (string | HTMLVideoElement)[];
    gifWidth?: number;
    gifHeight?: number;
    numFrames?: number;
    frameDuration?: number;
    sampleInterval?: number;
    numWorkers?: number;
  }

  interface CreateGifResult {
    error: boolean;
    errorCode?: string;
    errorMsg?: string;
    image?: string;
  }

  interface Gifshot {
    createGIF(options: CreateGifOptions, callback: (result: CreateGifResult) => void): void;
  }

  const gifshot: Gifshot;
  export default gifshot;
}
