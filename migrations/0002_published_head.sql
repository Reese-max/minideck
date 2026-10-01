ALTER TABLE projects ADD COLUMN published_version INTEGER;
ALTER TABLE projects ADD COLUMN published_at INTEGER;
ALTER TABLE projects ADD COLUMN publish_origin TEXT;

-- Compatibility policy: pre-change semantics exposed current_version publicly,
-- so existing projects keep their share link alive by adopting the current
-- head as the published head. publish_origin records the migration reason.
-- The EXISTS guard refuses to publish a dangling head when the versions row
-- for current_version is missing.
UPDATE projects
SET published_version = current_version,
    published_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    publish_origin = 'migration'
WHERE current_version > 0
  AND EXISTS (
    SELECT 1 FROM versions
    WHERE versions.project_id = projects.id
      AND versions.version = projects.current_version
  );
