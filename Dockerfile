FROM node:alpine

WORKDIR /usr/src/app
RUN npm install -g npm@11.7.0

COPY package*.json ./
# install dev deps so nodemon is available
RUN npm ci

COPY . .

# tools for dropping privileges at runtime
RUN apk add --no-cache su-exec \
  && mkdir -p /usr/src/app/assets/packs \
  && mkdir -p /usr/src/app/generated-packs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 7012
CMD ["npm","run","start:dev"]
