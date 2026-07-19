import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export interface ChannelState {
  id: number;
  active_movie_name: string | null;
  playback_time: number;
  playback_rate: number;
  is_playing: boolean;
  updated_at: string;
}

/**
 * Initialize the channel — ensures the single shared row exists in Supabase.
 */
export async function initChannel(): Promise<void> {
  const { data } = await supabase
    .from("channel_state")
    .select("id")
    .eq("id", 1)
    .single();

  if (!data) {
    await supabase.from("channel_state").upsert({
      id: 1,
      active_movie_name: null,
      playback_time: 0,
      playback_rate: 1.0,
      is_playing: false,
    });
  }
}

/**
 * Read the current channel state from Supabase.
 */
export async function getChannelState(): Promise<ChannelState | null> {
  const { data, error } = await supabase
    .from("channel_state")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("getChannelState error:", error);
    return null;
  }

  return data as ChannelState;
}

/**
 * Set the active movie name and reset playback to the beginning.
 * Only the movie name is stored (not the full path, since paths differ across machines).
 */
export async function setActiveMovie(
  movieName: string
): Promise<ChannelState | null> {
  const { error } = await supabase
    .from("channel_state")
    .update({
      active_movie_name: movieName,
      playback_time: 0,
      playback_rate: 1.0,
      is_playing: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) {
    console.error("setActiveMovie error:", error);
    return null;
  }

  return await getChannelState();
}

/**
 * Update playback state — called by the host to publish current position.
 */
export async function updatePlayback(
  playbackTime: number,
  isPlaying: boolean,
  playbackRate: number = 1.0
): Promise<ChannelState | null> {
  const { error } = await supabase
    .from("channel_state")
    .update({
      playback_time: playbackTime,
      is_playing: isPlaying,
      playback_rate: playbackRate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) {
    console.error("updatePlayback error:", error);
    return null;
  }

  return await getChannelState();
}

/**
 * Clear the active movie — resets the channel.
 */
export async function clearMovie(): Promise<void> {
  await supabase
    .from("channel_state")
    .update({
      active_movie_name: null,
      playback_time: 0,
      is_playing: false,
      playback_rate: 1.0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

/**
 * Subscribe to real-time changes on the channel_state table.
 * Returns the RealtimeChannel so the caller can unsubscribe later.
 */
export function subscribeToChannel(
  onUpdate: (state: ChannelState) => void
): RealtimeChannel {
  // Remove any prior channel with this name so we get a fresh, un-subscribed
  // instance.  Without this, React Strict-Mode / HMR re-mounts will try to
  // call .on() on an already-subscribed channel and Supabase will reject it.
  const existing = supabase
    .getChannels()
    .find((c) => c.topic === "realtime:channel_state_changes");
  if (existing) {
    supabase.removeChannel(existing);
  }

  const channel = supabase
    .channel("channel_state_changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "channel_state",
        filter: "id=eq.1",
      },
      (payload) => {
        onUpdate(payload.new as ChannelState);
      }
    )
    .subscribe();

  return channel;
}

/**
 * Unsubscribe from real-time changes.
 */
export function unsubscribeFromChannel(channel: RealtimeChannel): void {
  supabase.removeChannel(channel);
}
