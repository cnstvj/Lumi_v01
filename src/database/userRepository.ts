import { supabase } from "./supabaseClient";

export interface ProfileRow {
  id: string; // UUID
  display_name: string;
  email: string;
  avatar_path: string | null;
  partner_code: string;
  partner_id: string | null; // UUID
  self_meeting_id: string | null;
  created_at: string;
}

export async function findUserById(id: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.warn("findUserById error:", error);
    return null;
  }
  return data as ProfileRow;
}

export async function findUserByEmail(email: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email.trim().toLowerCase())
    .single();

  if (error) {
    return null;
  }
  return data as ProfileRow;
}

export async function findUserByPartnerCode(code: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("partner_code", code.trim().toUpperCase())
    .single();

  if (error) {
    return null;
  }
  return data as ProfileRow;
}

export async function getPartner(userId: string): Promise<ProfileRow | null> {
  const user = await findUserById(userId);
  if (!user || !user.partner_id) {
    return null;
  }

  return await findUserById(user.partner_id);
}

export async function linkPartners(userId: string, partnerId: string): Promise<void> {
  // Update both profiles to link to each other
  await supabase.from("profiles").update({ partner_id: partnerId }).eq("id", userId);
  await supabase.from("profiles").update({ partner_id: userId }).eq("id", partnerId);
}

export async function unlinkPartners(userId: string, partnerId: string): Promise<void> {
  // Update both profiles to remove the link
  await supabase.from("profiles").update({ partner_id: null }).eq("id", userId);
  await supabase.from("profiles").update({ partner_id: null }).eq("id", partnerId);
}
