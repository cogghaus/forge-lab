FROM node:22-alpine
WORKDIR /app
COPY deploy/waker/package.json .
RUN npm install --omit=dev
COPY deploy/waker/waker.mjs .
CMD ["node", "waker.mjs"]
