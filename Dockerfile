FROM node:18-alpine
WORKDIR /app

# Install deps first (cached only while package files are unchanged)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app. Copying the whole context (not just server.js)
# means any change to server.js busts this layer and lands in the image, so
# redeploys always ship the latest code instead of a stale cached copy.
COPY . .

# Render provides the port via $PORT; the app already reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
