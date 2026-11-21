FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
# Behind a reverse proxy (Fly.io, Railway, nginx, ...): set TRUST_PROXY_HOPS to the number of proxies in
# front of the app, e.g. `docker run -e TRUST_PROXY_HOPS=1 ...` or `fly secrets set TRUST_PROXY_HOPS=1`.
# Unset it is 0 (1 on Render). With 0 behind a proxy, the per-address limits see the proxy's address for
# every player: 20 connections in all.
# Also tunable: MAX_ROOMS (60), MAX_CONNECTIONS (500), MAX_PER_IP (20, or 40 behind a proxy). See README.
EXPOSE 8080
CMD ["node", "server.js"]
