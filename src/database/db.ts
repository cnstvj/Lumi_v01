import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

async function ensureSchema(database: Database) {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS channel_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_movie TEXT,
      active_movie_name TEXT,
      playback_time REAL DEFAULT 0,
      playback_rate REAL DEFAULT 1.0,
      is_playing BOOLEAN DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ensure the single row exists
  const rows = await database.select<{ id: number }[]>(
    `SELECT id FROM channel_state WHERE id = 1`
  );

  if (rows.length === 0) {
    await database.execute(
      `INSERT INTO channel_state (id, active_movie, playback_time, playback_rate, is_playing)
       VALUES (1, NULL, 0, 1.0, 0)`
    );
  }
}

export async function getDb() {
  if (!db) {
    db = await Database.load("sqlite:lumi-emergency.db");
    await ensureSchema(db);
  }

  return db;
}
