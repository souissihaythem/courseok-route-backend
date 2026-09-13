/**
 * Durable JSON blob via a private GitHub Gist (survives Render Free disk wipe).
 * Requires GITHUB_TOKEN + gist id env vars.
 */
async function loadGistJson(gistId, filename, token) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "CourseOK-backend",
    },
  });
  if (!res.ok) {
    throw new Error(`gist load HTTP ${res.status}`);
  }
  const json = await res.json();
  const file = json.files?.[filename];
  if (!file?.content) return null;
  return JSON.parse(file.content);
}

async function saveGistJson(gistId, filename, token, data) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "CourseOK-backend",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: {
        [filename]: { content: JSON.stringify(data, null, 2) },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gist save HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

module.exports = { loadGistJson, saveGistJson };
