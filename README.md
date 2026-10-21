# Dream World 2.0 - two Workers
- game/  -> dream-world-2        (game, accounts, shop, online rooms; Durable Objects with SQLite)
- admin/ -> dream-world-2-admin  (separate admin site; forwards only admin calls to the game)

Deploy: ./deploy.sh  (deploys game, asks for ADMIN_PASSWORD and ADMIN_CODE, deploys admin).
Your existing Workers (dreamworld, dreamworld-auth-api, ...) are not touched.
Admin = account "Admin" (player ID 1). Admin login needs the password AND the code.
Local: put ADMIN_PASSWORD / ADMIN_CODE in game/.dev.vars and run `npx wrangler dev` in game/.
