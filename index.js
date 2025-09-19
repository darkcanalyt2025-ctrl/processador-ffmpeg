console.log("--- index.js iniciado com sucesso ---");
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

// ... (código do servidor express continua igual) ...

const runCommand = (command) => { /* ... mesma função ... */ };

app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;
  // ... (verificação de parâmetros continua igual) ...

  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = '/tmp';
  const downloadedFiles = new Set(); // Usamos um Set para evitar duplicatas

  try {
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS ---
    console.log('Baixando arquivos...');
    const allFilesToDownload = [];
    cenas.forEach(cena => {
      allFilesToDownload.push(cena.imagem); // ex: 'imagem-0'
      allFilesToDownload.push(cena.narracao); // ex: 'narration- 0'
    });
    if (musica) allFilesToDownload.push(musica);
    if (legenda) allFilesToDownload.push(legenda);

    for (const fileName of [...new Set(allFilesToDownload)]) {
      const localPath = path.join(tempDir, fileName);
      await containerClient.getBlockBlobClient(fileName).downloadToFile(localPath);
      downloadedFiles.add(localPath);
      console.log(` - Baixado: ${fileName}`);
    }

    // --- PASSO 2: ANALISAR A DURAÇÃO ---
    console.log('Analisando duração dos áudios...');
    const sceneDurations = [];
    for (const cena of cenas) {
      // --- CORREÇÃO AQUI: Adicionamos a extensão .mp3 para o ffprobe ---
      const audioPath = path.join(tempDir, `${cena.narracao}.mp3`);
      // Renomeamos o arquivo baixado para incluir a extensão
      await fs.rename(path.join(tempDir, cena.narracao), audioPath);
      
      const duration = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
      sceneDurations.push(parseFloat(duration));
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);
    }

    // --- PASSO 3: CONSTRUIR O COMANDO FFMEG ---
    console.log('Construindo comando FFmpeg...');
    let filterComplex = "";
    let inputs = "";
    let streamIndex = 0;

    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      // --- CORREÇÃO AQUI: Adicionamos as extensões para o ffmpeg ---
      const imagePath = path.join(tempDir, `${cena.imagem}.jpg`);
      const audioPath = path.join(tempDir, `${cena.narracao}.mp3`);
      
      // Renomeamos a imagem também
      await fs.rename(path.join(tempDir, cena.imagem), imagePath).catch(e => {}); // Ignora erro se já foi renomeado

      inputs += `-loop 1 -t ${duration} -i "${imagePath}" `;
      inputs += `-i "${audioPath}" `;
      // ... (resto da construção do filterComplex continua igual) ...
    }
    // ... (resto do código para montar e executar o comando) ...

  } catch (error) {
    // ... (tratamento de erro) ...
  } finally {
    // ... (limpeza de arquivos) ...
  }
});

// ... (código do app.listen) ...
