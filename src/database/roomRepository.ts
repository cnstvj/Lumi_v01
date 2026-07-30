import { getDb } from "./db";
import { findUserByEmail, findUserById, getPartner, type ProfileRow } from "./userRepository";

export interface RoomRecord {
  id: number;
  room_code: string;
  user_1_id: string; // UUID
  user_2_id: string | null; // UUID
  created_at: string;
}

export interface RoomParticipant {
  id: string; // UUID
  displayName: string;
  email: string;
  avatarPath: string | null;
  partnerCode: string | null;
  isHost: boolean;
  isReady: boolean;
}

function generateRoomCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const segment = () =>
    Array.from({ length: 4 })
      .map(() => letters[Math.floor(Math.random() * letters.length)])
      .join("");

  const digits = () =>
    Array.from({ length: 4 })
      .map(() => Math.floor(Math.random() * 10).toString())
      .join("");

  return `${segment()}-${digits()}`;
}

export async function createRoom(ownerEmail: string, partnerEmail?: string) {
  const db = await getDb();
  const owner = await findUserByEmail(ownerEmail.trim().toLowerCase());

  if (!owner) {
    throw new Error("Unable to create room without a registered owner.");
  }

  const linkedPartner = await getPartner(owner.id);
  const partner = partnerEmail
    ? await findUserByEmail(partnerEmail.trim().toLowerCase())
    : linkedPartner;

  const roomCode = await createUniqueRoomCode(db);
  const partnerId = partner ? partner.id : null;

  await db.execute(
    `
    INSERT INTO permanent_rooms (room_code, user_1_id, user_2_id)
    VALUES (?, ?, ?)
    `,
    [roomCode, owner.id, partnerId]
  );

  const room = await findRoomByCode(roomCode);

  if (!room) {
    throw new Error("Failed to create room.");
  }

  await db.execute(
    `
    INSERT OR REPLACE INTO room_state (room_id, active_movie, playback_time, playback_rate, is_playing)
    VALUES (?, NULL, 0, 1.0, 0)
    `,
    [room.id]
  );

  await db.execute(
    `
    UPDATE room_state
    SET host_user_id = ?
    WHERE room_id = ?
    `,
    [owner.id, room.id]
  );

  return room;
}

async function createUniqueRoomCode(db: any): Promise<string> {
  let roomCode = generateRoomCode();
  let existing = await db.select(`SELECT id FROM permanent_rooms WHERE room_code = ?`, [roomCode]);

  while (existing.length > 0) {
    roomCode = generateRoomCode();
    existing = await db.select(`SELECT id FROM permanent_rooms WHERE room_code = ?`, [roomCode]);
  }

  return roomCode;
}

export async function findRoomByCode(roomCode: string): Promise<RoomRecord | null> {
  const db = await getDb();

  const rows = await db.select<RoomRecord[]>(
    `
    SELECT *
    FROM permanent_rooms
    WHERE room_code = ?
    `,
    [roomCode]
  );

  return rows[0] ?? null;
}

export async function joinRoom(roomCode: string, userEmail: string) {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);

  if (!room) {
    return null;
  }

  if (room.user_2_id) {
    return room;
  }

  const user = await findUserByEmail(userEmail.trim().toLowerCase());

  if (!user) {
    throw new Error("Unable to join room without a registered user.");
  }

  if (user.id === room.user_1_id) {
    return room;
  }

  await db.execute(
    `
    UPDATE permanent_rooms
    SET user_2_id = ?
    WHERE id = ?
    `,
    [user.id, room.id]
  );

  return await findRoomByCode(roomCode);
}

export interface RoomState {
  room_id: number;
  active_movie: string | null;
  active_movie_name: string | null;
  playback_time: number;
  playback_rate: number;
  is_playing: boolean;
  host_user_id: string | null; // UUID
  ready_user_1: boolean;
  ready_user_2: boolean;
  updated_at: string;
}

export async function getRoomState(roomCode: string): Promise<RoomState | null> {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);

  if (!room) {
    return null;
  }

  const rows = await db.select<RoomState[]>(
    `SELECT * FROM room_state WHERE room_id = ?`,
    [room.id]
  );

  return rows[0] ?? null;
}

export async function updateActiveMovie(roomCode: string, moviePath: string | null) {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);

  if (!room) {
    throw new Error("Room not found.");
  }

  const movieName = moviePath
    ? moviePath.split(/[\\/]/).pop() ?? moviePath
    : null;

  await db.execute(
    `
    UPDATE room_state
    SET active_movie = ?,
        active_movie_name = ?,
        playback_time = 0,
        is_playing = 0,
        ready_user_1 = 0,
        ready_user_2 = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE room_id = ?
    `,
    [moviePath, movieName, room.id]
  );

  return await getRoomState(roomCode);
}

export async function updatePlaybackState(
  roomCode: string,
  playbackTime: number,
  isPlaying: boolean,
  playbackRate: number = 1.0
) {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);

  if (!room) {
    throw new Error("Room not found.");
  }

  await db.execute(
    `
    UPDATE room_state
    SET playback_time = ?,
        is_playing = ?,
        playback_rate = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE room_id = ?
    `,
    [playbackTime, isPlaying ? 1 : 0, playbackRate, room.id]
  );

  return await getRoomState(roomCode);
}

export async function getRoomParticipants(roomCode: string): Promise<RoomParticipant[]> {
  const room = await findRoomByCode(roomCode);
  const state = await getRoomState(roomCode);

  if (!room) {
    return [];
  }

  const userIds = [room.user_1_id, room.user_2_id].filter(
    (id): id is string => typeof id === "string"
  );

  const users = await Promise.all(userIds.map((id) => findUserById(id)));

  return users
    .filter((user): user is ProfileRow => Boolean(user))
    .map((participant) => ({
      id: participant.id,
      displayName: participant.display_name,
      email: participant.email,
      avatarPath: participant.avatar_path,
      partnerCode: participant.partner_code,
      isHost: participant.id === room.user_1_id,
      isReady:
        participant.id === room.user_1_id
          ? Boolean(state?.ready_user_1)
          : Boolean(state?.ready_user_2)
    }));
}

export async function updateReadyState(roomCode: string, userId: string, isReady: boolean) {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);

  if (!room) {
    throw new Error("Room not found.");
  }

  const column =
    userId === room.user_1_id ? "ready_user_1" : userId === room.user_2_id ? "ready_user_2" : null;

  if (!column) {
    throw new Error("You are not a participant in this room.");
  }

  await db.execute(
    `UPDATE room_state SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?`,
    [isReady ? 1 : 0, room.id]
  );

  return await getRoomState(roomCode);
}

export async function addWatchHistory(roomCode: string, userId: string, durationWatched: number) {
  const db = await getDb();
  const room = await findRoomByCode(roomCode);
  const state = await getRoomState(roomCode);

  if (!room || !state?.active_movie_name) {
    return;
  }

  const watchedWith = userId === room.user_1_id ? room.user_2_id : room.user_1_id;

  await db.execute(
    `
    INSERT INTO watch_history (user_id, room_id, movie_name, duration_watched, watched_with)
    VALUES (?, ?, ?, ?, ?)
    `,
    [userId, room.id, state.active_movie_name, durationWatched, watchedWith ?? null]
  );
}

/**
 * Get the permanent shared space for a user with their linked partner.
 * Returns null if user is not linked or if no shared space exists yet.
 */
export async function getSharedSpace(userId: string): Promise<RoomRecord | null> {
  const db = await getDb();

  const rows = await db.select<RoomRecord[]>(
    `
    SELECT *
    FROM permanent_rooms
    WHERE (user_1_id = ? OR user_2_id = ?)
      AND (
        (user_1_id = ? AND user_2_id IS NOT NULL)
        OR (user_2_id = ? AND user_1_id IS NOT NULL)
      )
    LIMIT 1
    `,
    [userId, userId, userId, userId]
  );

  return rows[0] ?? null;
}

/**
 * Get or create the permanent shared space for a user with their linked partner.
 * If user has a partner linked, creates their shared space if it doesn't exist.
 * Returns the shared space room or null if user has no partner linked.
 */
export async function getOrCreateSharedSpace(userId: string): Promise<RoomRecord | null> {
  const user = await findUserById(userId);

  if (!user || !user.partner_id) {
    return null;
  }

  // Check if shared space already exists
  const existingSpace = await getSharedSpace(userId);
  if (existingSpace) {
    return existingSpace;
  }

  // Create the shared space
  const db = await getDb();
  const roomCode = await createUniqueRoomCode(db);

  await db.execute(
    `
    INSERT INTO permanent_rooms (room_code, user_1_id, user_2_id)
    VALUES (?, ?, ?)
    `,
    [roomCode, userId, user.partner_id]
  );

  const room = await findRoomByCode(roomCode);

  if (!room) {
    throw new Error("Failed to create shared space.");
  }

  // Initialize room state
  await db.execute(
    `
    INSERT OR REPLACE INTO room_state (room_id, active_movie, playback_time, playback_rate, is_playing)
    VALUES (?, NULL, 0, 1.0, 0)
    `,
    [room.id]
  );

  // Set first user as host
  await db.execute(
    `
    UPDATE room_state
    SET host_user_id = ?
    WHERE room_id = ?
    `,
    [userId, room.id]
  );

  return room;
}

export async function getRecentWatchHistory(userId: string) {
  const db = await getDb();

  return await db.select<
    {
      id: number;
      movie_name: string;
      duration_watched: number;
      watched_at: string;
      watched_with: string | null; // UUID
    }[]
  >(
    `
    SELECT id, movie_name, duration_watched, watched_at, watched_with
    FROM watch_history
    WHERE user_id = ?
    ORDER BY watched_at DESC
    LIMIT 5
    `,
    [userId]
  );
}

export async function getContinueWatching(userId: string) {
  const db = await getDb();

  const rows = await db.select<any[]>(
    `
    SELECT
      pr.room_code,
      rs.active_movie,
      rs.playback_time,
      rs.updated_at
    FROM permanent_rooms pr
    JOIN room_state rs
      ON rs.room_id = pr.id
    WHERE
      (pr.user_1_id = ? OR pr.user_2_id = ?)
      AND rs.active_movie IS NOT NULL
    ORDER BY rs.updated_at DESC
    LIMIT 1
    `,
    [userId, userId]
  );

  return rows[0] ?? null;
}
