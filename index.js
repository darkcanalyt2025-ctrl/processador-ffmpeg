console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// --- FUNÇÕES AUXILIARES (sem alterações) ---

const runSafeCommand = (command, args, timeoutMs = 120000) => {
  return new Promise((resolve, reject) => {
    console.log(`Executando: ${command} ${args.join(' ')}`);
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Comando '${command}' timeout após ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error('Erro no comando:', stderr);
        return reject(new Error(stderr || `Comando '${command}' falhou com código ${code}`));
      }
      resolve(stdout.trim());
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Falha ao iniciar o comando:', err);
      reject(err);
    });
  });
};

const getImageDimensions = async (imagePath) => {
  try {
    const output = await runSafeCommand('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', imagePath], 15000);
    const [width, height] = output.split(',').map(Number);
    if (!width || !height) throw new Error('Dimensões inválidas detectadas');
    return { width, height, aspectRatio: width / height };
  } catch (error) {
    console.error('Erro ao obter dimensões da imagem:', error.message);
    console.warn('Usando dimensões padrão (1080x1920) devido a erro.');
    return { width: 1080, height: 1920, aspectRatio: 9/16 };
  }
};

const determineVideoFormat = (width, height) => {
  const aspectRatio = width / height;
  const ASPECT_RATIO_TOLERANCE = 0.1;
  if (Math.abs(aspectRatio - (9/16)) < ASPECT_RATIO_TOLERANCE) return { width: 1080, height: 1920 };
  if (Math.abs(aspectRatio - (16/9)) < ASPECT_RATIO_TOLERANCE) return { width: 1920, height: 1080 };
  if (Math.abs(aspectRatio - 1) < ASPECT_RATIO_TOLERANCE) return { width: 1080, height: 1080 };
  return aspectRatio < 1 ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
};

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
    const MAX_LINE_LENGTH = 45;
    for (const word of words) {
      if ((currentLine + " " + word).trim().length > MAX_LINE_LENGTH && currentLine.length > 0) {
        newLines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += (currentLine ? " " : "") + word;
      }
    }
    if (currentLine) newLines.push(currentLine.trim());
    let finalLines = newLines;
    if (newLines.length > 2) {
        const half = Math.ceil(newLines.length / 2);
        finalLines = [newLines.slice(0, half).join(" "), newLines.slice(half).join(" ")];
    } else if (newLines.length === 0) {
        finalLines = [""];
    }
    return [id, timecode, ...finalLines].join("\n");
  });
  await fs.writeFile(outputPath, sanitizedBlocks.join("\n\n"), "utf8");
}


// --- NOVA FUNÇÃO PARA PROCESSAMENTO EM SEGUNDO PLANO ---
async function processVideoInBackground(jobId, payload) {
  const { cenas, musica, legenda, outputFile } = payload;
  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = path.join('/tmp', jobId); // Usar jobId para isolar arquivos temporários
  await fs.mkdir(tempDir, { recursive: true });

  // O nome do arquivo de status será baseado no nome do arquivo de saída
  const statusFile = `${outputFile}.json`;

  try {
    const tempFileMap = new Map();
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS ---
    console.log(`[${jobId}] Baixando arquivos...`);
    const filesToProcess = [];
    cenas.forEach(c => {
      filesToProcess.push({ type: 'image', originalName: c.imagem });
      filesToProcess.push({ type: 'audio', originalName: c.narracao });
    });
    if (musica) filesToProcess.push({ type: 'music', originalName: musica });
    if (legenda) filesToProcess.push({ type: 'subtitle', originalName: legenda });

    await Promise.all(filesToProcess.map(async (fileInfo) => {
      const localPath = path.join(tempDir, `${crypto.randomUUID()}${path.extname(fileInfo.originalName)}`);
      tempFileMap.set(fileInfo.originalName, localPath);
      await containerClient.getBlockBlobClient(fileInfo.originalName).downloadToFile(localPath);
    }));

    // --- PASSO 2: ANALISAR DURAÇÕES E FORMATO ---
    console.log(`[${jobId}] Analisando arquivos...`);
    const sceneDurations = await Promise.all(cenas.map(c => runSafeCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempFileMap.get(c.narracao)]).then(parseFloat)));
    const dimensions = await getImageDimensions(tempFileMap.get(cenas[0].imagem));
    const videoFormat = determineVideoFormat(dimensions.width, dimensions.height);

    // --- PASSO 3: CRIAR CLIPES INDIVIDUAIS ---
    console.log(`[${jobId}] Etapa 1/3: Criando clipes individuais...`);
    const clipPaths = await Promise.all(cenas.map(async (cena, index) => {
      const clipOutputPath = path.join(tempDir, `clip_${index}.mp4`);
      await runSafeCommand('ffmpeg', ['-loop', '1', '-i', tempFileMap.get(cena.imagem), '-i', tempFileMap.get(cena.narracao), '-t', sceneDurations[index].toString(), '-vf', `scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`, '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', '-y', clipOutputPath], 180000);
      return clipOutputPath;
    }));

    // --- PASSO 4: CONCATENAR CLIPES ---
    console.log(`[${jobId}] Etapa 2/3: Concatenando clipes...`);
    const concatListPath = path.join(tempDir, 'concat_list.txt');
    await fs.writeFile(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));
    const concatenatedVideoPath = path.join(tempDir, 'concatenated.mp4');
    await runSafeCommand('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-y', concatenatedVideoPath], 60000);

    // --- PASSO 5: ADICIONAR MÚSICA E LEGENDAS ---
    console.log(`[${jobId}] Etapa 3/3: Adicionando extras...`);
    let finalVideoPath = concatenatedVideoPath;
    if (musica || legenda) {
        const finalOutputPath = path.join(tempDir, outputFile);
        let inputs = ['-i', concatenatedVideoPath];
        let filterComplex = [];
        let videoMap = '[0:v]', audioMap = '[0:a]';
        let streamIndex = 1;
        if (musica) {
            inputs.push('-i', tempFileMap.get(musica));
            filterComplex.push(`[${streamIndex}:a]volume=0.2[a_musica]`, `[${audioMap}][a_musica]amix=inputs=2:duration=first[a_out]`);
            audioMap = '[a_out]';
            streamIndex++;
        }
        if (legenda) {
            const sanitizedSrtPath = path.join(tempDir, 'subtitles.srt');
            await sanitizeSrt(tempFileMap.get(legenda), sanitizedSrtPath);
            const escapedSrtPath = sanitizedSrtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
            filterComplex.push(`${videoMap}subtitles='${escapedSrtPath}:force_style=Fontsize=28,MarginV=60,Alignment=2'[v_out]`);
            videoMap = '[v_out]';
        }
        await runSafeCommand('ffmpeg', [...inputs, '-filter_complex', filterComplex.join(';'), '-map', videoMap, '-map', audioMap, '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', finalOutputPath], 300000);
        finalVideoPath = finalOutputPath;
    } else {
        finalVideoPath = path.join(tempDir, outputFile);
        await fs.rename(concatenatedVideoPath, finalVideoPath);
    }

    // --- PASSO 6: UPLOAD FINAL E STATUS DE SUCESSO ---
    console.log(`[${jobId}] Enviando vídeo final para o Azure...`);
    await containerClient.getBlockBlobClient(outputFile).uploadFile(finalVideoPath);

    console.log(`[${jobId}] Processo concluído com sucesso. Criando arquivo de status.`);
    const successStatus = { status: 'completed', outputFile: outputFile, completedAt: new Date().toISOString() };
    await containerClient.getBlockBlobClient(statusFile).upload(JSON.stringify(successStatus), Buffer.byteLength(JSON.stringify(successStatus)));

  } catch (error) {
    console.error(`[${jobId}] Erro catastrófico no processamento do vídeo:`, error);
    const errorStatus = { status: 'failed', error: error.message, failedAt: new Date().toISOString() };
    await containerClient.getBlockBlobClient(statusFile).upload(JSON.stringify(errorStatus), Buffer.byteLength(JSON.stringify(errorStatus)));
  } finally {
    console.log(`[${jobId}] Limpando diretório temporário...`);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// --- ROTA PRINCIPAL DA API (MODIFICADA PARA SER ASSÍNCRONA) ---
app.post('/', (req, res) => {
  const { outputFile } = req.body;

  if (!req.body.cenas || !outputFile) {
    return res.status(400).send({ error: 'Payload inválido. "cenas" e "outputFile" são obrigatórios.' });
  }
  
  // Usaremos o nome do arquivo de saída (que deve ser único) como nosso Job ID
  const jobId = outputFile; 
  console.log(`Novo trabalho recebido. Job ID: ${jobId}`);

  // Dispara o processo em segundo plano SEM esperar (fire-and-forget)
  processVideoInBackground(jobId, req.body);

  // Responde imediatamente ao n8n, informando que o trabalho foi aceito
  res.status(202).send({ 
    message: "Processo de vídeo aceito e iniciado em segundo plano.",
    jobId: jobId,
    statusFile: `${jobId}.json` // Informa ao n8n qual arquivo monitorar
  });
});

// --- INICIA O SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
