FROM node:20-slim

WORKDIR /app

# Install git (needed for baileys)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN npm install

COPY . .

CMD ["node", "bot.js"]
