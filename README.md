# StoryCast

Post one Telegram Story (video or photo) to many of **your own** Telegram accounts.

## Start
Double-click `Start.bat` (or `npm start`).

## First time
1. Settings: get a free API ID + hash at https://my.telegram.org/apps and paste them.
2. Accounts: + Add account → phone number → code from Telegram → (2-step password if you have one).
3. Post Story: pick the video/photo, caption, who can see it, how long, choose accounts → Post.

## Notes
- Logins are stored only on this PC (`%APPDATA%\StoryCast`), encrypted with Windows safeStorage.
- Posts go one account at a time with a random wait, so it doesn't look like spam.
- Free accounts: a few Stories per day, 24h only. Premium: more Stories, 6/12/48h.
- Scheduled posts need the app to stay open.
- Uses GramJS (`telegram` npm 2.26.x, archived; `teleproto` is the maintained fork if updates are needed).
