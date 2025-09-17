const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
app.use(express.json({ limit: '10mb' })); // Aumenta o limite do corpo da requisição
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// --- FUNÇÃO HELPER: Roda um comando e retorna uma promessa ---
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

// --- ROTA PRINCIPAL DE PROCESSAMENTO ---
app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;

  if (!cenas || !outputFile || !AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(400).send({ error: 'Parâmetros faltando: cenas e outputFile são obrigatórios.' });
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos'); // Assumindo que o contêiner se chama 'videos'
  const tempDir = '/tmp';
  const downloadedFiles = [];

  try {
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS NECESSÁRIOS ---
    console.log('Baixando arquivos...');
    const allFilesToDownload = [];
    cenas.forEach(cena => {
      allFilesToDownload.push(cena.imagem);
      allFilesToDownload.push(cena.narracao);
    });
    if (musica) allFilesToDownload.push(musica);
    if (legenda) allFilesToDownload.push(legenda);

    for (const fileName of [...new Set(allFilesToDownload)]) { // Usa Set para evitar downloads duplicados
      const localPath = path.join(tempDir, fileName);
      await containerClient.getBlockBlobClient(fileName).downloadToFile(localPath);
      downloadedFiles.push(localPath);
      console.log(` - Baixado: ${fileName}`);
    }

    // --- PASSO 2: ANALISAR A DURAÇÃO DE CADA NARRAÇÃO COM FFPROBE ---
    console.log('Analisando duração dos áudios...');
    const sceneDurations = [];
    for (const cena of cenas) {
      const audioPath = path.join(tempDir, cena.narracao);
      const duration = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
      sceneDurations.push(parseFloat(duration));
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);
    }

    // --- PASSO 3: CONSTRUIR O COMANDO FFMEG COMPLEXO ---
    console.log('Construindo comando FFmpeg...');
    let filterComplex = "";
    let inputs = "";
    let streamIndex = 0;

    // Constrói os inputs de vídeo e áudio para cada cena
    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      const imagePath = path.join(tempDir, cena.imagem);
      const audioPath = path.join(tempDir, cena.narracao);
      
      inputs += `-loop 1 -t ${duration} -i "${imagePath}" `;
      inputs += `-i "${audioPath}" `;

      filterComplex += `[${streamIndex}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
      streamIndex++; // Vídeo
      filterComplex += `[${streamIndex}:a]anull[a${i}];`;
      streamIndex++; // Áudio
    }

    // Concatena todos os clipes de vídeo e áudio
    const concatVideoStreams = cenas.map((_, i) => `[v${i}]`).join('');
    const concatAudioStreams = cenas.map((_, i) => `[a${i}]`).join('');
    filterComplex += `${concatVideoStreams}concat=n=${cenas.length}:v=1:a=0[v_concat];`;
    filterComplex += `${concatAudioStreams}concat=n=${cenas.length}:v=0:a=1[a_narracao];`;

    let finalAudio = "[a_narracao]";
    // Adiciona a música de fundo se ela existir
    if (musica) {
      const musicPath = path.join(tempDir, musica);
      inputs += `-i "${musicPath}" `;
      filterComplex += `[${streamIndex}:a]volume=0.2[a_musica];`;
      filterComplex += `[a_narracao][a_musica]amix=inputs=2:duration=longest[a_mix];`;
      finalAudio = "[a_mix]";
    }

    let finalVideo = "[v_concat]";
    // Adiciona as legendas se elas existirem
    if (legenda) {
        const legendaPath = path.join(tempDir, legenda);
        filterComplex += `[v_concat]subtitles='${legendaPath}'[v_legendado];`;
        finalVideo = "[v_legendado]";
    }

    const outputPath = path.join(tempDir, outputFile);
    const command = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "${finalVideo}" -map "${finalAudio}" -c:v libx264 -c:a aac -pix_fmt yuv420p -y "${outputPath}"`;

    // --- PASSO 4: EXECUTAR O COMANDO FFMEG ---
    await runCommand(command);

    // --- PASSO 5: ENVIAR O VÍDEO FINAL ---
    console.log(`Enviando ${outputFile}...`);
    await containerClient.getBlockBlobClient(outputFile).uploadFile(outputPath);

    console.log('Processo de montagem finalizado com sucesso.');
    res.status(200).send({ message: "Vídeo montado com sucesso!", outputFile });

  } catch (error) {
    console.error('Erro geral no processo de montagem:', error.message);
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    // --- PASSO 6: LIMPAR ARQUIVOS TEMPORÁRIOS ---
    console.log('Limpando arquivos temporários...');
    for (const filePath of downloadedFiles) {
      await fs.unlink(filePath).catch(e => console.error(`Falha ao deletar ${filePath}: ${e.message}`));
    }
  }
});

app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
