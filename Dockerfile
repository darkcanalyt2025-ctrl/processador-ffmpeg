FROM mcr.microsoft.com/azure-functions/node:4-node18
WORKDIR /home/site/wwwroot
RUN apt-get update && apt-get install -y ffmpeg
COPY package.json .
RUN npm install
COPY . .
