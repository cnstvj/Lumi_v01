import { create } from "zustand";

export interface AuthUser {
  id: string; // UUID from Supabase
  displayName: string;
  email: string;
  avatarPath: string | null;
  partnerCode: string | null;
  partnerId: string | null; // UUID from Supabase
  selfMeetingId: string | null;
}

interface AuthState {
  user: AuthUser | null;
  login: (user: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  login: (user) => set({ user }),
  logout: () => set({ user: null })
}));
