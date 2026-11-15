# Ask Ruchi AI server

Ask Ruchi works without this server: it uses the offline planner, which ranks the app's own spots. Set this server up when you want real AI answers.

1. Create a free Cloudflare account, then run:
   ```
   cd server
   npm i -g wrangler
   wrangler login
   wrangler secret put ANTHROPIC_API_KEY      # paste your key from console.anthropic.com
   wrangler secret put RUCHI_KEY              # optional: any random string
   wrangler deploy
   ```
2. Wrangler prints a URL such as `https://ruchi-ai.<you>.workers.dev`.
3. In `src/config.js`, set `aiEndpoint` to that URL. If you set `RUCHI_KEY`, set `aiKey` to the same value.
4. Run `npm run sync` and rebuild the app in Android Studio.

The API key stays on Cloudflare and never ships inside the app. Every question uses API credit. Haiku is the cheapest model; set the `MODEL` variable to change it.
