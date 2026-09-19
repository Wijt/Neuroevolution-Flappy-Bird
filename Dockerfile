FROM node:24-alpine
WORKDIR /app
COPY package.json server.js index.html ./
COPY data ./data
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
