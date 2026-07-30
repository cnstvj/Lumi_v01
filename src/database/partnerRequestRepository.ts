import { supabase } from "./supabaseClient";
import { linkPartners } from "./userRepository";

export interface PartnerRequest {
  id: number;
  sender_id: string; // UUID
  receiver_id: string; // UUID
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

// Joined representation to display in Settings
export interface PendingRequestDisplay {
  id: number;
  sender_id: string;
  display_name: string;
  email: string;
}

export async function sendPartnerRequest(senderId: string, receiverId: string): Promise<void> {
  // Check for an existing pending request
  const { data: existing } = await supabase
    .from("partner_requests")
    .select("id")
    .eq("sender_id", senderId)
    .eq("receiver_id", receiverId)
    .eq("status", "pending")
    .single();

  if (existing) {
    throw new Error("A request is already pending.");
  }

  const { error } = await supabase
    .from("partner_requests")
    .insert({
      sender_id: senderId,
      receiver_id: receiverId,
      status: "pending",
    });

  if (error) {
    throw new Error(error.message);
  }
}

export async function getPendingRequests(userId: string): Promise<PendingRequestDisplay[]> {
  // We need to fetch the pending requests and join with the sender's profile
  // In Supabase, if we have foreign keys set up, we can do a joined query:
  const { data, error } = await supabase
    .from("partner_requests")
    .select(`
      id,
      sender_id,
      profiles!partner_requests_sender_id_fkey (
        display_name,
        email
      )
    `)
    .eq("receiver_id", userId)
    .eq("status", "pending");

  if (error || !data) {
    console.warn("getPendingRequests error:", error);
    return [];
  }

  return data.map((row: any) => ({
    id: row.id,
    sender_id: row.sender_id,
    display_name: row.profiles?.display_name || "Unknown",
    email: row.profiles?.email || "",
  }));
}

export async function acceptAndLink(requestId: number): Promise<void> {
  // 1. Mark as accepted
  const { data, error } = await supabase
    .from("partner_requests")
    .update({ status: "accepted" })
    .eq("id", requestId)
    .select()
    .single();

  if (error || !data) {
    throw new Error("Unable to accept request.");
  }

  // 2. Link the partners
  await linkPartners(data.sender_id, data.receiver_id);

  // 3. Reject any other pending requests for these users (optional, but good practice)
  await supabase
    .from("partner_requests")
    .update({ status: "rejected" })
    .or(`receiver_id.eq.${data.receiver_id},sender_id.eq.${data.receiver_id},receiver_id.eq.${data.sender_id},sender_id.eq.${data.sender_id}`)
    .eq("status", "pending");
}

export async function rejectPartnerRequest(requestId: number): Promise<void> {
  const { error } = await supabase
    .from("partner_requests")
    .update({ status: "rejected" })
    .eq("id", requestId);

  if (error) {
    throw new Error(error.message);
  }
}
