// Service worker — handles alarms, diffing, notifications, state

const ALARM_NAME = 'poll-reactions';
const DEFAULT_POLL_INTERVAL = 2; // minutes
const MAX_RECENT_REACTIONS = 50;
const PRUNE_AGE_DAYS = 7;

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
    handleWorkspacesFound(msg.workspaces, sender.tab?.id);
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
  const { recentReactions } = await chrome.storage.local.get('recentReactions');
  const reaction = (recentReactions || []).find(r => r.id === notificationId);
  if (reaction?.permalink) {
    chrome.tabs.create({ url: reaction.permalink });
  }
  chrome.notifications.clear(notificationId);
});

// ── Core logic ──

async function handleWorkspacesFound(workspaces, tabId) {
  const data = await chrome.storage.local.get('workspaces');
  const stored = data.workspaces || {};

  for (const ws of workspaces) {
    stored[ws.teamId] = {
      ...stored[ws.teamId],
      teamName: ws.teamName,
      teamUrl: ws.teamUrl,
      userId: ws.userId,
      tabId,
      status: 'connected',
      knownReactions: stored[ws.teamId]?.knownReactions || {}
    };
  }

  await chrome.storage.local.set({ workspaces: stored });
}

async function findSlackTab() {
  const tabs = await chrome.tabs.query({ url: 'https://app.slack.com/*' });
  return tabs[0] || null;
}

async function pollAllWorkspaces() {
  const data = await chrome.storage.local.get(['workspaces', 'settings', 'recentReactions', 'userNameCache']);
  const workspaces = data.workspaces || {};
  const settings = data.settings || {};
  const maxMessages = settings.maxMessagesToCheck || 20;
  const notificationsEnabled = settings.notificationsEnabled !== false;
  let recentReactions = data.recentReactions || [];
  let userNameCache = data.userNameCache || {};

  const slackTab = await findSlackTab();
  if (!slackTab) {
    // No Slack tab — set badge indicator
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });

    // Mark all workspaces as no-tab
    for (const teamId of Object.keys(workspaces)) {
      workspaces[teamId].status = 'no-tab';
    }
    await chrome.storage.local.set({ workspaces, lastPollTime: Date.now(), lastPollError: 'No Slack tab open' });
    return;
  }

  // First extract fresh tokens
  let tokensResponse;
  try {
    tokensResponse = await chrome.tabs.sendMessage(slackTab.id, { type: 'extract-tokens' });
  } catch (e) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    await chrome.storage.local.set({ lastPollTime: Date.now(), lastPollError: 'Cannot reach Slack tab' });
    return;
  }

  if (tokensResponse?.error || !tokensResponse?.workspaces?.length) {
    await chrome.storage.local.set({ lastPollTime: Date.now(), lastPollError: 'No tokens found' });
    return;
  }

  let newReactionCount = 0;

  for (const ws of tokensResponse.workspaces) {
    const teamId = ws.teamId;
    if (!workspaces[teamId]) {
      workspaces[teamId] = { knownReactions: {} };
    }
    workspaces[teamId].teamName = ws.teamName;
    workspaces[teamId].teamUrl = ws.teamUrl;
    workspaces[teamId].userId = ws.userId;
    workspaces[teamId].tabId = slackTab.id;
    workspaces[teamId].status = 'connected';

    // Poll reactions via content script
    let pollResult;
    try {
      pollResult = await chrome.tabs.sendMessage(slackTab.id, {
        type: 'poll-reactions',
        token: ws.token,
        userId: ws.userId,
        maxMessages
      });
    } catch (e) {
      workspaces[teamId].status = 'error';
      workspaces[teamId].lastError = e.message;
      continue;
    }

    if (!pollResult?.ok) {
      if (pollResult?.error === 'invalid_auth' || pollResult?.error === 'token_revoked') {
        workspaces[teamId].status = 'token-expired';
      } else if (pollResult?.error === 'ratelimited') {
        workspaces[teamId].status = 'rate-limited';
        // Back off: double the alarm interval temporarily
        const currentInterval = settings.pollIntervalMinutes || DEFAULT_POLL_INTERVAL;
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: currentInterval * 2 });
        setTimeout(() => {
          chrome.alarms.create(ALARM_NAME, { periodInMinutes: currentInterval });
        }, currentInterval * 2 * 60 * 1000);
      } else {
        workspaces[teamId].status = 'error';
        workspaces[teamId].lastError = pollResult?.error || 'Unknown error';
      }
      continue;
    }

    // Diff reactions
    const known = workspaces[teamId].knownReactions || {};
    const unknownUserIds = new Set();

    for (const [msgKey, msgData] of Object.entries(pollResult.reactions)) {
      if (!known[msgKey]) known[msgKey] = {};

      for (const reaction of msgData.reactions) {
        if (!known[msgKey][reaction.name]) known[msgKey][reaction.name] = [];

        const knownUsers = new Set(known[msgKey][reaction.name]);
        const newUsers = reaction.users.filter(u => !knownUsers.has(u) && u !== ws.userId);

        for (const userId of newUsers) {
          if (!userNameCache[userId] || (Date.now() - (userNameCache[userId + '_ts'] || 0)) > 86400000) {
            unknownUserIds.add(userId);
          }
        }

        if (newUsers.length > 0) {
          known[msgKey][reaction.name] = reaction.users;

          for (const userId of newUsers) {
            newReactionCount++;
            const reactionEntry = {
              id: `${teamId}_${msgKey}_${reaction.name}_${userId}_${Date.now()}`,
              teamId,
              teamName: ws.teamName,
              channel: msgData.channelName,
              messageText: msgData.messageText,
              permalink: msgData.permalink,
              reactionName: reaction.name,
              reactorId: userId,
              reactorName: null, // resolved below
              timestamp: Date.now()
            };
            recentReactions.unshift(reactionEntry);
          }
        } else {
          // Update known users even if no new ones (handles removed reactions)
          known[msgKey][reaction.name] = reaction.users;
        }
      }
    }

    workspaces[teamId].knownReactions = known;

    // Resolve unknown user names
    if (unknownUserIds.size > 0) {
      try {
        const resolveResult = await chrome.tabs.sendMessage(slackTab.id, {
          type: 'resolve-users',
          token: ws.token,
          userIds: [...unknownUserIds]
        });
        if (resolveResult?.nameMap) {
          for (const [uid, name] of Object.entries(resolveResult.nameMap)) {
            userNameCache[uid] = name;
            userNameCache[uid + '_ts'] = Date.now();
          }
        }
      } catch (e) {
        console.warn('[Reactji] User resolution failed:', e.message);
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

  // Prune old known reactions
  const pruneThreshold = Date.now() - PRUNE_AGE_DAYS * 86400000;
  for (const teamId of Object.keys(workspaces)) {
    const known = workspaces[teamId].knownReactions || {};
    // We can't easily know message age from the key, so prune by count
    const keys = Object.keys(known);
    if (keys.length > 100) {
      const toRemove = keys.slice(0, keys.length - 100);
      for (const k of toRemove) delete known[k];
    }
  }

  // Save state
  await chrome.storage.local.set({
    workspaces,
    recentReactions,
    userNameCache,
    lastPollTime: Date.now(),
    lastPollError: null
  });

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
      lastError: ws.lastError
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

  // Update alarm interval if changed
  if (newSettings.pollIntervalMinutes) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: newSettings.pollIntervalMinutes });
  }
}
