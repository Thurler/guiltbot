# GUILT Bot
---
Discord bot for posting speedrun streams on discord

# What it does
---
- Polls Twitch API every 5 minutes to check for streams
- Filters streams matching games list and tag from config file
- Posts links to the relevant streams on the config Discord channel
- Provides a `!live` discord command to poll for streams at any time 
- Provides a cooldown of 1 hour per Twitch user to avoid spam in case of streams going offline

# Running the bot
---
- You will need Node.js v6+
- You will need a Twitch application Client ID and a Discord Bot token.

Rename config.json.sample to config.json and fill it as needed, then run:
```
npm install
node app.js > app.log &
```
