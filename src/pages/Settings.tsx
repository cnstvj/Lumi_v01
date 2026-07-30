import { useState, useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { logoutUser } from "../services/auth/authService";
import { findUserByPartnerCode, getPartner, unlinkPartners, type ProfileRow } from "../database/userRepository";
import { useAuthStore } from "../stores/authStore";
import {
  sendPartnerRequest,
  getPendingRequests,
  acceptAndLink,
  rejectPartnerRequest,
  type PendingRequestDisplay,
} from "../database/partnerRequestRepository";
import { supabase } from "../database/supabaseClient";

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export default function Settings() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [partnerCodeInput, setPartnerCodeInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partner, setPartner] = useState<ProfileRow | null>(null);
  const [requests, setRequests] = useState<PendingRequestDisplay[]>([]);

  async function loadData() {
    if (!user?.id) return;

    const [linkedPartner, pending] = await Promise.all([
      getPartner(user.id),
      getPendingRequests(user.id),
    ]);

    setPartner(linkedPartner);
    setRequests(pending);
  }

  useEffect(() => {
    loadData();

    if (!user) return;

    // Real-time subscription to partner_requests and profiles
    const channel = supabase
      .channel("settings_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "partner_requests", filter: `receiver_id=eq.${user.id}` },
        () => loadData()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${user.id}` },
        () => loadData() // Trigger a reload if our profile updates (e.g. partner_id changed)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  async function handleCopyPartnerId() {
    if (!user?.partnerCode) return;

    await navigator.clipboard.writeText(user.partnerCode);
    setMessage("Partner ID copied!");
    setError(null);
    setTimeout(() => setMessage(null), 2000);
  }

  async function handleLinkPartner() {
    if (!user) return;

    const found = await findUserByPartnerCode(partnerCodeInput);

    if (!found) {
      setError("Partner not found.");
      return;
    }

    if (found.id === user.id) {
      setError("You cannot link yourself.");
      return;
    }

    try {
      await sendPartnerRequest(user.id, found.id);
      setMessage(`Request sent to ${found.display_name}`);
      setError(null);
      setPartnerCodeInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send request.");
    }
  }

  async function handleAccept(requestId: number) {
    if (!user) return;

    try {
      await acceptAndLink(requestId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept.");
    }
  }

  async function handleReject(requestId: number) {
    if (!user) return;
    try {
      await rejectPartnerRequest(requestId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject.");
    }
  }

  async function handleLogout() {
    await logoutUser();
    navigate("/", { replace: true });
  }

  return (
    <main className="settings-shell">
      {/* ── Header ── */}
      <div className="settings-header animate-fade-in">
        <button
          className="secondary-button compact-button"
          onClick={() => navigate("/home")}
        >
          ← Back
        </button>
        <div>
          <p className="eyebrow">Settings</p>
        </div>
      </div>

      {/* ── Account Info ── */}
      <section className="settings-section animate-fade-in delay-1">
        <div className="settings-section-title">
          <p className="eyebrow">Account</p>
          <h2>Your Profile</h2>
        </div>

        <div className="status-grid">
          <article className="status-card">
            <span>Name</span>
            <strong>{user.displayName}</strong>
          </article>

          <article className="status-card">
            <span>Email</span>
            <strong>{user.email}</strong>
          </article>
        </div>
      </section>

      {/* ── Partner ── */}
      <section className="settings-section animate-fade-in delay-2">
        <div className="settings-section-title">
          <p className="eyebrow">Partner</p>
          <h2>Link Your Watch Partner</h2>
          <p className="muted">
            Share your Partner ID or enter theirs. Linking creates a permanent shared space.
          </p>
        </div>

        {/* Your Partner ID */}
        <div className="copy-row">
          <code>{user.partnerCode ?? "LUMI-XXXXXX"}</code>
          <button className="secondary-button compact-button" onClick={handleCopyPartnerId}>
            Copy
          </button>
        </div>

        {partner ? (
          <div className="partner-info-row">
            <div className="partner-avatar">
              {getInitials(partner.display_name)}
            </div>
            <div className="partner-details">
              <strong>{partner.display_name}</strong>
              <span>{partner.email}</span>
            </div>
            <button
              className="secondary-button compact-button"
              onClick={async () => {
                await unlinkPartners(user.id, partner.id);
                await loadData();
              }}
            >
              Unlink
            </button>
          </div>
        ) : (
          <div className="join-row">
            <label>
              <span className="meeting-id-label">Enter Partner ID</span>
              <input
                value={partnerCodeInput}
                onChange={(e) => setPartnerCodeInput(e.target.value)}
                placeholder="LUMI-XXXXXX"
              />
            </label>
            <button
              className="primary-button"
              onClick={handleLinkPartner}
              disabled={!partnerCodeInput.trim()}
            >
              Link
            </button>
          </div>
        )}

        {message && <div className="success-card">{message}</div>}
        {error && <div className="error-card">{error}</div>}
      </section>

      {/* ── Pending Requests ── */}
      {requests.length > 0 && (
        <section className="settings-section animate-fade-in delay-2">
          <div className="settings-section-title">
            <p className="eyebrow">Requests</p>
            <h2>Pending Partner Requests</h2>
          </div>

          {requests.map((request) => (
            <div key={request.id} className="request-card">
              <div className="request-card-info">
                <strong>{request.display_name}</strong>
                <span>Wants to be your watch partner</span>
              </div>

              <div className="request-card-actions">
                <button
                  className="btn-accept"
                  onClick={() => handleAccept(request.id)}
                >
                  Accept
                </button>
                <button
                  className="btn-reject"
                  onClick={() => handleReject(request.id)}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* ── About & Logout ── */}
      <section className="settings-section animate-fade-in delay-3">
        <div className="settings-section-title">
          <p className="eyebrow">About</p>
          <h2>Lumi v0.2</h2>
          <p className="muted">
            Real-time watch together app for a permanent shared space.
          </p>
        </div>

        <button className="logout-button" onClick={handleLogout}>
          Logout
        </button>
      </section>
    </main>
  );
}
