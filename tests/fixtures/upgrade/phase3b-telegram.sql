-- SQLite DDL captured from 6c511e6 (schema-equivalent to db4ff99).
CREATE TABLE cursor(bot TEXT PRIMARY KEY, next INTEGER NOT NULL);
CREATE TABLE inbox(bot TEXT, id INTEGER, topic INTEGER NOT NULL,
        payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, firstSeen INTEGER NOT NULL DEFAULT 0, started INTEGER, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, lane TEXT NOT NULL DEFAULT 'work', PRIMARY KEY(bot,id));
CREATE TABLE outbox(bot TEXT, id TEXT, topic INTEGER NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot,id));
CREATE INDEX inbox_open ON inbox(bot,lane,topic,id) WHERE done=0;
CREATE TABLE telegram_sessions(topic INTEGER PRIMARY KEY, session TEXT NOT NULL);
CREATE TABLE bi_sources(id INTEGER PRIMARY KEY, ref TEXT NOT NULL, state TEXT NOT NULL,
      reason TEXT NOT NULL, bytes BLOB, domain TEXT NOT NULL, supplement BLOB, target TEXT NOT NULL DEFAULT '');
CREATE TABLE bi_config(name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE bi_schedules(id TEXT PRIMARY KEY, zone TEXT, time TEXT,
      payload TEXT, state TEXT, since INTEGER);
CREATE TABLE bi_occurrences(schedule TEXT, wall TEXT, zone TEXT, utc INTEGER, job TEXT UNIQUE,
      payload TEXT, state TEXT, PRIMARY KEY(schedule,wall));
CREATE TABLE telegram_binding(bot TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
PRAGMA user_version = 1;
