console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
app.use(express.json({ limit: '10mb' }));
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// Configurações de segurança
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff'];
const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac'];
const ALLOWED_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass'];
const MAX_FILENAME_LENGTH = 200;

// Função segura para sanitizar nomes de arquivo
const sanitizeFileName = (fileName) => {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Nome de arquivo inválido');
  }
  
  // Remove caracteres perigosos e limita tamanho
  const sanitized = fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, MAX_FILENAME_LENGTH);
    
  if (sanitized.length === 0) {
    throw new Error('Nome de arquivo inválido após sanitização');
  }
  
  return sanitized;
};

// Função para validar extensão de arquivo
const validateFileExtension = (fileName, allowedExtensions) => {
  const ext = path.extname(fileName).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Extensão de arquivo não permitida: ${ext}`);
  }
};

// Função para criar path seguro
const createSafePath = (baseDir, fileName) => {
  const sanitizedName = sanitizeFileName(fileName);
  const safePath = path.resolve(baseDir, sanitizedName);
  
  // Verificar se o path está dentro do diretório permitido
  if (!safePath.startsWith(path.resolve(baseDir))) {
    throw new Error('Tentativa de path traversal detectada');
  }
  
  return safePath;
};

// Função segura para executar comandos
const runCommand = (command, args = []) => {
  return new Promise((resolve, reject) => {
    console.log(`Executando: ${command} ${args.join(' ')}`);
    
    const process = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        console.error('Erro no comando:', stderr);
        reject(new Error(`Comando falhou com código ${code}`));
      }
    });
    
    process.on('error', (error) => {
      reject(new Error(`Erro ao executar comando: ${error.message}`));
    });
  });
};

// Função para detectar dimensões da imagem
const getImageDimensions = async (imagePath) => {
  try {
    const output = await runCommand('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      imagePath
    ]);
    
    const info = JSON.parse(output);
    const videoStream = info.streams.find(stream => stream.codec_type === 'video');
    
    if (!videoStream) {
      throw new Error('Stream de vídeo não encontrado');
    }
    
    return {
      width: videoStream.width,
      height: videoStream.height,
      aspectRatio: videoStream.width / videoStream.height
    };
  } catch (error) {
    console.error('Erro ao obter dimensões da imagem:', error.message);
    // Fallback para formato padrão em caso de erro
    return { width: 1080, height: 1920, aspectRatio: 9/16 };
  }
};

// Função para determinar formato do vídeo baseado nas dimensões
const determineVideoFormat = (width, height) => {
  const aspectRatio = width / height;
  
  if (Math.abs(aspectRatio - (9/16)) < 0.1) {
    // Formato vertical (Stories/Shorts) - 9:16
    console.log('Formato detectado: Vertical (Shorts) - 1080x1920');
    return { width: 1080, height: 1920 };
  } else if (Math.abs(aspectRatio - (16/9)) < 0.1) {
    // Formato horizontal (YouTube padrão) - 16:9
    console.log('Formato detectado: Horizontal (Padrão) - 1920x1080');
    return { width: 1920, height: 1080 };
  } else if (Math.abs(aspectRatio - 1) < 0.1) {
    // Formato quadrado - 1:1
    console.log('Formato detectado: Quadrado - 1080x1080');
    return { width: 1080, height: 1080 };
  } else {
    // Para outros formatos, usar proporção mais próxima
    if (aspectRatio < 1) {
      console.log('Formato detectado: Vertical personalizado - adaptando para 1080x1920');
      return { width: 1080, height: 1920 };
    } else {
      console.log('Formato detectado: Horizontal personalizado - adaptando para 1920x1080');
      return { width: 1920, height: 1080 };
    }
  }
};

// Função para obter duração do áudio
const getAudioDuration = async (audioPath) => {
  const output = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath
  ]);
  return parseFloat(output);
};

app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;

  // Validações de entrada
  if (!cenas || !Array.isArray(cenas) || cenas.length === 0) {
    return res.status(400).send({ error: 'Parâmetro "cenas" deve ser um array não vazio' });
  }
  
  if (!outputFile || typeof outputFile !== 'string') {
    return res.status(400).send({ error: 'Parâmetro "outputFile" é obrigatório' });
  }
  
  if (!AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(500).send({ error: 'Configuração de storage não encontrada' });
  }

  // Validar estrutura das cenas
  for (let i = 0; i < cenas.length; i++) {
    const cena = cenas[i];
    if (!cena.imagem || !cena.narracao) {
      return res.status(400).send({ error: `Cena ${i + 1}: "imagem" e "narracao" são obrigatórios` });
    }
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = '/tmp';
  const downloadedFiles = new Set();
  const renamedFiles = new Set();

  try {
    // Validar extensões de arquivos
    console.log('Validando tipos de arquivos...');
    console.log('Cenas recebidas:', cenas.map(c => ({ imagem: c.imagem, narracao: c.narracao })));
    cenas.forEach((cena, index) => {
      try {
        console.log(`Validando cena ${index + 1} - imagem: ${cena.imagem}, narração: ${cena.narracao}`);
        validateFileExtension(cena.imagem, ALLOWED_IMAGE_EXTENSIONS);
        validateFileExtension(cena.narracao, ALLOWED_AUDIO_EXTENSIONS);
      } catch (error) {
        console.error(`Erro validação cena ${index + 1}:`, error.message);
        throw new Error(`Cena ${index + 1}: ${error.message}`);
      }
    });
    
    if (musica) {
      validateFileExtension(musica, ALLOWED_AUDIO_EXTENSIONS);
    }
    
    if (legenda) {
      validateFileExtension(legenda, ALLOWED_SUBTITLE_EXTENSIONS);
    }

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
      console.log(`Tentando baixar: ${fileName}`);
      const localPath = createSafePath(tempDir, fileName);
      console.log(`Path seguro criado: ${localPath}`);
      await containerClient.getBlockBlobClient(fileName).downloadToFile(localPath);
      downloadedFiles.add(localPath);
      console.log(` - Baixado com sucesso: ${fileName}`);
    }

    // --- PASSO 2: ANALISAR E RENOMEAR ---
    console.log('Analisando duração e renomeando arquivos...');
    const sceneDurations = [];
    for (const cena of cenas) {
      console.log(`Processando cena - imagem: ${cena.imagem}, narração: ${cena.narracao}`);
      
      const originalAudioPath = createSafePath(tempDir, cena.narracao);
      const newAudioPath = `${originalAudioPath}.mp3`;
      console.log(`Renomeando áudio: ${originalAudioPath} -> ${newAudioPath}`);
      await fs.rename(originalAudioPath, newAudioPath);
      renamedFiles.add(newAudioPath);
      
      console.log(`Obtendo duração do áudio: ${newAudioPath}`);
      const duration = await getAudioDuration(newAudioPath);
      sceneDurations.push(duration);
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);
      
      const originalImagePath = createSafePath(tempDir, cena.imagem);
      const newImagePath = `${originalImagePath}.jpg`;
      console.log(`Renomeando imagem: ${originalImagePath} -> ${newImagePath}`);
      await fs.rename(originalImagePath, newImagePath);
      renamedFiles.add(newImagePath);
    }

    // --- PASSO 2.5: DETECTAR RESOLUÇÃO AUTOMATICAMENTE ---
    console.log('Detectando resolução da primeira imagem...');
    const firstImagePath = createSafePath(tempDir, `${sanitizeFileName(cenas[0].imagem)}.jpg`);
    const dimensions = await getImageDimensions(firstImagePath);
    const videoFormat = determineVideoFormat(dimensions.width, dimensions.height);

    // --- PASSO 3: CONSTRUIR O COMANDO FFMPEG ---
    console.log('Construindo comando FFmpeg...');
    const ffmpegArgs = [];
    const filterComplexParts = [];
    let streamIndex = 0;

    // Adicionar inputs das cenas
    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      const imagePath = createSafePath(tempDir, `${sanitizeFileName(cena.imagem)}.jpg`);
      const audioPath = createSafePath(tempDir, `${sanitizeFileName(cena.narracao)}.mp3`);
      
      ffmpegArgs.push('-loop', '1', '-t', duration.toString(), '-i', imagePath);
      ffmpegArgs.push('-i', audioPath);

      // Ajuste para resolução detectada automaticamente
      filterComplexParts.push(`[${streamIndex}:v]scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
      streamIndex++;
      filterComplexParts.push(`[${streamIndex}:a]anull[a${i}]`);
      streamIndex++;
    }

    // Concatenar streams
    const concatVideoStreams = cenas.map((_, i) => `[v${i}]`).join('');
    const concatAudioStreams = cenas.map((_, i) => `[a${i}]`).join('');
    filterComplexParts.push(`${concatVideoStreams}concat=n=${cenas.length}:v=1:a=0[v_concat]`);
    filterComplexParts.push(`${concatAudioStreams}concat=n=${cenas.length}:v=0:a=1[a_narracao]`);

    let finalAudioMap = "[a_narracao]";
    if (musica) {
      const musicPath = createSafePath(tempDir, musica);
      ffmpegArgs.push('-stream_loop', '-1', '-i', musicPath);
      filterComplexParts.push(`[${streamIndex}:a]volume=0.2[a_musica]`);
      filterComplexParts.push(`[a_narracao][a_musica]amix=inputs=2:duration=first[a_mix]`);
      finalAudioMap = "[a_mix]";
      streamIndex++;
    }

    let finalVideoMap = "[v_concat]";
    if (legenda) {
        const legendaPath = createSafePath(tempDir, legenda);
        filterComplexParts.push(`[v_concat]subtitles='${legendaPath.replace(/'/g, "\\'")}':force_style='Fontsize=20'[v_legendado]`);
        finalVideoMap = "[v_legendado]";
    }

    const outputPath = createSafePath(tempDir, outputFile);
    const filterComplexString = filterComplexParts.join('; ');
    
    // Construir argumentos finais do FFmpeg
    ffmpegArgs.push(
      '-filter_complex', filterComplexString,
      '-map', finalVideoMap,
      '-map', finalAudioMap,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-y', outputPath
    );

    await runCommand('ffmpeg', ffmpegArgs);

    console.log(`Enviando ${outputFile}...`);
    await containerClient.getBlockBlobClient(sanitizeFileName(outputFile)).uploadFile(outputPath);
    downloadedFiles.add(outputPath);

    res.status(200).send({ 
      message: "Vídeo montado com sucesso!", 
      outputFile: sanitizeFileName(outputFile),
      resolution: `${videoFormat.width}x${videoFormat.height}`
    });

  } catch (error) {
    console.error('=== ERRO DETALHADO ===');
    console.error('Mensagem:', error.message);
    console.error('Stack:', error.stack);
    console.error('=== FIM DO ERRO ===');
    res.status(500).send({ 
      error: 'Erro interno no processamento do vídeo',
      details: error.message // Temporário para debug
    });
  } finally {
    console.log('Limpando arquivos temporários...');
    const allTempFiles = new Set([...downloadedFiles, ...renamedFiles]);
    for (const filePath of allTempFiles) {
      try {
        await fs.unlink(filePath);
      } catch (e) {
        // Silenciar erros de limpeza
      }
    }
  }
});

app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
