# Slack Reactji Notifications — Developer Guide

## Architecture

Chrome MV3 extension with three parts:

- **`content.js`** — Content script injected on `app.slack.com`. Extracts `xoxc-` tokens from localStorage and makes same-origin Slack API calls (the `d` cookie is HttpOnly, so same-origin fetch is the only way to include it). Acts as the API proxy for the background service worker.
- **`background.js`** — Service worker. Manages `chrome.alarms` for polling, diffs reaction state, fires `chrome.notifications`, and persists everything to `chrome.storage.local`.
- **`popup.html/js/css`** — Extension popup UI. Reads state from background via message passing. No direct API calls.

## Message flow

```
background.js  --[extract-tokens]-->  content.js  --> auth.test
background.js  --[poll-reactions]-->  content.js  --> search.messages + reactions.get
background.js  --[resolve-users]-->   content.js  --> users.info
popup.js       --[get-status]------>  background.js
popup.js       --[poll-now]-------->  background.js --> content.js
```

## Key design decisions

- **Content script makes all API calls** (not the service worker) because `xoxc-` tokens require the `d` cookie, which is HttpOnly and only sent on same-origin requests from `app.slack.com`.
- **Tokens stay in the content script**. The background receives workspace metadata (team ID, user ID) but requests polls via message passing, not by storing tokens.
- **`search.messages` + `reactions.get`** rather than `activity.feed` (internal API, unreliable with `xoxc-` tokens from `app.slack.com`).

## Storage schema

All state lives in `chrome.storage.local`:

```
workspaces[TEAM_ID].knownReactions[CHANNEL_TS][emoji] = [userIds]
recentReactions[] — last 50 entries, newest first
userNameCache[USER_ID] — display name, expires after 24h
settings — pollIntervalMinutes, notificationsEnabled, maxMessagesToCheck
```

## Testing

No test framework. To test manually:

1. Load unpacked in Chrome, open `app.slack.com`
2. Click extension popup — should show workspace as connected
3. Click refresh button — should update "Last checked" time
4. To test notifications without another person: temporarily remove `&& u !== ws.userId` from `content.js:68` and react to your own message
5. To inject a fake notification: open the service worker console from `chrome://extensions` and use `chrome.notifications.create()`

## Common changes

- **Add a new Slack API call**: Add handler in `content.js` message listener, send message from `background.js`
- **Change poll logic**: Edit `pollAllWorkspaces()` in `background.js`
- **Change notification format**: Edit the `chrome.notifications.create` call near the end of `pollAllWorkspaces()`
- **Add emoji mappings**: Extend `EMOJI_MAP` in `popup.js`
- **Change popup layout**: Edit `popup.html` and `popup.css`
