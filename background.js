// Service worker — handles alarms, diffing, notifications, state
// Makes Slack API calls directly using stored tokens + d cookie via chrome.cookies

const ALARM_NAME = 'poll-reactions';
const DEFAULT_POLL_INTERVAL = 2; // minutes
const MAX_RECENT_REACTIONS = 50;
const PRUNE_AGE_DAYS = 7;
const PRUNE_AGE_MS = PRUNE_AGE_DAYS * 86400000;

// ── Slack API helper ──

async function getSlackCookie() {
  const cookie = await chrome.cookies.get({ url: 'https://app.slack.com', name: 'd' });
  return cookie?.value || null;
}

async function slackApi(method, token, params = {}) {
  const cookieValue = await getSlackCookie();
  if (!cookieValue) {
    return { ok: false, error: 'no_cookie' };
  }

  const body = new URLSearchParams({ token, ...params });
  // credentials: 'include' tells the browser to attach cookies from its jar
  // for the target domain (including the HttpOnly 'd' cookie).
  // Manually setting Cookie header doesn't work — it's a forbidden header in fetch().
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    body,
    credentials: 'include'
  });
  if (!res.ok) {
    return { ok: false, error: `http_${res.status}` };
  }
  return res.json();
}

// ── Alarm setup ──

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    pollAllWorkspaces();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const interval = settings?.pollIntervalMinutes || DEFAULT_POLL_INTERVAL;
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
});

chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const interval = settings?.pollIntervalMinutes || DEFAULT_POLL_INTERVAL;
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
});

// ── Messages from content script and popup ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'workspaces-found') {
    handleWorkspacesFound(msg.workspaces);
  }

  if (msg.type === 'poll-now') {
    pollAllWorkspaces().then(() => sendResponse({ done: true }));
    return true;
  }

  if (msg.type === 'get-status') {
    getStatus().then(status => sendResponse(status));
    return true;
  }

  if (msg.type === 'update-settings') {
    updateSettings(msg.settings).then(() => sendResponse({ done: true }));
    return true;
  }

  if (msg.type === 'clear-badge') {
    chrome.action.setBadgeText({ text: '' });
  }
});

// ── Notification click ──

chrome.notifications.onClicked.addListener(async notificationId => {
  if (notificationId === 'disconnected') return;
  const { recentReactions } = await chrome.storage.local.get('recentReactions');
  const reaction = (recentReactions || []).find(r => r.id === notificationId);
  if (reaction?.permalink) {
    chrome.tabs.create({ url: reaction.permalink });
  }
  chrome.notifications.clear(notificationId);
});

// ── Core logic ──

async function handleWorkspacesFound(workspaces) {
  const data = await chrome.storage.local.get('workspaces');
  const stored = data.workspaces || {};

  for (const ws of workspaces) {
    stored[ws.teamId] = {
      ...stored[ws.teamId],
      teamName: ws.teamName,
      teamUrl: ws.teamUrl,
      userId: ws.userId,
      token: ws.token,
      status: 'connected'
    };
  }

  await chrome.storage.local.set({ workspaces: stored });
}

async function refreshTokensFromTab() {
  const tabs = await chrome.tabs.query({ url: 'https://app.slack.com/*' });
  if (!tabs.length) return false;

  try {
    const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'extract-tokens' });
    if (response?.workspaces?.length) {
      await handleWorkspacesFound(response.workspaces);
      return true;
    }
  } catch (e) {
    // Content script not reachable — tab might be loading
  }
  return false;
}

async function pollAllWorkspaces() {
  const data = await chrome.storage.local.get([
    'workspaces', 'settings', 'recentReactions', 'userNameCache',
    'notifiedReactions', 'wasConnected'
  ]);
  const workspaces = data.workspaces || {};
  const settings = data.settings || {};
  const maxMessages = settings.maxMessagesToCheck || 20;
  const notificationsEnabled = settings.notificationsEnabled !== false;
  let recentReactions = data.recentReactions || [];
  let userNameCache = data.userNameCache || {};
  let notifiedReactions = data.notifiedReactions || {};
  let wasConnected = data.wasConnected !== false; // default true to avoid notifying on first install

  // Try to refresh tokens from a Slack tab if one is open
  await refreshTokensFromTab();

  // Re-read workspaces in case tokens were refreshed
  const freshData = await chrome.storage.local.get('workspaces');
  const freshWorkspaces = freshData.workspaces || {};

  // Check if we have any workspaces with tokens
  const workspaceEntries = Object.entries(freshWorkspaces).filter(([, ws]) => ws.token);
  if (!workspaceEntries.length) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });

    // Notify on transition to disconnected
    if (wasConnected) {
      chrome.notifications.create('disconnected', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Slack Reactji: Not connected',
        message: 'Open app.slack.com and sign in to enable reaction notifications.',
        priority: 1
      });
    }

    await chrome.storage.local.set({
      lastPollTime: Date.now(),
      lastPollError: 'No workspaces connected. Open app.slack.com to set up.',
      wasConnected: false
    });
    return;
  }

  // Check we have the d cookie
  const cookieValue = await getSlackCookie();
  if (!cookieValue) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });

    if (wasConnected) {
      chrome.notifications.create('disconnected', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Slack Reactji: Session expired',
        message: 'Open app.slack.com to refresh your session.',
        priority: 1
      });
    }

    for (const [teamId] of workspaceEntries) {
      freshWorkspaces[teamId].status = 'no-cookie';
    }
    await chrome.storage.local.set({
      workspaces: freshWorkspaces,
      lastPollTime: Date.now(),
      lastPollError: 'Slack session cookie missing. Open app.slack.com to refresh.',
      wasConnected: false
    });
    return;
  }

  let anySuccess = false;
  let newReactionCount = 0;

  for (const [teamId, ws] of workspaceEntries) {
    // Search for recent messages from the user.
    // We search for "from:me" without "has:reaction" because Slack's search
    // index can lag behind for reaction metadata — a message that just received
    // a reaction may not yet have has:reaction indexed.
    // We also search by date range (last 7 days) rather than relying on sort
    // order, since sorting by message timestamp misses old messages that received
    // new reactions recently.
    const afterDate = new Date(Date.now() - PRUNE_AGE_MS).toISOString().split('T')[0];
    const searchResult = await slackApi('search.messages', ws.token, {
      query: `from:me after:${afterDate}`,
      count: String(Math.min(maxMessages * 5, 100)),
      sort: 'timestamp',
      sort_dir: 'desc'
    });

    if (!searchResult.ok) {
      if (searchResult.error === 'invalid_auth' || searchResult.error === 'token_revoked') {
        freshWorkspaces[teamId].status = 'token-expired';
        freshWorkspaces[teamId].token = null; // Clear bad token
      } else if (searchResult.error === 'ratelimited') {
        freshWorkspaces[teamId].status = 'rate-limited';
        const currentInterval = settings.pollIntervalMinutes || DEFAULT_POLL_INTERVAL;
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: currentInterval * 2 });
        setTimeout(() => {
          chrome.alarms.create(ALARM_NAME, { periodInMinutes: currentInterval });
        }, currentInterval * 2 * 60 * 1000);
      } else if (searchResult.error === 'no_cookie') {
        freshWorkspaces[teamId].status = 'no-cookie';
      } else {
        freshWorkspaces[teamId].status = 'error';
        freshWorkspaces[teamId].lastError = searchResult.error || 'Unknown error';
      }
      continue;
    }

    anySuccess = true;
    freshWorkspaces[teamId].status = 'connected';
    freshWorkspaces[teamId].lastError = null;

    const messages = searchResult.messages?.matches || [];
    const unknownUserIds = new Set();

    for (const msg of messages) {
      const channel = msg.channel?.id;
      const ts = msg.ts;
      if (!channel || !ts) continue;

      // Skip messages older than 7 days
      const msgAge = Date.now() - (parseFloat(ts) * 1000);
      if (msgAge > PRUNE_AGE_MS) continue;

      const reactionsResult = await slackApi('reactions.get', ws.token, {
        channel,
        timestamp: ts,
        full: 'true'
      });

      if (!reactionsResult.ok || !reactionsResult.message?.reactions) continue;

      const channelName = msg.channel?.name || 'unknown';
      const messageText = (msg.text || '').substring(0, 100);
      const permalink = msg.permalink || '';

      for (const reaction of reactionsResult.message.reactions) {
        for (const userId of (reaction.users || [])) {
          // if (userId === ws.userId) continue; // Skip self-reactions — disabled for testing

          const reactionKey = `${channel}_${ts}_${reaction.name}_${userId}`;

          if (notifiedReactions[reactionKey]) continue; // Already notified

          // Collect unknown user IDs for name resolution
          if (!userNameCache[userId] || (Date.now() - (userNameCache[userId + '_ts'] || 0)) > 86400000) {
            unknownUserIds.add(userId);
          }

          // Mark as notified
          notifiedReactions[reactionKey] = Date.now();
          newReactionCount++;

          const reactionEntry = {
            id: `${teamId}_${reactionKey}_${Date.now()}`,
            teamId,
            teamName: ws.teamName,
            channel: channelName,
            messageText,
            permalink,
            reactionName: reaction.name,
            reactorId: userId,
            reactorName: null, // resolved below
            timestamp: Date.now()
          };
          recentReactions.unshift(reactionEntry);
        }
      }
    }

    // Resolve unknown user names
    if (unknownUserIds.size > 0) {
      for (const userId of unknownUserIds) {
        const result = await slackApi('users.info', ws.token, { user: userId });
        if (result.ok) {
          userNameCache[userId] = result.user?.profile?.display_name
            || result.user?.profile?.real_name
            || result.user?.name
            || userId;
          userNameCache[userId + '_ts'] = Date.now();
        }
      }
    }

    // Fill in reactor names in recent reactions
    for (const entry of recentReactions) {
      if (!entry.reactorName && userNameCache[entry.reactorId]) {
        entry.reactorName = userNameCache[entry.reactorId];
      }
    }
  }

  // Trim recent reactions
  recentReactions = recentReactions.slice(0, MAX_RECENT_REACTIONS);

  // Prune old notified reactions (older than 7 days)
  const now = Date.now();
  for (const key of Object.keys(notifiedReactions)) {
    if (now - notifiedReactions[key] > PRUNE_AGE_MS) {
      delete notifiedReactions[key];
    }
  }

  // Handle connection state transitions for disconnect notification
  const isConnected = anySuccess;
  if (!isConnected && wasConnected) {
    // All workspaces failed — notify
    const errorSummary = workspaceEntries.map(([, ws]) => ws.status).join(', ');
    chrome.notifications.create('disconnected', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Slack Reactji: Connection lost',
      message: `Cannot reach Slack (${errorSummary}). Open app.slack.com to reconnect.`,
      priority: 1
    });
  }

  // Save state
  await chrome.storage.local.set({
    workspaces: freshWorkspaces,
    recentReactions,
    userNameCache,
    notifiedReactions,
    lastPollTime: Date.now(),
    lastPollError: isConnected ? null : 'Poll failed for all workspaces',
    wasConnected: isConnected
  });

  // Clear error badge on success
  if (isConnected) {
    const currentBadge = await chrome.action.getBadgeText({});
    if (currentBadge === '!') {
      chrome.action.setBadgeText({ text: '' });
    }
  }

  // Send notifications for new reactions
  if (notificationsEnabled && newReactionCount > 0) {
    const newEntries = recentReactions.slice(0, newReactionCount);
    for (const entry of newEntries) {
      const reactorName = entry.reactorName || 'Someone';
      chrome.notifications.create(entry.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `:${entry.reactionName}: on your message`,
        message: `${reactorName} reacted in #${entry.channel}`,
        contextMessage: entry.messageText.substring(0, 60),
        priority: 1
      });
    }
  }

  // Update badge
  if (newReactionCount > 0) {
    const currentBadge = await chrome.action.getBadgeText({});
    const currentCount = parseInt(currentBadge) || 0;
    chrome.action.setBadgeText({ text: String(currentCount + newReactionCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  }
}

async function getStatus() {
  const data = await chrome.storage.local.get(['workspaces', 'recentReactions', 'settings', 'lastPollTime', 'lastPollError']);
  return {
    workspaces: Object.entries(data.workspaces || {}).map(([teamId, ws]) => ({
      teamId,
      teamName: ws.teamName,
      status: ws.status,
      lastError: ws.lastError,
      hasToken: !!ws.token
    })),
    recentReactions: (data.recentReactions || []).slice(0, 20),
    settings: data.settings || { pollIntervalMinutes: DEFAULT_POLL_INTERVAL, notificationsEnabled: true, maxMessagesToCheck: 20 },
    lastPollTime: data.lastPollTime,
    lastPollError: data.lastPollError
  };
}

async function updateSettings(newSettings) {
  const { settings: current } = await chrome.storage.local.get('settings');
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ settings: merged });

  if (newSettings.pollIntervalMinutes) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: newSettings.pollIntervalMinutes });
  }
}
