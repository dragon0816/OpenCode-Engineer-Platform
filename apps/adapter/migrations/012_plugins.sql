CREATE TABLE plugin_packages (
  plugin_id TEXT NOT NULL,
  version TEXT COLLATE NOCASE NOT NULL,
  artifact TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
) STRICT;

CREATE TABLE plugin_installations (
  plugin_id TEXT PRIMARY KEY,
  version TEXT COLLATE NOCASE NOT NULL,
  previous_version TEXT COLLATE NOCASE,
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled', 'integrity-failed')),
  generation TEXT NOT NULL,
  FOREIGN KEY (plugin_id, version) REFERENCES plugin_packages(plugin_id, version),
  FOREIGN KEY (plugin_id, previous_version) REFERENCES plugin_packages(plugin_id, version)
) STRICT;

CREATE TABLE plugin_operations (
  operation_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('install', 'uninstall')),
  version TEXT COLLATE NOCASE,
  retired_artifact TEXT,
  CHECK ((operation = 'install') = (version IS NOT NULL)),
  CHECK (retired_artifact IS NULL OR operation = 'install')
) STRICT;
