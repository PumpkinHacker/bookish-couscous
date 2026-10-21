#!/usr/bin/env bash
# Run from this folder. Needs Node and a Cloudflare login (npx wrangler login).
set -e
(cd game && npx wrangler deploy)
echo "Now enter the admin password, then the admin code:"
(cd game && npx wrangler secret put ADMIN_PASSWORD && npx wrangler secret put ADMIN_CODE)
(cd admin && npx wrangler deploy)
echo "Done. Game: dream-world-2.<your-subdomain>.workers.dev   Admin: dream-world-2-admin.<your-subdomain>.workers.dev"
