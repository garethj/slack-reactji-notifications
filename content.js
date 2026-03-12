// Content script — runs on app.slack.com
// Extracts xoxc- tokens from localStorage and sends them to the background service worker.
// All API calls are made by the background using chrome.cookies for the d cookie.

async function slackApi(method, token, params = {}) {
  const body = new URLSearchParams({ token, ...params });
  const res = await fetch(`/api/${method}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function extractTokens() {
  const tokens = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const value = localStorage.getItem(key);
    if (!value) continue;
    const match = value.match(/(xoxc-[a-zA-Z0-9-]+)/);
    if (match) {
      tokens.push({ key, token: match[1] });
    }
  }
  // Deduplicate by token value
  const seen = new Set();
  return tokens.filter(t => {
    if (seen.has(t.token)) return false;
    seen.add(t.token);
    return true;
  });
}

async function identifyWorkspaces() {
  const tokenEntries = extractTokens();
  const workspaces = [];
  for (const { token } of tokenEntries) {
    try {
      const result = await slackApi('auth.test', token);
      if (result.ok) {
        workspaces.push({
          token,
          userId: result.user_id,
          teamId: result.team_id,
          teamName: result.team,
          teamUrl: result.url
        });
      }
    } catch (e) {
      console.warn('[Reactji] auth.test failed for a token:', e.message);
    }
  }
  return workspaces;
}

// On load: identify workspaces and send tokens to background
(async () => {
  try {
    const workspaces = await identifyWorkspaces();
    if (workspaces.length > 0) {
      chrome.runtime.sendMessage({
        type: 'workspaces-found',
        workspaces: workspaces.map(w => ({
          token: w.token,
          userId: w.userId,
          teamId: w.teamId,
          teamName: w.teamName,
          teamUrl: w.teamUrl
        }))
      });
    }
  } catch (e) {
    console.warn('[Reactji] Initial workspace scan failed:', e.message);
  }
})();

// Listen for token extraction requests from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'extract-tokens') {
    identifyWorkspaces().then(workspaces => {
      sendResponse({ workspaces });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
});
