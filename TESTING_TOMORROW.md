# Playtest runbook — read this before your friends show up

## 1. Start everything
Double-click `tools\start-playtest.bat`. It opens two windows:

1. **"MMOProject Server"** — the actual game (`npm run dev`). Leave it running.
2. **"MMOProject Tunnel - SHARE THIS URL"** — makes the game reachable over the
   internet. After a few seconds it prints a box with a URL like:
   ```
   https://some-random-words.trycloudflare.com
   ```
   **That https:// link is what you paste to your friends.** No router setup,
   no port forwarding, nothing else needed — the tunnel makes an outbound
   connection from your PC, so your home network doesn't need any changes.

If Windows SmartScreen warns about `cloudflared.exe` the first time, click
**More info → Run anyway**. That's expected for a freshly downloaded tool.

**Keep both windows open the whole time.** If the tunnel window ever closes and
you restart it, you'll get a **different** URL — re-share it with everyone.

## 2. Tell your friends
- Send them the `https://...trycloudflare.com` link.
- They pick a username. **New** characters now also set a password
  (min 4 characters) — this stops one friend from being able to type another
  friend's name and play as them, now that the link is genuinely open to
  anyone who has it. Make sure everyone knows to remember their password.
- Your own existing account has no password and doesn't need one — it'll log
  in exactly like it always has.

## 3. Known rough edges (deliberate, not bugs)
- **Mobile isn't polished.** The map-drawing exploration mechanic is
  mouse-drag based, not touch-friendly. Fine to try on a phone, but tell
  friends a laptop/desktop will feel much better.
- **Everyone shares one save file** (`data/db.json`) on your PC. That's by
  design for this test — there's no separate server, your machine *is* the
  server.
- Extensive backend testing (concurrency, malformed input, a full multiplayer
  pass) was already done in earlier sessions — see `mmoproject_roadmap`
  memory for the full history if curious. Tonight's pass focused specifically
  on what a *remote* internet-facing test needed that wasn't addressed yet.

## 4. If something goes wrong
- **"Cannot reach the server" banner in-game**: the Server window probably
  closed or crashed. Check that window for an error, restart it if needed.
- **Friends suddenly can't connect / link stops working**: check the Tunnel
  window is still open and hasn't reprinted a new URL.
- **A friend forgot their password**: there's no recovery flow yet (prototype
  scope) — they'll need to pick a new username.
- The server survives most bad input and even a crashed WebSocket message
  without going down (this was deliberately stress-tested), but if the whole
  Server window does die, just re-run `start-playtest.bat`.

## 5. Safety nets now in place
- The project is now a **git repository** (`git log` in the project folder
  shows the history) — if a future change ever breaks something, it can be
  rolled back instead of lost.
- `data/backups/` has a timestamped copy of your save from before tonight's
  changes, just in case.
- A basic per-IP rate limit and a login/action token system were added since
  the game is now reachable by anyone with the link, not just on your own PC.
