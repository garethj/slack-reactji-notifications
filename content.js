// Content script — runs on app.slack.com
// Extracts xoxc- tokens and makes same-origin API calls (cookies auto-included)

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

async function pollReactions(token, userId, maxMessages) {
  // Search for recent messages with reactions
  const searchResult = await slackApi('search.messages', token, {
    query: 'has:reaction from:me',
    count: String(maxMessages),
    sort: 'timestamp',
    sort_dir: 'desc'
  });

  if (!searchResult.ok) {
    return { ok: false, error: searchResult.error };
  }

  const messages = searchResult.messages?.matches || [];
  const reactions = {};

  for (const msg of messages) {
    const channel = msg.channel?.id;
    const ts = msg.ts;
    if (!channel || !ts) continue;

    const reactionsResult = await slackApi('reactions.get', token, {
      channel,
      timestamp: ts,
      full: 'true'
    });

    if (reactionsResult.ok && reactionsResult.message?.reactions) {
      const key = `${channel}_${ts}`;
      reactions[key] = {
        channel,
        channelName: msg.channel?.name || 'unknown',
        ts,
        messageText: (msg.text || '').substring(0, 100),
        permalink: msg.permalink || '',
        reactions: reactionsResult.message.reactions.map(r => ({
          name: r.name,
          users: r.users || []
        }))
      };
    }
  }

  return { ok: true, reactions };
}

async function resolveUsers(token, userIds) {
  const nameMap = {};
  for (const userId of userIds) {
    try {
      const result = await slackApi('users.info', token, { user: userId });
      if (result.ok) {
        nameMap[userId] = result.user?.profile?.display_name
          || result.user?.profile?.real_name
          || result.user?.name
          || userId;
      }
    } catch (e) {
      console.warn(`[Reactji] users.info failed for ${userId}:`, e.message);
    }
  }
  return nameMap;
}

// On load: identify workspaces and report to background
(async () => {
  try {
    const workspaces = await identifyWorkspaces();
    if (workspaces.length > 0) {
      chrome.runtime.sendMessage({
        type: 'workspaces-found',
        workspaces: workspaces.map(w => ({
          userId: w.userId,
          teamId: w.teamId,
          teamName: w.teamName,
          teamUrl: w.teamUrl
          // Token stored in content script only, not sent to background
        }))
      });
    }
  } catch (e) {
    console.warn('[Reactji] Initial workspace scan failed:', e.message);
  }
})();

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'extract-tokens') {
    identifyWorkspaces().then(workspaces => {
      sendResponse({ workspaces });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true; // async response
  }

  if (msg.type === 'poll-reactions') {
    pollReactions(msg.token, msg.userId, msg.maxMessages || 20).then(result => {
      sendResponse(result);
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  if (msg.type === 'resolve-users') {
    resolveUsers(msg.token, msg.userIds).then(nameMap => {
      sendResponse({ nameMap });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
});
