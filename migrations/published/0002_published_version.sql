ALTER TABLE projects ADD COLUMN published_version INTEGER DEFAULT NULL;
ALTER TABLE projects ADD COLUMN published_at INTEGER DEFAULT NULL;

-- Legacy compatibility: pin the currently shared version once, preserving existing links.
-- New and empty projects stay unpublished; subsequent draft writes never move this head.
UPDATE projects
SET published_version = current_version,
    published_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE current_version > 0
  AND EXISTS (
    SELECT 1 FROM versions
    WHERE project_id = projects.id AND version = projects.current_version
  );
