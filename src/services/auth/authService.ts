import { supabase } from "../../database/supabaseClient";
import type { AuthUser } from "../../stores/authStore";

/**
 * Authentication Service (Supabase OTP)
 */

export async function sendOtp(email: string) {
  const cleanEmail = email.trim().toLowerCase();

  if (!cleanEmail) {
    throw new Error("Enter an email address.");
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function verifyOtp(email: string, token: string) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanToken = token.trim();

  if (!cleanToken) {
    throw new Error("Enter the 6-digit pin.");
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email: cleanEmail,
    token: cleanToken,
    type: "email",
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data.user) {
    throw new Error("Verification failed.");
  }

  // Load the profile from the Supabase public.profiles table
  return await loadUser();
}

export async function loadUser(): Promise<AuthUser | null> {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.user) {
    return null;
  }

  // Fetch from the profiles table
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) {
    // If the profile trigger hasn't fired yet, we might need a slight retry or fallback
    // For this prototype, we'll throw if profile is completely missing.
    console.warn("Profile not found for user:", session.user.id);
    return null;
  }

  return {
    id: profile.id,
    displayName: profile.display_name,
    email: profile.email,
    avatarPath: profile.avatar_path,
    partnerCode: profile.partner_code,
    partnerId: profile.partner_id,
    selfMeetingId: profile.self_meeting_id,
  };
}

export async function logoutUser() {
  await supabase.auth.signOut();
}

export async function updateDisplayName(displayName: string) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("Not logged in");

  const cleanName = displayName.trim();
  if (!cleanName) throw new Error("Name cannot be empty");

  // Update auth metadata
  await supabase.auth.updateUser({
    data: { display_name: cleanName }
  });

  // Update public profile
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: cleanName })
    .eq("id", session.user.id);

  if (error) throw new Error(error.message);
}
