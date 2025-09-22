console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

// --- LINHAS QUE FALTAVAM - INÍCIO ---
const app = express();
app.use(express.json({ limit: '10mb' }));
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
// --- LINHAS QUE FALTAVAM - FIM ---

// Função helper para rodar comandos
const runCommand = (command) => {
  return new Promise((resolve, reject) => {
    console.log(`Executando: ${command}`);
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Erro no comando:', stderr);
        return reject(new Error(stderr));
      }
      resolve(stdout.trim());
    });
  });
};

// Rota principal de processamento
app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;

  if (!cenas || !cenas.length || !outputFile || !AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(400).send({ error: 'Parâmetros faltando: cenas (não pode ser vazia) e outputFile são obrigatórios.' });
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = '/tmp';
  const downloadedFiles = new Set();
  const renamedFiles = new Set();

  try {
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS ---
    console.log('Baixando arquivos...');
    const allFilesToDownload = new Set();
    cenas.forEach(cena => {
      allFilesToDownload.add(cena.imagem);
      allFilesToDownload.add(cena.narracao);
    });
    if (musica) allFilesToDownload.add(musica);
    if (legenda) allFilesToDownload.add(legenda);

    for (const fileName of allFilesToDownload) {
      const localPath = path.join(tempDir, fileName);
      await containerClient.getBlockBlobClient(fileName).downloadToFile(localPath);
      downloadedFiles.add(localPath);
      console.log(` - Baixado: ${fileName}`);
    }

    // --- PASSO 2: ANALISAR A DURAÇÃO ---
    console.log('Analisando duração dos áudios...');
    const sceneDurations = [];
    for (const cena of cenas) {
      const originalAudioPath = path.join(tempDir, cena.narracao);
      const newAudioPath = `${originalAudioPath}.mp3`;
      await fs.rename(originalAudioPath, newAudioPath);
      renamedFiles.add(newAudioPath);
      
      const duration = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${newAudioPath}"`);
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
      const originalImagePath = path.join(tempDir, cena.imagem);
      const newImagePath = `${originalImagePath}.jpg`;
      await fs.rename(originalImagePath, newImagePath);
      renamedFiles.add(newImagePath);
      
      const audioPath = path.join(tempDir, `${cena.narracao}.mp3`);

      inputs += `-loop 1 -t ${duration} -i "${newImagePath}" `;
      inputs += `-i "${audioPath}" `;

      filterComplex += `[${streamIndex}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
      streamIndex++;
      filterComplex += `[${streamIndex}:a]anull[a${i}];`;
      streamIndex++;
    }

    const concatVideoStreams = cenas.map((_, i) => `[v${i}]`).join('');
    const concatAudioStreams = cenas.map((_, i) => `[a${i}]`).join('');
    filterComplex += `${concatVideoStreams}concat=n=${cenas.length}:v=1:a=0[v_concat];`;
    filterComplex += `${concatAudioStreams}concat=n=${cenas.length}:v=0:a=1[a_narracao];`;

    let finalAudio = "[a_narracao]";
    if (musica) {
      const musicPath = path.join(tempDir, musica);
      inputs += `-i "${musicPath}" `;
      filterComplex += `[${streamIndex}:a]volume=0.2[a_musica];`;
      filterComplex += `[a_narracao][a_musica]amix=inputs=2:duration=longest[a_mix];`;
      finalAudio = "[a_mix]";
    }

    let finalVideo = "[v_concat]";
    if (legenda) {
        const legendaPath = path.join(tempDir, legenda);
        filterComplex += `[v_concat]subtitles='${legendaPath}'[v_legendado];`;
        finalVideo = "[v_legendado]";
    }

    const outputPath = path.join(tempDir, outputFile);
    const command = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "${finalVideo}" -map "${finalAudio}" -c:v libx264 -c:a aac -pix_fmt yuv420p -y "${outputPath}"`;
    
    // --- PASSO 4: EXECUTAR ---
    await runCommand(command);

    // --- PASSO 5: ENVIAR ---
    console.log(`Enviando ${outputFile}...`);
    await containerClient.getBlockBlobClient(outputFile).uploadFile(outputPath);
    downloadedFiles.add(outputPath);

    res.status(200).send({ message: "Vídeo montado com sucesso!", outputFile });

  } catch (error) {
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    // --- PASSO 6: LIMPAR ---
    console.log('Limpando arquivos temporários...');
    const allTempFiles = new Set([...downloadedFiles, ...renamedFiles]);
    for (const filePath of allTempFiles) {
      await fs.unlink(filePath).catch(e => {});
    }
  }
});

// --- LINHA QUE FALTAVA ---
app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
