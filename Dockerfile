# syntax=docker/dockerfile:1
FROM node:18-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

# --- PASSO DE VERIFICAÇÃO ADICIONADO ---
# Lista os módulos instalados para vermos no log de build
RUN echo "Verificando módulos instalados:" && ls -l node_modules

COPY . .

EXPOSE 80
CMD [ "node", "index.js" ]
