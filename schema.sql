CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  ip_hash TEXT,
  title TEXT,
  brief TEXT,
  access_token_hash TEXT,
  current_version INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new'
);

CREATE TABLE versions(
  project_id TEXT,
  version INTEGER,
  r2_key TEXT,
  origin TEXT,
  created_at INTEGER,
  PRIMARY KEY(project_id, version)
);

CREATE TABLE messages(
  project_id TEXT,
  seq INTEGER,
  role TEXT,
  content TEXT,
  created_at INTEGER,
  PRIMARY KEY(project_id, seq)
);

CREATE TABLE quotas(
  scope TEXT,
  day TEXT,
  count INTEGER DEFAULT 0,
  PRIMARY KEY(scope, day)
);
