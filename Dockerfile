# Use an official Node.js runtime as a parent image
FROM node:18-bullseye

# Install OpenJDK (Java)
RUN apt-get update && apt-get install -y default-jdk

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the backend code
COPY . .

# Expose the port the app runs on
EXPOSE 5000

# Start the application
CMD ["node", "index.js"]
