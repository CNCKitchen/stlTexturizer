FROM nginx:stable-alpine

COPY index.html style.css logo.png /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
COPY textures/ /usr/share/nginx/html/textures/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
