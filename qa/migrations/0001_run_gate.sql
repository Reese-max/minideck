-- QA-only control table, applied only after fresh-create/readback admission.
CREATE TABLE minideck_qa_run (
  run_id TEXT PRIMARY KEY,
  gate_hash TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  product_tree TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at AND expires_at-created_at<=3600000),
  active INTEGER NOT NULL DEFAULT 0 CHECK(typeof(active)='integer' AND active IN(0,1)),
  requests_left INTEGER NOT NULL CHECK(typeof(requests_left)='integer' AND requests_left BETWEEN 0 AND 200)
);
