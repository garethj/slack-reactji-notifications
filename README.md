# Slack Reactji Notifications

A Chrome extension that sends you macOS notifications when someone reacts to your Slack messages.

Slack doesn't notify you about reactions. This fixes that.

## How it works

The extension piggybacks on the Slack web client's authentication. A content script runs on `app.slack.com` to extract your `xoxc-` token from localStorage. The background service worker then makes Slack API calls directly, using `chrome.cookies` to include the `d` session cookie. No bot token or Slack app install needed.

Every 2 minutes, it:

1. Searches your recent messages that have reactions (`search.messages`)
2. Fetches full reaction data for each (`reactions.get`)
3. Diffs against a persistent "notified" set (not just "seen")
4. Fires Chrome notifications for new reactions (which surface as macOS notifications)

Once you've signed in to `app.slack.com` at least once, **you don't need to keep a Slack tab open**. The extension stores your token and uses your browser's session cookie directly. It also tracks exactly which reactions have been notified, so if Chrome was closed over the weekend, you'll get notifications for any reactions you missed when it next polls (within 7 days).

## Install

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Open [app.slack.com](https://app.slack.com) once — the extension extracts your token and connects
6. You can close the Slack tab after that — polling continues in the background

## The popup

Click the extension icon to see:

- **Workspaces** — connection status for each workspace (green = connected)
- **Recent reactions** — who reacted, with what, on which message. Click to open in Slack
- **Settings** — toggle notifications, adjust poll interval (1/2/5/10 min), set how many messages to check

The refresh button triggers an immediate poll.

## Multiple workspaces

The extension discovers all workspaces you're signed into on `app.slack.com` and tracks reactions for each independently.

## Disconnect alerts

If the extension can't reach Slack (expired session, expired token), it shows a notification telling you to open `app.slack.com`. This only fires once per disconnection, not every poll cycle.

## Limitations

- Needs at least one Chrome profile window open (closing all windows stops the service worker)
- Polls every 2 minutes, so notifications aren't instant
- Uses 1–21 API calls per poll cycle (1 search + up to 20 reactions.get)
- Custom emoji show as `:shortcode:` in the popup (common emoji render as unicode)
- Session cookie and token can expire — you'll get a notification to re-open Slack when this happens
