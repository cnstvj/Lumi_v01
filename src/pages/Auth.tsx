import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import { sendOtp, verifyOtp, updateDisplayName } from "../services/auth/authService";
import { useAuthStore } from "../stores/authStore";

export default function Auth() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [step, setStep] = useState<"email" | "otp" | "profile">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [displayName, setDisplayName] = useState("");
  
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSendOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      setLoading(true);
      await sendOtp(email);
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send login code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      setLoading(true);
      const user = await verifyOtp(email, otp);
      
      // If the user has a display name generated from email (e.g., no real name), 
      // we could prompt them. The schema trigger defaults it to the email prefix.
      // We'll let them through, and they can change it in settings if needed.
      // But if we explicitly want to ask new users for a display name, we check if it matches email prefix.
      
      const emailPrefix = email.split("@")[0].toLowerCase();
      if (user?.displayName.toLowerCase() === emailPrefix) {
        setStep("profile");
        // Keep them logged into Supabase but not fully admitted to the UI yet
      } else if (user) {
        login(user);
        navigate("/home", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      setLoading(true);
      await updateDisplayName(displayName);
      
      // Load user again to get the updated profile and admit them
      const { loadUser } = await import("../services/auth/authService");
      const user = await loadUser();
      
      if (user) {
        login(user);
        navigate("/home", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update profile.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">Lumi</p>
          <h1>
            {step === "email" && "Welcome to Lumi"}
            {step === "otp" && "Check your email"}
            {step === "profile" && "Complete Profile"}
          </h1>
          <p className="muted">
            {step === "email" && "Sign in or create an account with your email."}
            {step === "otp" && `We sent a 6-digit pin to ${email}`}
            {step === "profile" && "What should we call you?"}
          </p>
        </div>

        {step === "email" && (
          <form className="form-stack" onSubmit={handleSendOtp}>
            <label>
              Email address
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
                required
              />
            </label>
            {error ? <div className="error-card">{error}</div> : null}
            <button className="primary-button" disabled={loading}>
              {loading ? "Sending link..." : "Continue with Email"}
            </button>
          </form>
        )}

        {step === "otp" && (
          <form className="form-stack" onSubmit={handleVerifyOtp}>
            <label>
              6-Digit Pin
              <input
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
              />
            </label>
            {error ? <div className="error-card">{error}</div> : null}
            <button className="primary-button" disabled={loading}>
              {loading ? "Verifying..." : "Verify & Sign In"}
            </button>
            <button 
              type="button" 
              className="secondary-button"
              onClick={() => setStep("email")}
              disabled={loading}
            >
              Back
            </button>
          </form>
        )}

        {step === "profile" && (
          <form className="form-stack" onSubmit={handleSetProfile}>
            <label>
              Display Name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                type="text"
                autoComplete="name"
                required
                placeholder="e.g. Alex"
              />
            </label>
            {error ? <div className="error-card">{error}</div> : null}
            <button className="primary-button" disabled={loading || !displayName.trim()}>
              {loading ? "Saving..." : "Start Watching"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
