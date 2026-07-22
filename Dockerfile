FROM node:20-slim

# Install ffmpeg from Debian's apt repo — a real, fully-linked binary
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of your bot's code
COPY . .

CMD ["node", "index.js"]