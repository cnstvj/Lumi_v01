import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearMovie,
  getChannelState,
  initChannel,
  setActiveMovie,
  subscribeToChannel,
  unsubscribeFromChannel,
  updatePlayback,
  type ChannelState,
} from "./database/channelRepository";
import { calculateDriftCorrection } from "./utils/syncAlgorithm";
import { MsePlayer, transcodeHevcToH264 } from "./utils/wasmPlayer";

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const msePlayerRef = useRef<MsePlayer | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);

  const [channelState, setChannelState] = useState<ChannelState | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ambientColor, setAmbientColor] = useState("rgba(240, 111, 111, 0.12)");
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<number | null>(null);

  // ── Converter States ──
  const [showConverter, setShowConverter] = useState(false);
  const [convertFile, setConvertFile] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [convertError, setConvertError] = useState<string | null>(null);

  // Prevents echo-publishing when we're applying a remote sync update
  const isSyncingRef = useRef(false);
  // Throttles periodic position heartbeats during playback
  const heartbeatRef = useRef(0);

  // Track which movie the partner is watching (so we can prompt to select a local copy)
  const [pendingMovieName, setPendingMovieName] = useState<string | null>(null);

  const videoSrc = useMemo(
    () => (selectedFile ? convertFileSrc(selectedFile) : ""),
    [selectedFile]
  );

  // ── Initialize channel & start real-time subscription ──
  useEffect(() => {
    async function init() {
      try {
        await initChannel();
        let state = await getChannelState();

        // If the state hasn't been updated in over 2 minutes and a movie is
        // still set, the previous session is dead — clear it.
        if (state?.active_movie_name) {
          const ageMs =
            Date.now() - new Date(state.updated_at).getTime();
          if (ageMs > 120_000) {
            await clearMovie();
            state = await getChannelState();
          }
        }

        setChannelState(state);

        // If there's already an active movie, prompt to select a local copy
        if (state?.active_movie_name) {
          setPendingMovieName(state.active_movie_name);
        }

        // Subscribe to real-time updates
        const channel = subscribeToChannel((newState) => {
          setChannelState(newState);
        });
        realtimeChannelRef.current = channel;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize.");
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {
      if (realtimeChannelRef.current) {
        unsubscribeFromChannel(realtimeChannelRef.current);
      }
    };
  }, []);

  // ── React to real-time channel state changes ──
  useEffect(() => {
    if (!channelState || loading) return;

    // If the channel now has a new movie and we haven't selected a file yet, prompt
    if (
      channelState.active_movie_name &&
      channelState.active_movie_name !== pendingMovieName &&
      !selectedFile
    ) {
      setPendingMovieName(channelState.active_movie_name);
    }

    // If movie was cleared, reset everything
    if (!channelState.active_movie_name && (selectedFile || pendingMovieName)) {
      setSelectedFile(null);
      setPendingMovieName(null);
    }
  }, [channelState, loading, selectedFile, pendingMovieName]);

  // ── Sync to remote playback state ──
  useEffect(() => {
    if (!channelState || !videoRef.current || !selectedFile) return;

    const video = videoRef.current;

    const { playbackRate, hardSeek, seekTime } = calculateDriftCorrection(
      channelState.playback_time,
      video.currentTime,
      channelState.playback_rate
    );

    // Mark as syncing so video events don't re-publish our own echo
    isSyncingRef.current = true;

    if (hardSeek && seekTime !== undefined) {
      video.currentTime = seekTime;
    }

    video.playbackRate = playbackRate;

    // Play/Pause propagation
    if (channelState.is_playing && video.paused) {
      video.play().catch(() => undefined);
    }

    if (!channelState.is_playing && !video.paused) {
      video.pause();
    }

    // Clear syncing flag after events have fired
    setTimeout(() => {
      isSyncingRef.current = false;
    }, 300);
  }, [channelState, selectedFile]);

  // ── Instantiation of MsePlayer (WebAssembly HEVC Decoder) when needed ──
  useEffect(() => {
    if (selectedFile && videoRef.current && !checkHevcSupport()) {
      if (msePlayerRef.current) {
        msePlayerRef.current.destroy();
      }
      msePlayerRef.current = new MsePlayer(videoRef.current, selectedFile);
    }

    return () => {
      if (msePlayerRef.current) {
        msePlayerRef.current.destroy();
        msePlayerRef.current = null;
      }
    };
  }, [selectedFile, videoSrc]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const video = videoRef.current;
      if (!video) return;
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === "Space" && selectedFile) {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }

      if (e.key === "ArrowLeft" && selectedFile) {
        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5));
      }

      if (e.key === "ArrowRight" && selectedFile) {
        video.currentTime = Math.min(
          video.duration || video.currentTime,
          video.currentTime + (e.shiftKey ? 30 : 5)
        );
      }

      if (e.key === "ArrowUp") {
        video.volume = Math.min(1, video.volume + 0.05);
      }

      if (e.key === "ArrowDown") {
        video.volume = Math.max(0, video.volume - 0.05);
      }

      if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleSelectMovie();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFile]);

  // ── Cleanup sync timer ──
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  // ── Auto-hide controls ──
  function resetControlsTimer() {
    setControlsVisible(true);

    if (controlsTimerRef.current) {
      window.clearTimeout(controlsTimerRef.current);
    }

    controlsTimerRef.current = window.setTimeout(() => {
      if (selectedFile) {
        setControlsVisible(false);
      }
    }, 3000);
  }

  useEffect(() => {
    function onMove() {
      resetControlsTimer();
    }

    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [selectedFile]);

  // ── File / movie selection (anyone can do this) ──
  async function handleSelectMovie() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "mkv", "avi", "mov", "webm", "hevc", "h265"],
          },
        ],
      });

      if (selected && typeof selected === "string") {
        const movieName = selected.split(/[\\/]/).pop() ?? selected;

        setSelectedFile(selected);
        setPendingMovieName(null);

        // Publish the movie name so the partner knows what to open
        const state = await setActiveMovie(movieName);
        setChannelState(state);

        enterFullscreen();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select movie.");
    }
  }

  // ── Change just the local file (without changing the channel movie name) ──
  async function handleChangeFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "mkv", "avi", "mov", "webm", "hevc", "h265"],
          },
        ],
      });

      if (selected && typeof selected === "string") {
        setSelectedFile(selected);
        enterFullscreen();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select file.");
    }
  }

  // ── Fullscreen ──
  function enterFullscreen() {
    document.documentElement
      .requestFullscreen?.()
      .catch(() => undefined);
  }

  function exitFullscreen() {
    document.exitFullscreen?.().catch(() => undefined);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  // ── Publish playback state (anyone can control) ──
  function publishPlaybackState() {
    if (!videoRef.current || isSyncingRef.current) return;

    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(async () => {
      const video = videoRef.current;
      if (!video || isSyncingRef.current) return;

      await updatePlayback(
        video.currentTime,
        !video.paused,
        video.playbackRate
      );
    }, 180);
  }

  // ── Ambient color ──
  function captureAmbientColor() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    try {
      ctx.drawImage(video, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      setAmbientColor(`rgba(${r}, ${g}, ${b}, 0.2)`);
    } catch {
      // Some codecs block canvas sampling
    }
  }

  // ── Sync status label ──
  function getSyncStatus(): { label: string; className: string } {
    if (selectedFile && channelState?.active_movie_name) {
      return { label: "🔗 Connected", className: "synced" };
    }
    if (pendingMovieName) {
      return { label: "📂 Select File", className: "following" };
    }
    return { label: "⏳ Waiting", className: "following" };
  }

  // ── Converter Actions ──
  async function handleSelectConvertFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "mkv", "avi", "mov", "webm", "hevc", "h265"],
          },
        ],
      });
      if (selected && typeof selected === "string") {
        setConvertFile(selected);
        setConvertError(null);
      }
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : "Failed to select file.");
    }
  }

  async function runTranscode() {
    if (!convertFile) return;
    setConverting(true);
    setConvertProgress(0);
    setConvertError(null);

    try {
      // 1. Read entire file as raw binary via Tauri IPC (fast, zero JSON overhead)
      setConvertProgress(5);
      const arrayBuffer = await invoke<ArrayBuffer>("read_file_all", { path: convertFile });
      setConvertProgress(15);

      // 2. Perform transcoding
      const transcodedBytes = await transcodeHevcToH264(arrayBuffer, (p) => {
        // Map transcoding progress to 15% - 100%
        setConvertProgress(15 + Math.round((p / 100) * 85));
      });

      const originalName = convertFile.split(/[\\/]/).pop() || "movie";
      const baseName = originalName.substring(0, originalName.lastIndexOf(".")) || originalName;
      const downloadName = `${baseName}_converted.mp4`;

      const blob = new Blob([transcodedBytes], { type: "video/mp4" });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = downloadName;
      link.click();
      URL.revokeObjectURL(downloadUrl);

      setConvertFile(null);
      setShowConverter(false);
      alert(`Success! Saved converted movie as: ${downloadName}`);
    } catch (err) {
      console.error(err);
      setConvertError(err instanceof Error ? err.message : "Conversion failed.");
    } finally {
      setConverting(false);
    }
  }

  const syncStatus = getSyncStatus();

  // ── Render ──

  if (loading) {
    return (
      <main className="emergency-shell">
        <div className="emergency-loading">
          <div className="spinner" />
          <p>Connecting to channel...</p>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`emergency-shell ${selectedFile ? "ambient-active" : ""} ${
        controlsVisible ? "controls-visible" : ""
      }`}
      style={{ "--ambient-color": ambientColor } as CSSProperties}
      onMouseMove={resetControlsTimer}
    >
      {/* ── Top Bar ── */}
      <div className="emergency-topbar">
        <div className="emergency-topbar-left">
          <span className="emergency-topbar-brand">Lumi Emergency</span>
          <span className="emergency-topbar-title">
            {channelState?.active_movie_name ?? ""}
          </span>
        </div>

        <div className="emergency-topbar-right" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            className="toolbar-btn"
            style={{ margin: 0, padding: "6px 12px", fontSize: "0.85rem" }}
            onClick={() => setShowConverter(true)}
          >
            ⚡ Convert HEVC
          </button>
          <span className={`sync-pill ${syncStatus.className}`}>
            {syncStatus.label}
          </span>
        </div>
      </div>

      {/* ── Player ── */}
      {selectedFile ? (
        <div className="emergency-player">
          <video
            ref={videoRef}
            src={checkHevcSupport() ? videoSrc : undefined}
            controls
            onPlay={publishPlaybackState}
            onPause={publishPlaybackState}
            onSeeked={publishPlaybackState}
            onRateChange={publishPlaybackState}
            onTimeUpdate={() => {
              captureAmbientColor();
              // Periodic position heartbeat (every 5 s) for late-joining partners
              const now = Date.now();
              if (!isSyncingRef.current && now - heartbeatRef.current > 5000) {
                heartbeatRef.current = now;
                publishPlaybackState();
              }
            }}
            onError={() => {
              const video = videoRef.current;
              if (video && video.error) {
                const isHevcExtension = selectedFile?.toLowerCase().match(/\.(hevc|h265)$/);
                const hasNoHevcSupport = !checkHevcSupport();
                
                if (hasNoHevcSupport && (isHevcExtension || video.error.code === 4)) {
                  setError(
                    "HEVC (H.265) playback is not supported by your system's WebView2. " +
                    "To enable playback, please install the 'HEVC Video Extensions' from the Microsoft Store " +
                    "and verify hardware acceleration is enabled."
                  );
                } else {
                  setError(`Playback error: ${video.error.message || "Failed to load/play video."}`);
                }
              }
            }}
          />
        </div>
      ) : pendingMovieName ? (
        /* ── Partner started a movie — select your local copy ── */
        <div className="emergency-empty animate-fade-in">
          <span className="emergency-empty-icon">🎬</span>
          <h1>Your partner started a movie</h1>
          <p className="partner-movie-name">"{pendingMovieName}"</p>
          <p>Select your local copy of this file to sync up.</p>

          <button
            className="open-movie-button animate-glow"
            onClick={handleChangeFile}
          >
            <span className="open-movie-button-icon">📂</span>
            Select Your Copy
          </button>
        </div>
      ) : (
        <div className="emergency-empty animate-fade-in">
          <span className="emergency-empty-icon">🎬</span>
          <h1>Ready to watch</h1>
          <p>Open a movie file to start watching. Your partner will automatically sync.</p>

          <button className="open-movie-button animate-glow" onClick={handleSelectMovie}>
            <span className="open-movie-button-icon">▶</span>
            Open Movie
          </button>

          <div className="or-waiting">or</div>

          <div className="waiting-hint">
            <span className="waiting-dot" />
            Waiting for your partner to start a movie...
          </div>
        </div>
      )}

      {/* ── Bottom Toolbar ── */}
      {selectedFile && (
        <div className="emergency-toolbar">
          <button className="toolbar-btn" onClick={handleChangeFile}>
            📂 Change File
          </button>

          <button className="toolbar-btn" onClick={handleSelectMovie}>
            🎬 Change Movie
          </button>

          <button className="toolbar-btn" onClick={toggleFullscreen}>
            ⛶ Fullscreen
          </button>
        </div>
      )}

      {/* ── Errors ── */}
      {error && (
        <div style={{ position: "fixed", top: 80, left: 24, right: 24, zIndex: 200 }}>
          <div className="error-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{
                background: "none",
                border: "none",
                color: "#ffd8d8",
                fontSize: "1.2rem",
                cursor: "pointer",
                marginLeft: "12px",
                padding: "0 4px",
                lineHeight: 1,
              }}
            >
              &times;
            </button>
          </div>
        </div>
      )}
      {/* ── Converter Modal ── */}
      {showConverter && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0, 0, 0, 0.8)",
          backdropFilter: "blur(8px)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 300,
        }}>
          <div style={{
            background: "#16131c",
            border: "1px solid rgba(240, 111, 111, 0.2)",
            borderRadius: "12px",
            padding: "24px",
            width: "480px",
            maxWidth: "90%",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            position: "relative",
          }}>
            <button
              onClick={() => {
                if (!converting) {
                  setShowConverter(false);
                  setConvertFile(null);
                  setConvertProgress(0);
                  setConvertError(null);
                }
              }}
              style={{
                position: "absolute",
                top: "16px",
                right: "16px",
                background: "none",
                border: "none",
                color: "#ffd8d8",
                fontSize: "1.5rem",
                cursor: "pointer",
              }}
              disabled={converting}
            >
              &times;
            </button>

            <h2 style={{ color: "#ffd8d8", marginTop: 0, marginBottom: "16px", fontSize: "1.4rem" }}>
              Local HEVC to H.264 Converter
            </h2>
            <p style={{ color: "#a5a2b0", fontSize: "0.9rem", lineHeight: 1.4, marginBottom: "20px" }}>
              Convert Apple HEVC or H.265 videos into high-performance, universally compatible H.264 MP4 files right inside the app.
            </p>

            {!convertFile ? (
              <div
                style={{
                  border: "2px dashed rgba(240, 111, 111, 0.3)",
                  borderRadius: "8px",
                  padding: "40px 20px",
                  textAlign: "center",
                  cursor: "pointer",
                  background: "rgba(240, 111, 111, 0.02)",
                  transition: "border-color 0.2s",
                }}
                onClick={handleSelectConvertFile}
              >
                <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "12px" }}>🎬</span>
                <span style={{ color: "#ffd8d8", fontWeight: "bold" }}>Choose an HEVC Movie File</span>
                <span style={{ display: "block", color: "#6a6676", fontSize: "0.8rem", marginTop: "4px" }}>
                  Supports .mp4, .mkv, .hevc, .h265, .mov
                </span>
              </div>
            ) : (
              <div>
                <div style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: "6px",
                  padding: "12px",
                  marginBottom: "20px",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}>
                  <span style={{ fontSize: "1.5rem" }}>📄</span>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    <div style={{ color: "#ffd8d8", fontSize: "0.9rem", fontWeight: "bold" }}>
                      {convertFile.split(/[\\/]/).pop()}
                    </div>
                    <div style={{ color: "#6a6676", fontSize: "0.75rem" }}>{convertFile}</div>
                  </div>
                </div>

                {converting ? (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#ffd8d8", fontSize: "0.85rem", marginBottom: "8px" }}>
                      <span>Transcoding video...</span>
                      <span>{convertProgress}%</span>
                    </div>
                    <div style={{
                      height: "8px",
                      background: "rgba(255, 255, 255, 0.08)",
                      borderRadius: "4px",
                      overflow: "hidden",
                      marginBottom: "20px",
                    }}>
                      <div style={{
                        height: "100%",
                        width: `${convertProgress}%`,
                        background: "linear-gradient(90deg, #f06f6f, #ff9e9e)",
                        borderRadius: "4px",
                        transition: "width 0.1s linear",
                      }} />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                    <button
                      className="toolbar-btn"
                      onClick={() => setConvertFile(null)}
                      style={{ margin: 0 }}
                    >
                      Clear Selection
                    </button>
                    <button
                      className="open-movie-button animate-glow"
                      onClick={runTranscode}
                      style={{ margin: 0, padding: "8px 20px" }}
                    >
                      Start Conversion
                    </button>
                  </div>
                )}
              </div>
            )}

            {convertError && (
              <div style={{
                marginTop: "16px",
                padding: "10px 12px",
                background: "rgba(193, 52, 52, 0.12)",
                border: "1px solid rgba(193, 52, 52, 0.25)",
                borderRadius: "6px",
                color: "#ffd8d8",
                fontSize: "0.85rem",
              }}>
                {convertError}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function checkHevcSupport(): boolean {
  try {
    const video = document.createElement("video");
    const mp4Hevc = video.canPlayType('video/mp4; codecs="hvc1"');
    const mp4Hev = video.canPlayType('video/mp4; codecs="hev1"');
    return (
      mp4Hevc === "probably" ||
      mp4Hevc === "maybe" ||
      mp4Hev === "probably" ||
      mp4Hev === "maybe"
    );
  } catch {
    return false;
  }
}
