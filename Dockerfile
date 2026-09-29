FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY logo.png /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
COPY textures/ /usr/share/nginx/html/textures/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 80
