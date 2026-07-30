import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { createRoom, joinRoom, getOrCreateSharedSpace } from "../database/roomRepository";
import { useAuthStore } from "../stores/authStore";

export default function StartMovie() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [generatedId, setGeneratedId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  async function handleGenerate() {
    if (!user) return;
    setError(null);

    try {
      setLoading(true);
      const room = await createRoom(user.email);
      setGeneratedId(room.room_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create meeting.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopyId() {
    if (!generatedId) return;

    await navigator.clipboard.writeText(generatedId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleJoin() {
    if (!user) return;

    const code = joinCode.trim().toUpperCase();

    if (!code) {
      setError("Enter a meeting ID.");
      return;
    }

    setError(null);

    try {
      setLoading(true);
      const room = await joinRoom(code, user.email);

      if (!room) {
        setError("Meeting not found.");
        return;
      }

      navigate(`/space/${room.room_code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePrivateSpace() {
    if (!user) return;
    setError(null);

    try {
      setLoading(true);
      const space = await getOrCreateSharedSpace(user.id);

      if (!space) {
        setError("No partner linked. Link a partner in Settings first.");
        return;
      }

      navigate(`/space/${space.room_code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enter private space.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="start-movie-shell">
      <button
        className="secondary-button compact-button animate-fade-in"
        onClick={() => navigate("/home")}
      >
        ← Back
      </button>

      <section className="start-movie-hero animate-slide-up delay-1">
        <div>
          <p className="eyebrow">Start New Movie</p>
          <h1>Create or Join a Session</h1>
          <p className="muted">
            Generate a meeting ID to share, or enter one to join an existing session.
          </p>
        </div>

        {/* ── Self Meeting ID ── */}
        <div className="meeting-id-display">
          <div>
            <span className="meeting-id-label">Your Meeting ID</span>
            <div className="meeting-id-value">
              {user.selfMeetingId ?? "Not generated"}
            </div>
          </div>
        </div>

        {/* ── Generate ── */}
        <div className="meeting-id-display">
          <div style={{ flex: 1 }}>
            <span className="meeting-id-label">Generated Session</span>
            <div className="meeting-id-value">
              {generatedId || "—"}
            </div>
          </div>

          <div className="meeting-id-actions">
            {generatedId && (
              <>
                <button
                  className="secondary-button compact-button"
                  onClick={handleCopyId}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  className="primary-button compact-button"
                  onClick={() => navigate(`/space/${generatedId}`)}
                >
                  Enter
                </button>
              </>
            )}
          </div>
        </div>

        <button
          className="primary-button"
          onClick={handleGenerate}
          disabled={loading}
        >
          {loading ? "Creating..." : "Generate Meeting ID"}
        </button>

        <div className="divider">or</div>

        {/* ── Join ── */}
        <div className="join-row">
          <label>
            <span className="meeting-id-label">Join a Session</span>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="XXXX-0000"
            />
          </label>

          <button
            className="primary-button"
            onClick={handleJoin}
            disabled={loading || !joinCode.trim()}
          >
            Join
          </button>
        </div>

        {error && <div className="error-card">{error}</div>}
      </section>

      {/* ── Private Space CTA ── */}
      {user.partnerId && (
        <div
          className="private-space-cta animate-slide-up delay-2"
          onClick={handlePrivateSpace}
        >
          <span className="private-space-cta-icon">❤️</span>
          <div className="private-space-cta-text">
            <strong>Enter Private Space</strong>
            <span>
              Jump straight into your permanent shared space — no codes needed.
            </span>
          </div>
          <span className="private-space-cta-arrow">→</span>
        </div>
      )}
    </main>
  );
}
