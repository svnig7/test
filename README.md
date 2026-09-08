# Auto Caption Bot (Cloudflare Worker)

Rewrites Telegram channel post captions automatically — prefix, suffix, and
find/replace rules — while preserving formatting (bold, links, expandable
blockquote, etc). Includes a force-subscribe gate for private-chat use.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Create a KV namespace:
   ```
   wrangler kv namespace create CAPTION_KV
   ```
   Paste the returned `id` into `wrangler.toml`.
3. Set secrets:
   ```
   wrangler secret put BOT_TOKEN
   wrangler secret put WEBHOOK_SECRET   # any random string
   wrangler secret put ADMIN_IDS        # comma-separated Telegram user IDs
   ```
4. Deploy:
   ```
   npm install
   npm run deploy
   ```
5. Register the webhook (one-time):
   ```
   curl "https://<your-worker>.workers.dev/set-webhook?secret=<WEBHOOK_SECRET>"
   ```
6. Add the bot as **admin** to your channel with "Edit messages" permission.

## Usage

DM the bot (as an admin ID) with:

| Command | Effect |
|---|---|
| `/setprefix <text>` | Prepend text to every caption |
| `/delprefix` | Remove prefix |
| `/setsuffix <text>` | Append text to every caption |
| `/delsuffix` | Remove suffix |
| `/addreplace <find> => <replace>` | Add a find/replace rule |
| `/delreplace <index>` | Remove rule by number (see `/listrules`) |
| `/listrules` | Show all replace rules |
| `/addremove <text>` | Strip a fixed piece of text entirely |
| `/delremove <index>` | Remove a strip rule by number (see `/listremove`) |
| `/listremove` | Show all strip rules |
| `/setforcesub <@channel>` | Require users to join a channel before using the bot in DM |
| `/delforcesub` | Disable force-sub |
| `/settings` | Show current config |

Once configured, any new post in the channel with a caption is automatically
rewritten in place via `editMessageCaption`.

## Notes

- Entities that fall entirely before/after a replaced substring are shifted
  and preserved; entities overlapping a replacement are dropped (Telegram
  gives no reliable way to remap them).
- `getChatMember` fails open (treated as subscribed) if the bot isn't yet an
  admin in the force-sub channel — add the bot there before relying on it.
