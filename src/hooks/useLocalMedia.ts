import { useEffect, useRef, useState } from "react";

export function useLocalMedia() {
  const streamRef = useRef<MediaStream | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startMedia(options: { video?: boolean; audio?: boolean }) {
    setError(null);

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: options.video ?? cameraEnabled,
        audio: options.audio ?? microphoneEnabled
      });

      stopTracks();
      streamRef.current = nextStream;
      setStream(nextStream);
      setCameraEnabled(nextStream.getVideoTracks().some((track) => track.enabled));
      setMicrophoneEnabled(nextStream.getAudioTracks().some((track) => track.enabled));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to access camera or microphone. Check device permissions."
      );
    }
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }

  async function toggleCamera() {
    if (!cameraEnabled) {
      await startMedia({ video: true, audio: microphoneEnabled });
      return;
    }

    streamRef.current?.getVideoTracks().forEach((track) => track.stop());
    const remainingTracks = streamRef.current?.getAudioTracks() ?? [];
    const nextStream = remainingTracks.length ? new MediaStream(remainingTracks) : null;
    streamRef.current = nextStream;
    setStream(nextStream);
    setCameraEnabled(false);
  }

  async function toggleMicrophone() {
    if (!microphoneEnabled) {
      await startMedia({ video: cameraEnabled, audio: true });
      return;
    }

    streamRef.current?.getAudioTracks().forEach((track) => track.stop());
    const remainingTracks = streamRef.current?.getVideoTracks() ?? [];
    const nextStream = remainingTracks.length ? new MediaStream(remainingTracks) : null;
    streamRef.current = nextStream;
    setStream(nextStream);
    setMicrophoneEnabled(false);
  }

  useEffect(() => {
    return () => stopTracks();
  }, []);

  return {
    stream,
    cameraEnabled,
    microphoneEnabled,
    error,
    toggleCamera,
    toggleMicrophone
  };
}
