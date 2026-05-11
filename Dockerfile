FROM node:22-alpine

WORKDIR /app

COPY . .

RUN cd server && npm install --production

ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server/server.js"]
