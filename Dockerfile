# Usar uma imagem base oficial do Node.js
FROM node:18-slim

# Instalar o FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Preparar o diretório da aplicação
WORKDIR /usr/src/app

# Copiar a lista de compras e instalar
COPY package*.json ./
RUN npm install

# Copiar o resto do código
COPY . .

# Expor a porta que o nosso servidor vai usar
EXPOSE 80

# Comando para ligar o servidor
CMD [ "node", "index.js" ]
