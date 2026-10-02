FROM node:22-bookworm-slim

WORKDIR /app

COPY backend/package.json ./backend/package.json
WORKDIR /app/backend
RUN npm install --omit=dev

WORKDIR /app
COPY . .

WORKDIR /app/backend
ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["npm","start"]
