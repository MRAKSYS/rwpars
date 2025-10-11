FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++ || true
COPY package*.json ./
RUN npm install --production
COPY . .
VOLUME ["/data"]
EXPOSE 80
ENV DATA_DIR=/data
CMD ["npm", "start"]
