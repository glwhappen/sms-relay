# SMS Relay

Multi-user ephemeral SMS verification-code relay.  
Anyone pushes codes with any token, then views them with the same token.  
Different tokens get completely isolated message lists.

## Quick Start

```bash
# single line — runs on 127.0.0.1:8787 by default
node server.mjs

# with custom port & bind address
PORT=8787 HOST=0.0.0.0 node server.mjs
```

There is **no** `TOKEN` environment variable. Every user picks their own token at the login page.

## Push an SMS

```bash
curl -X POST http://127.0.0.1:8787/sms \
  -H 'X-Token: my-secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"text":"【Some Site】Verification code 123456, expires in 5 min"}'
```

The token can be literally anything; it's only used to group your messages together.  
You can also POST `text/plain` or `application/x-www-form-urlencoded`.  
The server extracts a 4–8 digit code automatically.

## View

Open `http://127.0.0.1:8787/` in a browser.

- Enter your token on the login page.
- The page polls every 3 seconds and shows live codes.
- Click any verification code to copy it.

## Clear Messages

```bash
curl -X DELETE http://127.0.0.1:8787/api/messages -H 'X-Token: my-secret-token'
```

There is also a **🗑 清空** button on the page.

## Features

- **Multi-user**: each token sees only its own messages. No registration, no accounts.
- **Automatic cleanup**: messages older than 30 minutes are deleted. Maximum 50 messages per user.
- **Light/dark theme**: toggle with the 🌙/☀️ button, preference saved to localStorage.
- **Usage tutorial**: click 「📖 如何使用？」 on the login page for a quick guide with curl examples.
- **In-memory only**: restarting the process clears everything.
- **Single file**: drop `server.mjs` anywhere, Node.js 18+ is enough.

## Deploy

```bash
# behind a reverse proxy (Caddy / nginx)
# make sure to set HOST to the proxy-facing address
PORT=8787 HOST=127.0.0.1 node server.mjs
```

## Security

- Put it behind HTTPS if exposed to the internet.
- Tokens are not passwords — they're just grouping keys. But still, don't reuse important tokens.
- The page has `robots: noindex, nofollow`.
