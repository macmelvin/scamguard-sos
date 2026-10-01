FROM oven/bun:1
WORKDIR /app
COPY . .
CMD ["bun", "server.ts"]
