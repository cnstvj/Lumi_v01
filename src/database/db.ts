import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

async function ensureSchema(database: Database) {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      partner_code TEXT UNIQUE,
      self_meeting_id TEXT UNIQUE,
      partner_id INTEGER,
      FOREIGN KEY (partner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS permanent_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT UNIQUE NOT NULL,
      user_1_id INTEGER NOT NULL,
      user_2_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_1_id) REFERENCES users(id),
      FOREIGN KEY (user_2_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS room_state (
      room_id INTEGER PRIMARY KEY,
      active_movie TEXT,
      active_movie_name TEXT,
      playback_time REAL DEFAULT 0,
      playback_rate REAL DEFAULT 1.0,
      is_playing BOOLEAN DEFAULT 0,
      host_user_id INTEGER,
      ready_user_1 BOOLEAN DEFAULT 0,
      ready_user_2 BOOLEAN DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES permanent_rooms(id)
    );

    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id INTEGER,
      movie_name TEXT NOT NULL,
      duration_watched REAL DEFAULT 0,
      watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      watched_with INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES permanent_rooms(id),
      FOREIGN KEY (watched_with) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      theme TEXT DEFAULT 'dark',
      camera_enabled BOOLEAN DEFAULT 0,
      microphone_enabled BOOLEAN DEFAULT 0,
      theater_mode BOOLEAN DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS room_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    private_space_id INTEGER NOT NULL,

    movie_name TEXT NOT NULL,
    movie_path TEXT NOT NULL,

    playback_time REAL DEFAULT 0,

    last_updated_by INTEGER,

    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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

  // Ensure the single channel_state row exists
  const rows = await database.select<{ id: number }[]>(
    `SELECT id FROM channel_state WHERE id = 1`
  );

  if (rows.length === 0) {
    await database.execute(
      `INSERT INTO channel_state (id, active_movie, playback_time, playback_rate, is_playing)
       VALUES (1, NULL, 0, 1.0, 0)`
    );
  }

  // Run migrations for columns that may not exist yet
  const migrations = [
    "ALTER TABLE users ADD COLUMN partner_id INTEGER",
    "ALTER TABLE room_state ADD COLUMN active_movie_name TEXT",
    "ALTER TABLE room_state ADD COLUMN host_user_id INTEGER",
    "ALTER TABLE room_state ADD COLUMN ready_user_1 BOOLEAN DEFAULT 0",
    "ALTER TABLE room_state ADD COLUMN ready_user_2 BOOLEAN DEFAULT 0",
    "ALTER TABLE users ADD COLUMN self_meeting_id TEXT",
    `
    CREATE TABLE IF NOT EXISTS partner_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_user_id INTEGER NOT NULL,
      receiver_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS private_spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      partner_1_id INTEGER NOT NULL,
      partner_2_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    `
  ];

  for (const migration of migrations) {
    try {
      await database.execute(migration);
    } catch {
      // Column already exists.
    }
  }
}

export async function getDb() {
  if (!db) {
    db = await Database.load("sqlite:lumi.db");
    await ensureSchema(db);
  }

  return db;
}
