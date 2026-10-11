FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/deya.db PUBLIC_DIR=/app/web TRUST_PROXY=1
WORKDIR /app
COPY server/package.json server/
COPY server/src server/src
COPY web web
COPY scripts scripts
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
