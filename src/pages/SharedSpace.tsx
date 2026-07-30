import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import {
  addWatchHistory,
  getRoomParticipants,
  getRoomState,
  joinRoom,
  updateActiveMovie,
  updatePlaybackState,
  updateReadyState,
  type RoomParticipant,
  type RoomState,
} from "../database/roomRepository";
import {
  getChannelState,
  initChannel,
  setActiveMovie as setChannelMovie,
  subscribeToChannel,
  unsubscribeFromChannel,
  updatePlayback as updateChannelPlayback,
  type ChannelState,
} from "../database/channelRepository";
import { useLocalMedia } from "../hooks/useLocalMedia";
import { useAuthStore } from "../stores/authStore";
import { calculateDriftCorrection } from "../utils/syncAlgorithm";
import { MsePlayer, transcodeHevcToH264 } from "../utils/wasmPlayer";

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
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

export default function SharedSpace() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { roomCode } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const msePlayerRef = useRef<MsePlayer | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const historySavedRef = useRef(false);
  const media = useLocalMedia();
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);
  const isSyncingRef = useRef(false);
  const heartbeatRef = useRef(0);

  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [channelState, setChannelState] = useState<ChannelState | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ambientColor, setAmbientColor] = useState("rgba(240, 111, 111, 0.12)");
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<number | null>(null);
  const [pendingMovieName, setPendingMovieName] = useState<string | null>(null);

  // ── Converter States ──
  const [showConverter, setShowConverter] = useState(false);
  const [convertFile, setConvertFile] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [convertError, setConvertError] = useState<string | null>(null);

  const isHost = Boolean(
    user && participants.find((p) => p.id === user.id)?.isHost
  );

  const videoSrc = useMemo(
    () => (selectedFile ? convertFileSrc(selectedFile) : ""),
    [selectedFile]
  );

  // ── Join room & load state ──
  async function loadRoom() {
    if (!roomCode || !user?.email) {
      setError("Missing room code.");
      setLoading(false);
      return;
    }

    try {
      const joined = await joinRoom(roomCode.toUpperCase(), user.email);

      if (!joined) {
        setError("Room not found.");
        setLoading(false);
        return;
      }

      const [state, nextParticipants] = await Promise.all([
        getRoomState(joined.room_code),
        getRoomParticipants(joined.room_code),
      ]);

      setRoomState(state);
      setParticipants(nextParticipants);
      setSelectedFile(state?.active_movie ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load room.");
    } finally {
      setLoading(false);
    }
  }

  // ── Initialize room + Supabase real-time subscription ──
  useEffect(() => {
    async function init() {
      await loadRoom();

      // Also initialize Supabase channel for real-time sync
      try {
        await initChannel();
        const state = await getChannelState();
        setChannelState(state);

        if (state?.active_movie_name && !selectedFile) {
          setPendingMovieName(state.active_movie_name);
        }

        const channel = subscribeToChannel((newState) => {
          setChannelState(newState);
        });
        realtimeChannelRef.current = channel;
      } catch (err) {
        console.warn("Supabase channel init failed (falling back to local):", err);
      }
    }

    init();

    // Poll room state for local DB updates
    const interval = window.setInterval(loadRoom, 2000);

    return () => {
      window.clearInterval(interval);
      if (realtimeChannelRef.current) {
        unsubscribeFromChannel(realtimeChannelRef.current);
      }
    };
  }, [roomCode, user?.email]);

  // ── React to Supabase channel state changes ──
  useEffect(() => {
    if (!channelState || loading) return;

    if (
      channelState.active_movie_name &&
      channelState.active_movie_name !== pendingMovieName &&
      !selectedFile
    ) {
      setPendingMovieName(channelState.active_movie_name);
    }

    if (!channelState.active_movie_name && (selectedFile || pendingMovieName)) {
      setSelectedFile(null);
      setPendingMovieName(null);
    }
  }, [channelState, loading, selectedFile, pendingMovieName]);

  // ── Sync to remote playback state (Supabase real-time) ──
  useEffect(() => {
    if (!channelState || !videoRef.current || !selectedFile) return;

    const video = videoRef.current;

    const { playbackRate, hardSeek, seekTime } = calculateDriftCorrection(
      channelState.playback_time,
      video.currentTime,
      channelState.playback_rate
    );

    isSyncingRef.current = true;

    if (hardSeek && seekTime !== undefined) {
      video.currentTime = seekTime;
    }

    video.playbackRate = playbackRate;

    if (channelState.is_playing && video.paused) {
      video.play().catch(() => undefined);
    }

    if (!channelState.is_playing && !video.paused) {
      video.pause();
    }

    setTimeout(() => {
      isSyncingRef.current = false;
    }, 300);
  }, [channelState, selectedFile]);

  // ── Also sync from local room state (for host/follower model) ──
  useEffect(() => {
    if (!roomState || !videoRef.current || isHost) return;

    const video = videoRef.current;

    const { playbackRate, hardSeek, seekTime } = calculateDriftCorrection(
      roomState.playback_time,
      video.currentTime,
      roomState.playback_rate
    );

    if (hardSeek && seekTime !== undefined) {
      video.currentTime = seekTime;
    }

    video.playbackRate = playbackRate;

    if (roomState.is_playing && video.paused) {
      video.play().catch(() => undefined);
    }

    if (!roomState.is_playing && !video.paused) {
      video.pause();
    }
  }, [roomState, isHost]);

  // ── HEVC MsePlayer instantiation ──
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

      if (e.code === "Space" && (isHost || selectedFile)) {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }

      if (e.key === "ArrowLeft" && (isHost || selectedFile)) {
        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5));
      }

      if (e.key === "ArrowRight" && (isHost || selectedFile)) {
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

      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        media.toggleMicrophone();
      }

      if (e.ctrlKey && e.key.toLowerCase() === "e") {
        media.toggleCamera();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o" && isHost) {
        e.preventDefault();
        handleSelectMovie();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isHost, media.cameraEnabled, media.microphoneEnabled, selectedFile, roomCode]);

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

  // ── Movie selection ──
  async function handleSelectMovie() {
    try {
      if (!isHost) {
        setError("Only the host can choose the shared movie.");
        return;
      }

      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "mkv", "avi", "mov", "webm", "hevc", "h265"],
          },
        ],
      });

      if (selected && typeof selected === "string" && roomCode) {
        historySavedRef.current = false;
        setSelectedFile(selected);
        setPendingMovieName(null);

        // Update local room state
        const state = await updateActiveMovie(roomCode.toUpperCase(), selected);
        setRoomState(state);

        // Also publish to Supabase channel
        const movieName = selected.split(/[\\/]/).pop() ?? selected;
        const channelSt = await setChannelMovie(movieName);
        setChannelState(channelSt);

        enterFullscreen();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select movie.");
    }
  }

  // ── Change just the local file ──
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
        setPendingMovieName(null);
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

  // ── Publish playback state (to both local DB and Supabase) ──
  function publishPlaybackState() {
    if (!videoRef.current || isSyncingRef.current) return;

    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(async () => {
      const video = videoRef.current;
      if (!video || isSyncingRef.current) return;

      // Update local room state
      if (roomCode && isHost) {
        const state = await updatePlaybackState(
          roomCode.toUpperCase(),
          video.currentTime,
          !video.paused,
          video.playbackRate
        );
        setRoomState(state);
      }

      // Also update Supabase channel
      await updateChannelPlayback(
        video.currentTime,
        !video.paused,
        video.playbackRate
      );
    }, 180);
  }

  // ── Watch history on end ──
  async function handleEnded() {
    if (!roomCode || !user || !videoRef.current || historySavedRef.current) return;

    historySavedRef.current = true;
    await addWatchHistory(roomCode.toUpperCase(), user.id, videoRef.current.currentTime);
    await publishPlaybackState();
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

  // ── Ready toggle ──
  async function handleReady() {
    if (!roomCode || !user) return;

    const current = participants.find((p) => p.id === user.id);
    await updateReadyState(roomCode.toUpperCase(), user.id, !current?.isReady);
    await loadRoom();
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
      setConvertProgress(5);
      const arrayBuffer = await invoke<ArrayBuffer>("read_file_all", { path: convertFile });
      setConvertProgress(15);

      const transcodedBytes = await transcodeHevcToH264(arrayBuffer, (p) => {
        setConvertProgress(15 + Math.round((p / 100) * 85));
      });

      const originalName = convertFile.split(/[\\/]/).pop() || "movie";
      const baseName = originalName.substring(0, originalName.lastIndexOf(".")) || originalName;
      const downloadName = `${baseName}_converted.mp4`;

      const blob = new Blob([transcodedBytes as any], { type: "video/mp4" });
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

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const allReady =
    participants.length > 0 &&
    participants.every((p) => p.isReady);

  return (
    <main
      className={`shared-space-shell ${selectedFile ? "ambient-active" : ""} ${
        controlsVisible ? "controls-visible" : ""
      }`}
      style={{ "--ambient-color": ambientColor } as CSSProperties}
      onMouseMove={resetControlsTimer}
    >
      {/* ── Top Bar ── */}
      <div className="shared-space-topbar">
        <div className="shared-space-topbar-left">
          <button
            className="toolbar-btn"
            onClick={() => {
              exitFullscreen();
              navigate("/home");
            }}
          >
            ← Exit
          </button>

          <span className="shared-space-topbar-title">
            {roomState?.active_movie_name ?? channelState?.active_movie_name ?? "Shared Space"}
          </span>
        </div>

        <div className="shared-space-topbar-right">
          <button
            className="toolbar-btn"
            style={{ margin: 0, padding: "6px 12px", fontSize: "0.85rem" }}
            onClick={() => setShowConverter(true)}
          >
            ⚡ Convert HEVC
          </button>
          <span className="sync-pill">
            {isHost ? "Host" : "Following host"}
            {" · "}
            {allReady ? "Ready" : "Waiting"}
          </span>
        </div>
      </div>

      {/* ── Player ── */}
      {loading ? (
        <div className="shared-space-empty">
          <p>Loading shared space...</p>
        </div>
      ) : selectedFile ? (
        <div className="shared-space-player">
          <video
            ref={videoRef}
            src={checkHevcSupport() ? videoSrc : undefined}
            controls={isHost}
            onPlay={publishPlaybackState}
            onPause={publishPlaybackState}
            onSeeked={publishPlaybackState}
            onRateChange={publishPlaybackState}
            onTimeUpdate={() => {
              captureAmbientColor();
              const now = Date.now();
              if (!isSyncingRef.current && now - heartbeatRef.current > 5000) {
                heartbeatRef.current = now;
                publishPlaybackState();
              }
            }}
            onEnded={handleEnded}
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
        <div className="shared-space-empty animate-fade-in">
          <span className="shared-space-empty-icon">🎬</span>
          <h1 style={{ fontSize: "1.6rem", color: "var(--text-primary)" }}>Your partner started a movie</h1>
          <p className="partner-movie-name">"{pendingMovieName}"</p>
          <p>Select your local copy of this file to sync up.</p>
          <button className="primary-button animate-glow" onClick={handleChangeFile}>
            📂 Select Your Copy
          </button>
        </div>
      ) : (
        <div className="shared-space-empty">
          <span className="shared-space-empty-icon">🎬</span>
          <p>
            {isHost
              ? "Select a movie to start watching together"
              : "Waiting for host to select a movie..."}
          </p>
          {isHost && (
            <button className="primary-button" onClick={handleSelectMovie}>
              Open Movie File
            </button>
          )}
        </div>
      )}

      {/* ── PiP Participants ── */}
      <div className="pip-container">
        {participants.map((p) => (
          <PipTile
            key={p.id}
            displayName={p.displayName}
            isLocal={p.id === user.id}
            cameraEnabled={p.id === user.id ? media.cameraEnabled : false}
            stream={p.id === user.id ? media.stream : null}
          />
        ))}
      </div>

      {/* ── Bottom Toolbar ── */}
      <div className="shared-space-toolbar">
        {isHost && (
          <button className="toolbar-btn" onClick={handleSelectMovie}>
            🎬 {selectedFile ? "Change" : "Open"} Movie
          </button>
        )}

        {selectedFile && !isHost && (
          <button className="toolbar-btn" onClick={handleChangeFile}>
            📂 Change File
          </button>
        )}

        <button
          className={`toolbar-btn ${media.microphoneEnabled ? "active" : ""}`}
          onClick={media.toggleMicrophone}
        >
          🎤 {media.microphoneEnabled ? "Mute" : "Mic On"}
        </button>

        <button
          className={`toolbar-btn ${media.cameraEnabled ? "active" : ""}`}
          onClick={media.toggleCamera}
        >
          📷 {media.cameraEnabled ? "Cam Off" : "Cam On"}
        </button>

        <button
          className={`toolbar-btn ${
            participants.find((p) => p.id === user.id)?.isReady ? "active" : ""
          }`}
          onClick={handleReady}
        >
          ✓ {participants.find((p) => p.id === user.id)?.isReady ? "Ready" : "Not Ready"}
        </button>

        <button className="toolbar-btn" onClick={toggleFullscreen}>
          ⛶ Fullscreen
        </button>
      </div>

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
      {media.error && (
        <div style={{ position: "fixed", top: 120, left: 24, right: 24, zIndex: 200 }}>
          <div className="error-card">{media.error}</div>
        </div>
      )}

      {/* ── Converter Modal ── */}
      {showConverter && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0, 0, 0, 0.8)", backdropFilter: "blur(8px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 300,
        }}>
          <div style={{
            background: "#16131c", border: "1px solid rgba(240, 111, 111, 0.2)",
            borderRadius: "12px", padding: "24px", width: "480px", maxWidth: "90%",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)", position: "relative",
          }}>
            <button
              onClick={() => {
                if (!converting) {
                  setShowConverter(false); setConvertFile(null);
                  setConvertProgress(0); setConvertError(null);
                }
              }}
              style={{
                position: "absolute", top: "16px", right: "16px", background: "none",
                border: "none", color: "#ffd8d8", fontSize: "1.5rem", cursor: "pointer",
              }}
              disabled={converting}
            >
              &times;
            </button>

            <h2 style={{ color: "#ffd8d8", marginTop: 0, marginBottom: "16px", fontSize: "1.4rem" }}>
              Local HEVC to H.264 Converter
            </h2>
            <p style={{ color: "#a5a2b0", fontSize: "0.9rem", lineHeight: 1.4, marginBottom: "20px" }}>
              Convert Apple HEVC or H.265 videos into universally compatible H.264 MP4 files.
            </p>

            {!convertFile ? (
              <div
                style={{
                  border: "2px dashed rgba(240, 111, 111, 0.3)", borderRadius: "8px",
                  padding: "40px 20px", textAlign: "center", cursor: "pointer",
                  background: "rgba(240, 111, 111, 0.02)", transition: "border-color 0.2s",
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
                  background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: "6px", padding: "12px", marginBottom: "20px",
                  display: "flex", alignItems: "center", gap: "10px",
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
                      height: "8px", background: "rgba(255, 255, 255, 0.08)",
                      borderRadius: "4px", overflow: "hidden", marginBottom: "20px",
                    }}>
                      <div style={{
                        height: "100%", width: `${convertProgress}%`,
                        background: "linear-gradient(90deg, #f06f6f, #ff9e9e)",
                        borderRadius: "4px", transition: "width 0.1s linear",
                      }} />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                    <button className="toolbar-btn" onClick={() => setConvertFile(null)} style={{ margin: 0 }}>
                      Clear Selection
                    </button>
                    <button className="primary-button" onClick={runTranscode} style={{ margin: 0, padding: "8px 20px" }}>
                      Start Conversion
                    </button>
                  </div>
                )}
              </div>
            )}

            {convertError && (
              <div style={{
                marginTop: "16px", padding: "10px 12px",
                background: "rgba(193, 52, 52, 0.12)", border: "1px solid rgba(193, 52, 52, 0.25)",
                borderRadius: "6px", color: "#ffd8d8", fontSize: "0.85rem",
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

/* ── PiP Participant Tile ── */

interface PipTileProps {
  displayName: string;
  isLocal: boolean;
  cameraEnabled: boolean;
  stream: MediaStream | null;
}

function PipTile({ displayName, isLocal, cameraEnabled, stream }: PipTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="pip-tile">
      {cameraEnabled && stream ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} />
      ) : (
        <div className="avatar-fallback">
          {getInitials(displayName) || "L"}
        </div>
      )}
      <span className="pip-name">{displayName}</span>
    </div>
  );
}
