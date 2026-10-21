-- issue #4：草稿 current_version 與公開 published_version 分離。
-- 相容政策：在此欄位出現之前 /p/:id 對所有人公開 current_version，
-- 因此既有專案把當下 current_version 複製為 published_version（reason: legacy-public），
-- 保留既有分享連結；新專案預設 NULL＝未發布，需明確 publish 才公開。
ALTER TABLE projects ADD COLUMN published_version INTEGER;
ALTER TABLE projects ADD COLUMN published_at INTEGER;
UPDATE projects
SET published_version = current_version,
    published_at = (
      SELECT created_at FROM versions
      WHERE versions.project_id = projects.id
        AND versions.version = projects.current_version
    )
WHERE current_version > 0
  AND EXISTS(
    SELECT 1 FROM versions
    WHERE versions.project_id = projects.id
      AND versions.version = projects.current_version
  );
