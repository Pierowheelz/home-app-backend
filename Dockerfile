# syntax=docker/dockerfile:1
FROM node:16

# Create app directory
WORKDIR /nodejs

COPY package.json .

RUN npm install --production

COPY . .

EXPOSE 3600
CMD [ "node", "index.js" ]
