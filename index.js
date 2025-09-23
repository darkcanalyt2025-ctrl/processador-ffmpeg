console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
app.use(express.json({ limit: '10mb' }));
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

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

// Função para detectar dimensões da imagem
const getImageDimensions = async (imagePath) => {
  try {
    const output = await runCommand(`ffprobe -v quiet -print_format json -show_streams "${imagePath}"`);
    const info = JSON.parse(output);
    const videoStream = info.streams.find(stream => stream.codec_type === 'video');
    return {
      width: videoStream.width,
      height: videoStream.height,
      aspectRatio: videoStream.width / videoStream.height
    };
  } catch (error) {
    console.error('Erro ao obter dimensões da imagem:', error);
    return { width: 1080, height: 1920, aspectRatio: 9/16 };
  }
};

// Função para determinar formato do vídeo baseado nas dimensões
const determineVideoFormat = (width, height) => {
  const aspectRatio = width / height;

  if (Math.abs(aspectRatio - (9/16)) < 0.1) {
    console.log('Formato detectado: Vertical (Shorts) - 1080x1920');
    return { width: 1080, height: 1920 };
  } else if (Math.abs(aspectRatio - (16/9)) < 0.1) {
    console.log('Formato detectado: Horizontal (Padrão) - 1920x1080');
    return { width: 1920, height: 1080 };
  } else if (Math.abs(aspectRatio - 1) < 0.1) {
    console.log('Formato detectado: Quadrado - 1080x1080');
    return { width: 1080, height: 1080 };
  } else {
    if (aspectRatio < 1) {
      console.log('Formato detectado: Vertical personalizado - adaptando para 1080x1920');
      return { width: 1080, height: 1920 };
    } else {
      console.log('Formato detectado: Horizontal personalizado - adaptando para 1920x1080');
      return { width: 1920, height: 1080 };
    }
  }
};

// Função para ajustar legendas para no máximo 2 linhas
async function sanitizeSrt(inputPath, outputPath) {
  const content = await fs.readFile(inputPath, "utf8");
  const blocks = content.split(/\n\n/);

  const sanitizedBlocks = blocks.map(block => {
    const lines = block.split("\n");
    if (lines.length < 3) return block;

    const [id, timecode, ...textLines] = lines;
    let text = textLines.join(" ").replace(/\s+/g, " ").trim();

    const words = text.split(" ");
    const newLines = [];
    let currentLine = "";

    for (const word of words) {
      if ((currentLine + " " + word).trim().length > 40) {
        newLines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += " " + word;
      }
    }
    if (currentLine) newLines.push(currentLine.trim());

    // Garante no máximo 2 linhas
    const limitedLines = newLines.length > 2
      ? [
          newLines.slice(0, Math.ceil(newLines.length / 2)).join(" "),
          newLines.slice(Math.ceil(newLines.length / 2)).join(" ")
        ]
      : newLines;

    return [id, timecode, ...limitedLines].join("\n");
  });

  await fs.writeFile(outputPath, sanitizedBlocks.join("\n\n"), "utf8");
}

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
    // --- PASSO 1: BAIXAR ---
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

    // --- PASSO 2: ANALISAR E RENOMEAR ---
    console.log('Analisando duração e renomeando arquivos...');
    const sceneDurations = [];
    for (const cena of cenas) {
      const originalAudioPath = path.join(tempDir, cena.narracao);
      const newAudioPath = `${originalAudioPath}.mp3`;
      await fs.rename(originalAudioPath, newAudioPath);
      renamedFiles.add(newAudioPath);

      const duration = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${newAudioPath}"`);
      sceneDurations.push(parseFloat(duration));
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);

      const originalImagePath = path.join(tempDir, cena.imagem);
      const newImagePath = `${originalImagePath}.jpg`;
      await fs.rename(originalImagePath, newImagePath);
      renamedFiles.add(newImagePath);
    }

    // --- PASSO 2.5: DETECTAR RESOLUÇÃO AUTOMATICAMENTE ---
    console.log('Detectando resolução da primeira imagem...');
    const firstImagePath = path.join(tempDir, `${cenas[0].imagem}.jpg`);
    const dimensions = await getImageDimensions(firstImagePath);
    const videoFormat = determineVideoFormat(dimensions.width, dimensions.height);

    // --- PASSO 3: CONSTRUIR O COMANDO FFMEG ---
    console.log('Construindo comando FFmpeg...');
    let inputs = "";
    let filterComplexParts = [];
    let streamIndex = 0;

    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      const imagePath = path.join(tempDir, `${cena.imagem}.jpg`);
      const audioPath = path.join(tempDir, `${cena.narracao}.mp3`);

      inputs += `-loop 1 -t ${duration} -i "${imagePath}" `;
      inputs += `-i "${audioPath}" `;

      filterComplexParts.push(
        `[${streamIndex}:v]scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,` +
        `pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      );
      streamIndex++;
      filterComplexParts.push(`[${streamIndex}:a]anull[a${i}]`);
      streamIndex++;
    }

    // Concatenação corrigida (vídeo + áudio juntos)
    const concatParts = cenas.map((_, i) => `[v${i}][a${i}]`).join('');
    filterComplexParts.push(`${concatParts}concat=n=${cenas.length}:v=1:a=1[v_concat][a_narracao]`);

    let finalAudioMap = "[a_narracao]";
    if (musica) {
      const musicPath = path.join(tempDir, musica);
      inputs += `-stream_loop -1 -i "${musicPath}" `;
      filterComplexParts.push(`[${streamIndex}:a]volume=0.2[a_musica]`);
      filterComplexParts.push(`[a_narracao][a_musica]amix=inputs=2:duration=first[a_mix]`);
      finalAudioMap = "[a_mix]";
      streamIndex++;
    }

    let finalVideoMap = "[v_concat]";
    if (legenda) {
      const legendaPath = path.join(tempDir, legenda);
      const legendaSanitizedPath = path.join(tempDir, "legendas_formatadas.srt");

      // Ajusta o arquivo para nunca passar de 2 linhas
      await sanitizeSrt(legendaPath, legendaSanitizedPath);

      filterComplexParts.push(
        `[v_concat]subtitles='${legendaSanitizedPath}:force_style=Fontsize=28,MarginV=60,Alignment=2'[v_legendado]`
      );
      finalVideoMap = "[v_legendado]";
    }

    const outputPath = path.join(tempDir, outputFile);
    const filterComplexString = filterComplexParts.join('; ');
    const command = `ffmpeg ${inputs} -filter_complex "${filterComplexString}" -map "${finalVideoMap}" -map "${finalAudioMap}" -c:v libx264 -c:a aac -pix_fmt yuv420p -y "${outputPath}"`;

    await runCommand(command);

    console.log(`Enviando ${outputFile}...`);
    await containerClient.getBlockBlobClient(outputFile).uploadFile(outputPath);
    downloadedFiles.add(outputPath);

    res.status(200).send({ message: "Vídeo montado com sucesso!", outputFile });

  } catch (error) {
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    console.log('Limpando arquivos temporários...');
    const allTempFiles = new Set([...downloadedFiles, ...renamedFiles]);
    for (const filePath of allTempFiles) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
});

app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
