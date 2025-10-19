FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
# install dev deps so nodemon is available
RUN npm ci
COPY . .
EXPOSE 7012
CMD ["npm","run","start:dev"]
