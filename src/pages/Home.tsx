import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import {
  getRecentWatchHistory,
  getOrCreateSharedSpace,
  type RoomRecord,
} from "../database/roomRepository";

import { getPendingRequests } from "../database/partnerRequestRepository";
import { useAuthStore } from "../stores/authStore";

export default function Home() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [history, setHistory] = useState<
    {
      id: number;
      movie_name: string;
      duration_watched: number;
      watched_at: string;
      watched_with: string | null;
    }[]
  >([]);

  const [sharedSpace, setSharedSpace] = useState<RoomRecord | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!user) {
      return;
    }

    Promise.all([
      getRecentWatchHistory(user.id),
      user.partnerId
        ? getOrCreateSharedSpace(user.id)
        : Promise.resolve(null),
      getPendingRequests(user.id),
    ])
      .then(([historyData, space, pending]) => {
        setHistory(historyData);
        setSharedSpace(space);
        setPendingCount(pending.length);
      })
      .catch(console.error);
  }, [user]);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="home-layout">
      {/* ── Top Bar ── */}
      <div className="home-topbar animate-fade-in">
        <div className="home-brand">
          <p className="eyebrow">Lumi</p>
          <span className="home-greeting">
            {user.partnerId
              ? `${user.displayName} ❤️`
              : `Hi, ${user.displayName}`}
          </span>
        </div>

        <div className="request-badge">
          <button
            className="settings-icon"
            onClick={() => navigate("/settings")}
            title="Settings"
          >
            ⚙
          </button>

          {pendingCount > 0 && <span className="request-badge-dot" />}
        </div>
      </div>

      {/* ── Center Hero ── */}
      <div className="home-center">
        <div className="home-hero-text animate-fade-in delay-1">
          <h1>Watch Together</h1>
          <p className="muted">
            {user.partnerId
              ? "Your partner is linked. Start a movie or enter your private space."
              : "Link a partner in Settings to unlock your permanent shared space."}
          </p>
        </div>

        <button
          className="watch-button animate-slide-up delay-2 animate-glow"
          onClick={() => navigate("/start-movie")}
        >
          <span className="watch-button-icon">▶</span>
          Watch New Movie
        </button>

        {user.partnerId && sharedSpace && (
          <button
            className="private-space-button animate-slide-up delay-3"
            onClick={() =>
              navigate(`/space/${sharedSpace.room_code}`)
            }
          >
            ❤️ Enter Private Space
          </button>
        )}
      </div>

      {/* ── Continue Watching ── */}
      <div className="home-bottom animate-fade-in delay-3">
        <div className="continue-section-header">
          <h2>Continue Watching</h2>
        </div>

        {history.length > 0 ? (
          <div className="continue-row">
            {history.map((item) => (
              <article className="continue-card" key={item.id}>
                <span className="continue-card-title">
                  {item.movie_name}
                </span>

                <span className="continue-card-meta">
                  {Math.round(item.duration_watched / 60)} min watched
                  {item.watched_with ? " · Together" : ""}
                </span>

                <div className="continue-card-progress">
                  <div
                    className="continue-card-progress-fill"
                    style={{ width: `${Math.min(100, (item.duration_watched / 7200) * 100)}%` }}
                  />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="continue-empty">
            No movies watched yet. Start your first movie above!
          </p>
        )}
      </div>
    </main>
  );
}
