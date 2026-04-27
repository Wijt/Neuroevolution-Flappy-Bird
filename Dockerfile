FROM nginx:alpine

# This project is a plain static site (index.html + data/ assets), so no build step is required.
WORKDIR /usr/share/nginx/html

# Copy only the assets the game needs (keeps image lean and avoids path issues).
COPY index.html ./
COPY data/ ./data/

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
