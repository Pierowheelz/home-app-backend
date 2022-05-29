# syntax=docker/dockerfile:1
FROM node:16

# Create app directory
WORKDIR /home-app-backend

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3600
CMD [ "node", "index.js" ]
