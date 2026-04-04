FROM node:24-alpine AS base


FROM base AS developer
WORKDIR /app
RUN apk add shadow
CMD ["sh", "-c", \
    "groupmod -g $(stat -c '%u' /app) node; \
    usermod -u $(stat -c '%u' /app) -g $(stat -c '%u' /app) node; \
    su node -c 'npm install --loglevel=info; npm run dev'"]


FROM base AS builder

WORKDIR /app

COPY package*.json /app/
RUN npm install

COPY src /app/src
COPY vite.config.js /app/
RUN npm run build


FROM nginx:alpine AS executor

WORKDIR /app

COPY --from=builder /app/dist /app
COPY deploy/site.conf.template /etc/nginx/templates/default.conf.template

ENV SITE_ROOT=/app
