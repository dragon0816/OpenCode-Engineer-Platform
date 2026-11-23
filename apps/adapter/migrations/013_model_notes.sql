CREATE TABLE IF NOT EXISTS web_model_notes (
  alias TEXT PRIMARY KEY,
  mapped_model TEXT,
  note TEXT,
  CHECK(mapped_model IS NOT NULL OR note IS NOT NULL)
) STRICT;
