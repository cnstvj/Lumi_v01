import { getDb } from "./db";

export interface PrivateSpace {
  id: number;
  name: string;
  partner_1_id: number;
  partner_2_id: number;
  created_at: string;
}

export async function createPrivateSpace(
  partner1Id: number,
  partner2Id: number,
  name: string
) {
  const db = await getDb();

  await db.execute(
    `
    INSERT INTO private_spaces
    (
      name,
      partner_1_id,
      partner_2_id
    )
    VALUES (?, ?, ?)
    `,
    [name, partner1Id, partner2Id]
  );
}

export async function getPrivateSpace(
  userId: number
) {
  const db = await getDb();

  const rows =
    await db.select<PrivateSpace[]>(
      `
      SELECT *
      FROM private_spaces
      WHERE
        partner_1_id = ?
        OR partner_2_id = ?
      LIMIT 1
      `,
      [userId, userId]
    );

  return rows[0] ?? null;
}
export async function renamePrivateSpace(
  spaceId: number,
  newName: string
) {
  const db = await getDb();

  await db.execute(
    `
    UPDATE private_spaces
    SET name = ?
    WHERE id = ?
    `,
    [newName.trim(), spaceId]
  );
}

export async function getSharedWatchHistory(
  userId: number
) {
  const db = await getDb();

  return await db.select<any[]>(
    `
    SELECT
      wh.*,
      u.display_name
    FROM watch_history wh
    JOIN users u
      ON wh.user_id = u.id
    WHERE
      wh.user_id IN (
        SELECT partner_1_id
        FROM private_spaces
        WHERE partner_1_id = ?
           OR partner_2_id = ?

        UNION

        SELECT partner_2_id
        FROM private_spaces
        WHERE partner_1_id = ?
           OR partner_2_id = ?
      )
    ORDER BY watched_at DESC
    LIMIT 25
    `,
    [
      userId,
      userId,
      userId,
      userId
    ]
  );
}

export async function getContinueWatching(
  userId: number
) {
  const db = await getDb();

  const rows =
    await db.select<any[]>(
      `
      SELECT rp.*
      FROM room_progress rp
      JOIN private_spaces ps
        ON rp.private_space_id = ps.id
      WHERE
        ps.partner_1_id = ?
        OR ps.partner_2_id = ?
      LIMIT 1
      `,
      [userId, userId]
    );

  return rows[0] ?? null;
}

export async function saveContinueWatching(
  privateSpaceId: number,
  movieName: string,
  moviePath: string,
  playbackTime: number,
  userId: number
) {
  const db = await getDb();

  await db.execute(
    `
    INSERT OR REPLACE INTO room_progress
    (
      private_space_id,
      movie_name,
      movie_path,
      playback_time,
      last_updated_by
    )
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      privateSpaceId,
      movieName,
      moviePath,
      playbackTime,
      userId
    ]
  );
}
