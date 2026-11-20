# Legio Online
Original ancient-world real-time battles + turn-based campaign, online multiplayer.

Run locally: `npm install && npm start` then open http://localhost:3000

## Deploy
Needs a host that runs ONE always-on Node process (rooms live in memory; WebSockets must stay connected).
Works on Render (render.yaml), Railway, Fly.io (Dockerfile). Do not use serverless: players could land on different instances.
Render: push this folder to GitHub -> New > Blueprint -> pick the repo. Uses PORT from the host automatically.
Note: free tiers sleep when idle, and a restart drops all running games.
