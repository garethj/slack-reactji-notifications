# Slack Reactji Notifications

A Chrome extension that sends you macOS notifications when someone reacts to your Slack messages.

Slack doesn't notify you about reactions. This fixes that.

## How it works

The extension piggybacks on the Slack web client's authentication. A content script runs on `app.slack.com`, extracts your `xoxc-` token from localStorage, and makes same-origin API calls (so the required `d` cookie is included automatically). No bot token or Slack app install needed.

Every 2 minutes, it:

1. Searches your recent messages that have reactions (`search.messages`)
2. Fetches full reaction data for each (`reactions.get`)
3. Diffs against stored state
4. Fires Chrome notifications for new reactions (which surface as macOS notifications)

## Install

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Open [app.slack.com](https://app.slack.com) — the extension connects automatically

## The popup

Click the extension icon to see:

- **Workspaces** — connection status for each workspace (green = connected)
- **Recent reactions** — who reacted, with what, on which message. Click to open in Slack
- **Settings** — toggle notifications, adjust poll interval (1/2/5/10 min), set how many messages to check

The refresh button triggers an immediate poll.

## Multiple workspaces

The extension discovers all workspaces you're signed into on `app.slack.com` and tracks reactions for each independently.

## Limitations

- Requires at least one `app.slack.com` tab open in Chrome
- Polls every 2 minutes, so notifications aren't instant
- Uses 1–21 API calls per poll cycle (1 search + up to 20 reactions.get)
- Custom emoji show as `:shortcode:` in the popup (common emoji render as unicode)
