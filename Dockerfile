# aTorrent in server mode — the "run it like a seedbox" build.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so a code change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# Downloads and the resume list live on a mounted volume, not in the image.
ENV NODE_ENV=production \
    PORT=8080 \
    ATORRENT_DOWNLOAD_DIR=/data/downloads \
    ATORRENT_STATE_FILE=/data/torrents.json

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
# BitTorrent also wants inbound peer traffic on 6881; without it aTorrent can
# still reach peers it dials itself, just fewer of them.
EXPOSE 6881/tcp 6881/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
