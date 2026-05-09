FROM nginx:alpine

COPY . /usr/share/nginx/html

# Remove server version disclosure
RUN sed -i 's/^.*server_tokens.*$/    server_tokens off;/' /etc/nginx/nginx.conf

EXPOSE 80
