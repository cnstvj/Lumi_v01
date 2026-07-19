import { installMSEIntercept, SegmentTranscoder } from "@hevcjs/core";
import * as MP4Box from "mp4box";
import { invoke } from "@tauri-apps/api/core";

let mseInstalled = false;

export function initMse(): void {
  if (!mseInstalled) {
    installMSEIntercept({
      workerUrl: "/transcode-worker.js",
      wasmUrl: "/wasm/hevc-decode.js",
    });
    mseInstalled = true;
  }
}

export class MsePlayer {
  private video: HTMLVideoElement;
  private filePath: string;
  private mediaSource: MediaSource;
  private mp4boxfile: any;
  private sourceBuffers: Record<number, SourceBuffer> = {};
  private abortController: AbortController | null = null;
  private queueMap: Record<number, ArrayBuffer[]> = {};

  constructor(video: HTMLVideoElement, filePath: string) {
    this.video = video;
    this.filePath = filePath;
    this.mediaSource = new MediaSource();
    this.mp4boxfile = MP4Box.createFile();

    initMse();

    this.video.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener("sourceopen", this.onSourceOpen.bind(this));
  }

  private async onSourceOpen() {
    this.mp4boxfile.onReady = (info: any) => {
      console.log("MP4Box file ready:", info);

      for (const track of info.tracks) {
        // Map audio track type
        const type = track.type === "video" ? "video" : "audio";
        const codec = `${type}/mp4; codecs="${track.codec}"`;
        try {
          const sb = this.mediaSource.addSourceBuffer(codec);
          this.sourceBuffers[track.id] = sb;
          this.queueMap[track.id] = [];
          this.mp4boxfile.setSegmentOptions(track.id, sb, { nbSamples: 100 });

          sb.addEventListener("updateend", () => {
            const queue = this.queueMap[track.id];
            if (queue && queue.length > 0 && !sb.updating) {
              const next = queue.shift();
              if (next) sb.appendBuffer(next);
            }
          });
        } catch (err) {
          console.error(`Failed to add source buffer for track ${track.id} (${codec}):`, err);
        }
      }

      const initSegs = this.mp4boxfile.initializeSegmentation();
      if (initSegs) {
        for (const initSeg of initSegs) {
          const sb = this.sourceBuffers[initSeg.id];
          if (sb) {
            if (!sb.updating) {
              sb.appendBuffer(initSeg.data);
            } else {
              this.queueMap[initSeg.id].push(initSeg.data);
            }
          }
        }
      }

      this.mp4boxfile.start();
    };

    this.mp4boxfile.onSegment = (id: number, sb: SourceBuffer, buffer: ArrayBuffer) => {
      if (sb) {
        if (!sb.updating && this.queueMap[id].length === 0) {
          sb.appendBuffer(buffer);
        } else {
          this.queueMap[id].push(buffer);
        }
      }
    };

    this.startStreaming();
  }

  private async startStreaming() {
    this.abortController = new AbortController();
    try {
      const size = await invoke<number>("get_file_size", { path: this.filePath });
      const chunkSize = 8 * 1024 * 1024; // 8 MB chunks (raw binary via IPC, fast)
      let offset = 0;

      while (offset < size) {
        if (this.abortController.signal.aborted) break;

        const chunk = await invoke<ArrayBuffer>("read_file_chunk", {
          path: this.filePath,
          offset,
          size: Math.min(chunkSize, size - offset),
        });

        const buffer = chunk.slice(0) as any; // ensure ownership
        buffer.fileStart = offset;

        this.mp4boxfile.appendBuffer(buffer);
        offset += chunk.byteLength;
      }

      // Wait for all buffers to finish appending before ending stream
      setTimeout(() => {
        if (this.mediaSource.readyState === "open") {
          try {
            this.mediaSource.endOfStream();
          } catch (e) {}
        }
      }, 1000);
    } catch (err) {
      console.error("Streaming interrupted:", err);
    }
  }

  public destroy() {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch (e) {}
    }
    this.video.src = "";
  }
}

export async function transcodeHevcToH264(
  arrayBuffer: ArrayBuffer,
  onProgress: (p: number) => void
): Promise<Uint8Array> {
  const mp4boxfile = MP4Box.createFile();
  const transcoder = new SegmentTranscoder({
    wasmUrl: "/wasm/hevc-decode.js",
  });
  await transcoder.init();

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let videoTrack: any = null;
    let totalSamples = 0;
    let processedSamples = 0;

    mp4boxfile.onReady = async (info: any) => {
      videoTrack = info.tracks.find((t: any) => t.type === "video");
      if (!videoTrack) {
        reject(new Error("No video track found in the input file."));
        return;
      }

      totalSamples = videoTrack.nb_samples;
      mp4boxfile.setSegmentOptions(videoTrack.id, null, { nbSamples: 100 });
      
      const initSegs = mp4boxfile.initializeSegmentation() as any;
      if (initSegs && initSegs[0]) {
        await transcoder.processInitSegment(initSegs[0].data);
      }
      mp4boxfile.start();
    };

    mp4boxfile.onSegment = async (_id: number, _user: any, buffer: ArrayBuffer, sampleNum: number) => {
      try {
        const h264Seg = await transcoder.processMediaSegment(new Uint8Array(buffer));
        if (h264Seg) {
          if (chunks.length === 0 && transcoder.initResult) {
            chunks.push(transcoder.initResult.initSegment);
          }
          chunks.push(h264Seg);
        }
        processedSamples += sampleNum;
        onProgress(Math.min(100, Math.round((processedSamples / totalSamples) * 100)));
      } catch (err) {
        reject(err);
      }
    };

    // Feed buffer to mp4box synchronously
    try {
      (arrayBuffer as any).fileStart = 0;
      mp4boxfile.appendBuffer(arrayBuffer as any);
      mp4boxfile.flush();

      // Transcode remaining buffered frames
      transcoder.flush().then((remaining) => {
        if (remaining) {
          chunks.push(remaining);
        }
        transcoder.destroy();

        // Concatenate all chunks into single file buffer
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      }).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}
