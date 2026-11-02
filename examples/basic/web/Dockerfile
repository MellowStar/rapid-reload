# Copies only its own files, so changes elsewhere in the repo never rebuild this image.
FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
CMD ["node", "server.mjs"]
