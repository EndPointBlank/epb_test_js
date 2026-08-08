FROM node:20-slim

WORKDIR /app

# The SDK is consumed from the sibling checkout in local development. Copying
# package files first keeps the dependency layer cached across source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3003
EXPOSE 3003

CMD ["node", "src/app.js"]
