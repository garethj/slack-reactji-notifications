# Slack Reactji Notifications — Developer Guide

## Architecture

Chrome MV3 extension with three parts:

- **`content.js`** — Content script injected on `app.slack.com`. Extracts `xoxc-` tokens from localStorage and sends them to the background. Only runs when a Slack tab is open.
- **`background.js`** — Service worker. Makes all Slack API calls directly using stored tokens + the `d` cookie (read via `chrome.cookies`). Manages polling, reaction diffing, notifications, and state persistence.
- **`popup.html/js/css`** — Extension popup UI. Reads state from background via message passing. No direct API calls.

## Message flow

```
content.js     --[workspaces-found]-->  background.js  (on page load, sends tokens)
background.js  --[extract-tokens]---->  content.js     (refresh tokens if tab exists)
background.js  --> fetch slack.com/api/*  (direct API calls with d cookie)
popup.js       --[get-status]-------->  background.js
popup.js       --[poll-now]---------->  background.js
```

## Key design decisions

- **Service worker makes all API calls** using `fetch()` with `credentials: 'include'` to call `slack.com/api/*`. The browser attaches the HttpOnly `d` cookie automatically from its cookie jar (manually setting a `Cookie` header is forbidden in fetch). `chrome.cookies.get()` is used only as a pre-check to verify the cookie exists before attempting API calls. This means polling works even when no Slack tab is open.
- **Content script only extracts tokens**. It runs on `app.slack.com` to read `xoxc-` tokens from localStorage (which only the content script can access). Tokens are sent to the background and stored.
- **`notifiedReactions` tracks what's been shown** as a notification, not just what's been seen. On reconnect after downtime, any reaction within 7 days that hasn't been notified will trigger a notification. This prevents missed reactions over weekends, laptop shutdowns, etc.
- **Disconnect notifications** fire once on transition from connected to disconnected (not every poll cycle), prompting the user to open Slack.
- **`search.messages` + `reactions.get`** rather than `activity.feed` (internal API, unreliable with `xoxc-` tokens).

## Storage schema

All state lives in `chrome.storage.local`:

```
workspaces[TEAM_ID].token — xoxc- token (stored for use without Slack tab)
workspaces[TEAM_ID].{teamName, teamUrl, userId, status, lastError}
notifiedReactions[CHANNEL_TS_emoji_userId] = timestamp — tracks which reaction instances have been notified
recentReactions[] — last 50 entries, newest first
userNameCache[USER_ID] — display name, expires after 24h
settings — pollIntervalMinutes, notificationsEnabled, maxMessagesToCheck
wasConnected — boolean, used for disconnect notification transitions
```

## Testing

No test framework. To test manually:

1. Load unpacked in Chrome, open `app.slack.com`
2. Click extension popup — should show workspace as connected
3. Click refresh button — should update "Last checked" time
4. Close the Slack tab — next poll should still work (using stored token + cookie)
5. To test notifications without another person: temporarily remove `if (userId === ws.userId) continue;` from `background.js` and react to your own message
6. To inject a fake notification: open the service worker console from `chrome://extensions` and use `chrome.notifications.create()`
7. To test disconnect notification: clear stored tokens via `chrome.storage.local.set({workspaces: {}, wasConnected: true})` in the service worker console, then wait for next poll

## Common changes

- **Add a new Slack API call**: Use the `slackApi(method, token, params)` helper in `background.js`
- **Change poll logic**: Edit `pollAllWorkspaces()` in `background.js`
- **Change notification format**: Edit the `chrome.notifications.create` call near the end of `pollAllWorkspaces()`
- **Add emoji mappings**: Extend `EMOJI_MAP` in `popup.js`
- **Change popup layout**: Edit `popup.html` and `popup.css`
