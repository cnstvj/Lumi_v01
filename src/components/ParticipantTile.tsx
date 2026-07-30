import { useEffect, useRef } from "react";

interface ParticipantTileProps {
  displayName: string;
  avatarPath?: string | null;
  isHost?: boolean;
  isReady?: boolean;
  isLocal?: boolean;
  cameraEnabled?: boolean;
  microphoneEnabled?: boolean;
  stream?: MediaStream | null;
}

function getInitials(displayName: string) {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export default function ParticipantTile({
  displayName,
  avatarPath,
  isHost = false,
  isReady = false,
  isLocal = false,
  cameraEnabled = false,
  microphoneEnabled = false,
  stream = null
}: ParticipantTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <article className="participant-tile">
      {cameraEnabled && stream ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} />
      ) : avatarPath ? (
        <img src={`file://${avatarPath}`} alt="" />
      ) : (
        <div className="avatar-fallback">{getInitials(displayName) || "L"}</div>
      )}

      <div className="participant-meta">
        <strong>{displayName}</strong>
        <span>
          {isHost ? "Host" : "Partner"} · {microphoneEnabled ? "Mic on" : "Mic off"}
        </span>
      </div>

      {isReady ? <span className="ready-pill">Ready</span> : null}
    </article>
  );
}
