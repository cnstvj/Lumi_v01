import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import Auth from "./pages/Auth";
import Home from "./pages/Home";
import StartMovie from "./pages/StartMovie";
import SharedSpace from "./pages/SharedSpace";
import Settings from "./pages/Settings";

import { useAuthStore } from "./stores/authStore";
import { loadUser } from "./services/auth/authService";
import { supabase } from "./database/supabaseClient";

function App() {
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const currentUser = await loadUser();

        if (currentUser) {
          login(currentUser);
        } else {
          logout();
        }
      } catch (err) {
        console.warn("Session restore failed:", err);
      } finally {
        setReady(true);
      }
    }

    init();

    // Listen to real-time auth changes from Supabase
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        const u = await loadUser();
        if (u) login(u);
      } else if (event === "SIGNED_OUT") {
        logout();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <main className="auth-shell">
        <section className="auth-panel" style={{ textAlign: "center", border: "none", background: "none", boxShadow: "none" }}>
          <p className="eyebrow" style={{ marginBottom: "16px" }}>Lumi</p>
          <div className="spinner" style={{ margin: "0 auto" }}></div>
        </section>
      </main>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={user ? <Navigate to="/home" replace /> : <Auth />} />
        <Route path="/home" element={<Home />} />
        <Route path="/start-movie" element={<StartMovie />} />
        <Route path="/space/:roomCode" element={<SharedSpace />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
