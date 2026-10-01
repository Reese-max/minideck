export function ownerIdFromGithubProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const id = profile.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? "github:" + id
    : null;
}
