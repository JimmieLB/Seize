const adminTokenKey = "seize-admin-token";

export function getAdminToken() {
  try {
    return localStorage.getItem(adminTokenKey);
  } catch {
    return null;
  }
}

export function setAdminToken(token) {
  try {
    if (token) localStorage.setItem(adminTokenKey, token);
    else localStorage.removeItem(adminTokenKey);
  } catch {
    // Storage unavailable (private mode etc.): admin login just won't persist.
  }
}

export async function api(url, options = {}) {
  const adminToken = getAdminToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { "X-Admin-Token": adminToken } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}
