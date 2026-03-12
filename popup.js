document.addEventListener('DOMContentLoaded', async () => {
  const pollBtn = document.getElementById('poll-now');
  const workspacesEl = document.getElementById('workspaces');
  const lastPollEl = document.getElementById('last-poll');
  const reactionsListEl = document.getElementById('reactions-list');
  const noReactionsEl = document.getElementById('no-reactions');
  const notifToggle = document.getElementById('notifications-enabled');
  const pollIntervalEl = document.getElementById('poll-interval');
  const maxMessagesEl = document.getElementById('max-messages');

  // Clear badge when popup opens
  chrome.runtime.sendMessage({ type: 'clear-badge' });

  // Load status
  async function refresh() {
    const status = await chrome.runtime.sendMessage({ type: 'get-status' });
    renderWorkspaces(status.workspaces);
    renderReactions(status.recentReactions);
    renderLastPoll(status.lastPollTime, status.lastPollError);
    applySettings(status.settings);
  }

  function renderWorkspaces(workspaces) {
    if (!workspaces.length) {
      workspacesEl.innerHTML = '<div class="meta">No workspaces found. Open app.slack.com to connect.</div>';
      return;
    }
    workspacesEl.innerHTML = workspaces.map(ws => {
      const statusLabels = {
        connected: 'Connected',
        'no-tab': 'Slack not open',
        'token-expired': 'Token expired — re-login to Slack',
        'rate-limited': 'Rate limited — backing off',
        error: ws.lastError || 'Error'
      };
      return `<div class="workspace">
        <span class="dot ${ws.status}"></span>
        <span class="name">${escapeHtml(ws.teamName || ws.teamId)}</span>
        <span class="status-text">${statusLabels[ws.status] || ws.status}</span>
      </div>`;
    }).join('');
  }

  function renderReactions(reactions) {
    if (!reactions || !reactions.length) {
      reactionsListEl.innerHTML = '';
      noReactionsEl.style.display = 'block';
      return;
    }
    noReactionsEl.style.display = 'none';
    reactionsListEl.innerHTML = reactions.map(r => {
      const timeAgo = formatTimeAgo(r.timestamp);
      const emoji = emojiShortcodeToUnicode(r.reactionName) || `:${r.reactionName}:`;
      return `<div class="reaction-item" data-permalink="${escapeHtml(r.permalink || '')}">
        <span class="reaction-emoji">${emoji}</span>
        <div class="reaction-details">
          <div class="reaction-who">${escapeHtml(r.reactorName || 'Someone')}</div>
          <div class="reaction-message">${escapeHtml(r.messageText || '')}</div>
          <div class="reaction-meta">#${escapeHtml(r.channel)} · ${escapeHtml(r.teamName || '')} · ${timeAgo}</div>
        </div>
      </div>`;
    }).join('');

    // Click to open permalink
    reactionsListEl.querySelectorAll('.reaction-item').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.dataset.permalink;
        if (url) chrome.tabs.create({ url });
      });
    });
  }

  function renderLastPoll(time, error) {
    if (!time) {
      lastPollEl.textContent = 'Not polled yet';
      return;
    }
    const ago = formatTimeAgo(time);
    lastPollEl.textContent = `Last checked ${ago}` + (error ? ` · ${error}` : '');
  }

  function applySettings(settings) {
    notifToggle.checked = settings.notificationsEnabled !== false;
    pollIntervalEl.value = String(settings.pollIntervalMinutes || 2);
    maxMessagesEl.value = String(settings.maxMessagesToCheck || 20);
  }

  // Poll now button
  pollBtn.addEventListener('click', async () => {
    pollBtn.disabled = true;
    pollBtn.textContent = '...';
    await chrome.runtime.sendMessage({ type: 'poll-now' });
    pollBtn.disabled = false;
    pollBtn.textContent = '\u21bb';
    refresh();
  });

  // Settings changes
  notifToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'update-settings', settings: { notificationsEnabled: notifToggle.checked } });
  });

  pollIntervalEl.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'update-settings', settings: { pollIntervalMinutes: parseInt(pollIntervalEl.value) } });
  });

  maxMessagesEl.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'update-settings', settings: { maxMessagesToCheck: parseInt(maxMessagesEl.value) } });
  });

  // Helpers
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Common emoji shortcodes to unicode mapping
  const EMOJI_MAP = {
    '+1': '\uD83D\uDC4D', thumbsup: '\uD83D\uDC4D', '-1': '\uD83D\uDC4E', thumbsdown: '\uD83D\uDC4E',
    heart: '\u2764\uFE0F', tada: '\uD83C\uDF89', joy: '\uD83D\uDE02', fire: '\uD83D\uDD25',
    eyes: '\uD83D\uDC40', rocket: '\uD83D\uDE80', white_check_mark: '\u2705', x: '\u274C',
    pray: '\uD83D\uDE4F', clap: '\uD83D\uDC4F', raised_hands: '\uD83D\uDE4C', muscle: '\uD83D\uDCAA',
    100: '\uD83D\uDCAF', star: '\u2B50', sparkles: '\u2728', wave: '\uD83D\uDC4B',
    thinking_face: '\uD83E\uDD14', heavy_plus_sign: '\u2795', bulb: '\uD83D\uDCA1', memo: '\uD83D\uDCDD',
    point_up: '\u261D\uFE0F', ok_hand: '\uD83D\uDC4C', boom: '\uD83D\uDCA5', party_parrot: '\uD83E\uDD9C',
    sob: '\uD83D\uDE2D', sweat_smile: '\uD83D\uDE05', slightly_smiling_face: '\uD83D\uDE42',
    rolling_on_the_floor_laughing: '\uD83E\uDD23', hugging_face: '\uD83E\uDD17',
    see_no_evil: '\uD83D\uDE48', hear_no_evil: '\uD83D\uDE49', speak_no_evil: '\uD83D\uDE4A',
    trophy: '\uD83C\uDFC6', medal: '\uD83C\uDFC5', gem: '\uD83D\uDC8E', crown: '\uD83D\uDC51',
    checkered_flag: '\uD83C\uDFC1', warning: '\u26A0\uFE0F', question: '\u2753', exclamation: '\u2757',
    zzz: '\uD83D\uDCA4', hourglass: '\u231B', stopwatch: '\u23F1\uFE0F',
    green_heart: '\uD83D\uDC9A', blue_heart: '\uD83D\uDC99', purple_heart: '\uD83D\uDC9C',
    broken_heart: '\uD83D\uDC94', two_hearts: '\uD83D\uDC95', heartbeat: '\uD83D\uDC93',
    thumbsup_all: '\uD83D\uDC4D', heavy_check_mark: '\u2714\uFE0F', ballot_box_with_check: '\u2611\uFE0F',
    coffee: '\u2615', beer: '\uD83C\uDF7A', pizza: '\uD83C\uDF55', cake: '\uD83C\uDF82'
  };

  function emojiShortcodeToUnicode(code) {
    return EMOJI_MAP[code] || null;
  }

  refresh();
});
